import { eq, and, inArray } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, documents, agentConfigs } from '../db/schema/index.js';
import { AGENT_TYPES } from '../queues/queues.js';
import { buildSystemPrompt as masterSystemPrompt, buildUserPrompt as masterUserPrompt } from '../prompts/master-agent.prompt.js';
import { buildSystemPrompt as discoverySystemPrompt, buildUserPrompt as discoveryUserPrompt } from '../prompts/discovery.prompt.js';
import logger from '../utils/logger.js';

export class MasterAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'discovery' });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId, mission } = input as { masterAgentId: string; mission?: string };

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

    const requirements = await this.extractJSON<Record<string, unknown>>(requirementsMessages);

    // 4. Save parsed requirements to masterAgent.config
    await withTenant(this.tenantId, async (tx) => {
      await tx
        .update(masterAgents)
        .set({ config: { ...((agent.config as Record<string, unknown>) ?? {}), ...requirements }, updatedAt: new Date() })
        .where(eq(masterAgents.id, masterAgentId));
    });

    // 5. Generate search queries using Together AI
    const queryMessages = [
      { role: 'system' as const, content: discoverySystemPrompt() },
      {
        role: 'user' as const,
        content: discoveryUserPrompt({
          targetRoles: (requirements.targetRoles as string[]) ?? [],
          requiredSkills: (requirements.requiredSkills as string[]) ?? [],
          locations: (requirements.locations as string[]) ?? [],
          industries: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[]) ?? [],
          keywords: ((requirements.searchCriteria as Record<string, unknown>)?.keywords as string[]) ?? [],
        }),
      },
    ];

    const queryResult = await this.extractJSON<{ queries: string[] }>(queryMessages);
    const queries = queryResult.queries ?? [];

    // 6. Upsert agentConfigs for each agent type
    await withTenant(this.tenantId, async (tx) => {
      for (const agentType of AGENT_TYPES) {
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

    // 7. Dispatch one discovery job per query, staggered
    const dispatchedJobIds: string[] = [];
    for (let i = 0; i < queries.length; i++) {
      const jobId = await this.dispatchNext(
        'discovery',
        {
          searchQueries: [queries[i]!],
          maxResults: 10,
          masterAgentId,
        },
        { delay: i * 2000 },
      );
      dispatchedJobIds.push(jobId);
    }

    await this.emitEvent('master:started', {
      masterAgentId,
      queryCount: queries.length,
      jobIds: dispatchedJobIds,
    });

    logger.info({ tenantId: this.tenantId, masterAgentId, queryCount: queries.length }, 'MasterAgent dispatched discovery jobs');

    return {
      parsedRequirements: requirements,
      queryCount: queries.length,
      dispatchedJobIds,
    };
  }
}
