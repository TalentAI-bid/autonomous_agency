import { eq, and, inArray } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, documents, agentConfigs, campaigns, campaignSteps } from '../db/schema/index.js';
import { AGENT_TYPES } from '../queues/queues.js';
import { buildSystemPrompt as masterSystemPrompt, buildUserPrompt as masterUserPrompt } from '../prompts/master-agent.prompt.js';
import { buildSystemPrompt as discoverySystemPrompt, buildUserPrompt as discoveryUserPrompt } from '../prompts/discovery.prompt.js';
import logger from '../utils/logger.js';

export class MasterAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'discovery' });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId, mission, dryRun: inputDryRun } = input as { masterAgentId: string; mission?: string; dryRun?: boolean };

    logger.info({ tenantId: this.tenantId, masterAgentId }, 'MasterAgent starting');

    // 1. Load job spec / spec documents for this master agent
    const docs = await withTenant(this.tenantId, async (tx) => {
      return tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.masterAgentId, masterAgentId),
            eq(documents.tenantId, this.tenantId),
            inArray(documents.type, ['job_spec', 'spec']),
          ),
        );
    });

    const docTexts = docs
      .filter((d) => d.rawText)
      .map((d) => ({ type: d.type, rawText: d.rawText! }));

    // 2. Load masterAgent record
    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx
        .select()
        .from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!agent) throw new Error(`MasterAgent ${masterAgentId} not found`);

    const agentConfig = (agent.config as Record<string, unknown>) ?? {};
    const dryRun = inputDryRun ?? (agentConfig.dryRun as boolean) ?? false;

    // Read enabled agents from config (null = all agents, for backwards compat)
    const enabledAgents = (agentConfig.enabledAgents as string[]) ?? null;
    const hasDiscovery = !enabledAgents || enabledAgents.includes('discovery');

    let requirements: Record<string, unknown> = {};
    let campaignId: string | undefined;
    let queries: string[] = [];
    const dispatchedJobIds: string[] = [];

    if (hasDiscovery) {
      // 3. Parse requirements using Together AI
      const requirementsMessages = [
        { role: 'system' as const, content: masterSystemPrompt() },
        {
          role: 'user' as const,
          content: masterUserPrompt({
            mission: (mission as string) ?? agent.mission ?? '',
            documents: docTexts,
            useCase: agent.useCase,
          }),
        },
      ];

      requirements = await this.extractJSON<Record<string, unknown>>(requirementsMessages);

      // 3b. Merge explicit config values (override LLM extraction)
      if (Array.isArray(agentConfig.locations) && (agentConfig.locations as string[]).length > 0) {
        requirements.locations = agentConfig.locations;
      }
      if (Array.isArray(agentConfig.requiredSkills) && (agentConfig.requiredSkills as string[]).length > 0) {
        requirements.requiredSkills = agentConfig.requiredSkills;
      }

      // 4. Auto-create campaign for email tracking + save parsed requirements to masterAgent.config
      campaignId = await withTenant(this.tenantId, async (tx) => {
        const [campaign] = await tx.insert(campaigns).values({
          tenantId: this.tenantId,
          masterAgentId,
          name: `Auto: ${agent.name}`,
          type: 'email',
          status: 'active',
        }).returning();

        // Create 3 campaign steps: initial, 3-day follow-up, 7-day follow-up
        await tx.insert(campaignSteps).values([
          { campaignId: campaign!.id, stepNumber: 1, subject: 'Initial outreach', delayDays: 0, channel: 'email' as const },
          { campaignId: campaign!.id, stepNumber: 2, subject: 'Follow-up', delayDays: 3, channel: 'email' as const },
          { campaignId: campaign!.id, stepNumber: 3, subject: 'Final follow-up', delayDays: 7, channel: 'email' as const },
        ]);

        // Save requirements + campaignId into config
        await tx
          .update(masterAgents)
          .set({
            config: { ...((agent.config as Record<string, unknown>) ?? {}), ...requirements, campaignId: campaign!.id },
            updatedAt: new Date(),
          })
          .where(eq(masterAgents.id, masterAgentId));

        return campaign!.id;
      });

      logger.info({ tenantId: this.tenantId, masterAgentId, campaignId }, 'MasterAgent auto-created campaign');

      // 5. Generate search queries using Together AI
      const queryMessages = [
        { role: 'system' as const, content: discoverySystemPrompt(agent.useCase) },
        {
          role: 'user' as const,
          content: discoveryUserPrompt({
            targetRoles: (requirements.targetRoles as string[]) ?? [],
            requiredSkills: (requirements.requiredSkills as string[]) ?? [],
            locations: (requirements.locations as string[]) ?? [],
            industries: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[]) ?? [],
            keywords: ((requirements.searchCriteria as Record<string, unknown>)?.keywords as string[]) ?? [],
            useCase: agent.useCase,
          }),
        },
      ];

      const queryResult = await this.extractJSON<{ queries: string[] }>(queryMessages);
      queries = queryResult.queries ?? [];
    } else {
      logger.info({ tenantId: this.tenantId, masterAgentId, enabledAgents }, 'MasterAgent skipping discovery — not in pipeline');
    }

    // 6. Upsert agentConfigs — only for enabled agents (or all if no pipeline)
    const agentTypesToCreate = enabledAgents
      ? AGENT_TYPES.filter(t => enabledAgents.includes(t))
      : AGENT_TYPES;

    await withTenant(this.tenantId, async (tx) => {
      for (const agentType of agentTypesToCreate) {
        const existing = await tx
          .select()
          .from(agentConfigs)
          .where(
            and(
              eq(agentConfigs.masterAgentId, masterAgentId),
              eq(agentConfigs.agentType, agentType),
              eq(agentConfigs.tenantId, this.tenantId),
            ),
          )
          .limit(1);

        if (existing.length === 0) {
          await tx.insert(agentConfigs).values({
            tenantId: this.tenantId,
            masterAgentId,
            agentType,
            parameters: requirements as Record<string, unknown>,
            isEnabled: true,
          });
        } else {
          await tx
            .update(agentConfigs)
            .set({ parameters: requirements as Record<string, unknown>, updatedAt: new Date() })
            .where(eq(agentConfigs.id, existing[0]!.id));
        }
      }
    });

    // 7. Dispatch one discovery job per query, staggered (only if discovery is enabled)
    if (hasDiscovery) {
      for (let i = 0; i < queries.length; i++) {
        const jobId = await this.dispatchNext(
          'discovery',
          {
            searchQueries: [queries[i]!],
            maxResults: 10,
            masterAgentId,
            useCase: agent.useCase,
            dryRun: dryRun || undefined,
          },
          { delay: i * 2000 },
        );
        dispatchedJobIds.push(jobId);
      }
    }

    await this.emitEvent('master:started', {
      masterAgentId,
      queryCount: queries.length,
      jobIds: dispatchedJobIds,
      enabledAgents: enabledAgents ?? 'all',
    });

    logger.info({ tenantId: this.tenantId, masterAgentId, queryCount: queries.length, enabledAgents }, 'MasterAgent dispatched discovery jobs');

    return {
      parsedRequirements: requirements,
      queryCount: queries.length,
      dispatchedJobIds,
      enabledAgents: enabledAgents ?? 'all',
    };
  }
}
