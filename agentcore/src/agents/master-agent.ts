import { eq, and, inArray, sql, count, lt, isNotNull } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, documents, agentConfigs, campaigns, campaignSteps, contacts, companies, agentTasks } from '../db/schema/index.js';
import { AGENT_TYPES } from '../queues/queues.js';
import { buildSystemPrompt as masterSystemPrompt, buildUserPrompt as masterUserPrompt } from '../prompts/master-agent.prompt.js';
import { buildSystemPrompt as discoverySystemPrompt, buildUserPrompt as discoveryUserPrompt } from '../prompts/discovery.prompt.js';
import type { PipelineContext, SalesStrategy } from '../types/pipeline-context.js';
import logger from '../utils/logger.js';

export class MasterAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'discovery' });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId, mission, dryRun: inputDryRun } = input as { masterAgentId: string; mission?: string; dryRun?: boolean };

    logger.info({ tenantId: this.tenantId, masterAgentId }, 'MasterAgent starting');
    await this.setCurrentAction('master_orchestration', 'Parsing mission and generating queries');

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
    let pipelineContext: PipelineContext | undefined;

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

      requirements = await this.trackAction('requirements_parsed', agent.mission ?? 'mission', () =>
        this.extractJSON<Record<string, unknown>>(requirementsMessages),
      );

      this.sendMessage(null, 'task_assignment', {
        action: 'parsed_requirements',
        queries: (requirements.targetRoles as string[]) ?? [],
        targetRoles: (requirements.targetRoles as string[]) ?? [],
        requiredSkills: (requirements.requiredSkills as string[]) ?? [],
        locations: (requirements.locations as string[]) ?? [],
      });

      // 3b. Merge explicit config values (override LLM extraction)
      if (Array.isArray(agentConfig.locations) && (agentConfig.locations as string[]).length > 0) {
        requirements.locations = agentConfig.locations;
      }
      if (Array.isArray(agentConfig.requiredSkills) && (agentConfig.requiredSkills as string[]).length > 0) {
        requirements.requiredSkills = agentConfig.requiredSkills;
      }

      // 3c. Build PipelineContext from requirements + agent config
      const isSales = agent.useCase === 'sales';
      pipelineContext = {
        useCase: agent.useCase as 'sales' | 'recruitment',
        masterAgentId,
        tenantId: this.tenantId,
        targetRoles: (requirements.targetRoles as string[]) ?? [],
        locations: (requirements.locations as string[]) ?? [],
        scoringThreshold: isSales ? 50 : 70,
        emailTone: (agentConfig.emailTone as string) ?? undefined,
        emailRules: (agentConfig.emailRules as string[]) ?? undefined,
        senderCompanyName: (agentConfig.senderCompanyName as string) ?? undefined,
        senderFirstName: (agentConfig.senderFirstName as string) ?? undefined,
        senderTitle: (agentConfig.senderTitle as string) ?? undefined,
        scoringWeights: (agentConfig.scoringWeights as Record<string, number>) ?? undefined,
        ...(isSales ? {
          sales: {
            industries: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[]) ?? [],
            companySizes: (agentConfig.companySizes as string[]) ?? undefined,
            techStack: (requirements.requiredSkills as string[]) ?? [],
            services: (agentConfig.services as string[]) ?? undefined,
            caseStudies: (agentConfig.caseStudies as Array<{ title: string; result: string }>) ?? undefined,
            differentiators: (agentConfig.differentiators as string[]) ?? undefined,
            valueProposition: (agentConfig.valueProposition as string) ?? undefined,
            callToAction: (agentConfig.callToAction as string) ?? undefined,
            calendlyUrl: (agentConfig.calendlyUrl as string) ?? undefined,
          },
        } : {
          recruitment: {
            requiredSkills: (requirements.requiredSkills as string[]) ?? [],
            preferredSkills: (requirements.preferredSkills as string[]) ?? [],
            minExperience: (requirements.minExperience as number) ?? 0,
            experienceLevel: (requirements.experienceLevel as string) ?? undefined,
            companyContext: (agentConfig.companyContext as string) ?? undefined,
          },
        }),
      };

      // 3d. For sales, run strategist INLINE so its search queries feed discovery
      if (isSales && pipelineContext.sales) {
        try {
          const { StrategistAgent } = await import('./strategist.agent.js');
          const strategist = new StrategistAgent({ tenantId: this.tenantId, masterAgentId });

          // Run with 60s timeout; fall back to fire-and-forget if it takes too long
          const strategyPromise = strategist.execute({ job: 'initialStrategy', masterAgentId, pipelineContext });
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 60000));
          const strategyResult = await Promise.race([strategyPromise, timeoutPromise]);

          await strategist.close();

          if (strategyResult && strategyResult.strategy) {
            const strategy = strategyResult.strategy as SalesStrategy;
            pipelineContext.sales!.salesStrategy = strategy;
            logger.info({ masterAgentId, queryCount: strategy.opportunitySearchQueries?.length ?? 0 }, 'StrategistAgent initial strategy completed (inline)');
          } else {
            logger.warn({ masterAgentId }, 'Strategist timed out — falling back to fire-and-forget');
            await this.dispatchNext('strategist', {
              job: 'initialStrategy',
              masterAgentId,
              pipelineContext,
            });
          }
        } catch (err) {
          logger.warn({ err, masterAgentId }, 'Failed to run strategist inline, dispatching fire-and-forget');
          try {
            await this.dispatchNext('strategist', {
              job: 'initialStrategy',
              masterAgentId,
              pipelineContext,
            });
          } catch (dispatchErr) {
            logger.warn({ err: dispatchErr, masterAgentId }, 'Failed to dispatch strategist fallback');
          }
        }
      }

      // 4. Auto-create campaign (or reuse existing) + save all config in one write
      campaignId = await withTenant(this.tenantId, async (tx) => {
        // Check for existing active campaign
        const [existing] = await tx.select().from(campaigns)
          .where(and(
            eq(campaigns.masterAgentId, masterAgentId),
            eq(campaigns.tenantId, this.tenantId),
            eq(campaigns.status, 'active'),
          ))
          .limit(1);

        let cid: string;
        if (existing) {
          cid = existing.id;
          logger.info({ masterAgentId, campaignId: cid }, 'Reusing existing campaign');
        } else {
          const [newCampaign] = await tx.insert(campaigns).values({
            tenantId: this.tenantId,
            masterAgentId,
            name: `Auto: ${agent.name}`,
            type: 'email',
            status: 'active',
          }).returning();
          cid = newCampaign!.id;

          await tx.insert(campaignSteps).values([
            { campaignId: cid, stepNumber: 1, subject: 'Initial outreach', delayDays: 0, channel: 'email' as const },
            { campaignId: cid, stepNumber: 2, subject: 'Follow-up', delayDays: 3, channel: 'email' as const },
            { campaignId: cid, stepNumber: 3, subject: 'Final follow-up', delayDays: 7, channel: 'email' as const },
          ]);
        }

        // SINGLE combined config save — all data in one write
        await tx
          .update(masterAgents)
          .set({
            config: { ...agentConfig, ...requirements, campaignId: cid, pipelineContext },
            updatedAt: new Date(),
          })
          .where(eq(masterAgents.id, masterAgentId));

        return cid;
      });

      logger.info({ tenantId: this.tenantId, masterAgentId, campaignId }, 'MasterAgent auto-created campaign');

      // Update pipelineContext with campaignId
      if (pipelineContext) pipelineContext.campaignId = campaignId;

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

      const queryResult = await this.trackAction('queries_generated', 'Generating search queries', () =>
        this.extractJSON<{ queries: string[] }>(queryMessages),
      );
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

    // 7. Dispatch discovery jobs in staggered batches of 5 (5-min gaps between batches)
    if (hasDiscovery) {
      let jobIndex = 0;

      // Helper: batch delay = batchIndex * 5 min + withinBatch * 2s
      const getBatchDelay = (i: number) => {
        const batchIndex = Math.floor(i / 5);
        const withinBatch = i % 5;
        return batchIndex * 300000 + withinBatch * 2000;
      };

      // 7a. For sales: dispatch opportunity-focused queries FIRST
      const strategyQueries = pipelineContext?.sales?.salesStrategy?.opportunitySearchQueries;
      if (pipelineContext?.useCase === 'sales' && strategyQueries && strategyQueries.length > 0) {
        for (const sq of strategyQueries) {
          const searchQuery = typeof sq === 'string' ? sq : sq.query;
          if (!searchQuery) continue;
          const jobId = await this.dispatchNext(
            'discovery',
            {
              searchQueries: [searchQuery],
              maxResults: 10,
              masterAgentId,
              opportunityFocused: true,
              pipelineContext,
              dryRun: dryRun || undefined,
            },
            { delay: getBatchDelay(jobIndex) },
          );
          dispatchedJobIds.push(jobId);
          jobIndex++;
        }
        logger.info({ masterAgentId, strategyQueryCount: strategyQueries.length }, 'Dispatched opportunity-focused discovery jobs (Phase 1)');
      }

      // 7b. Dispatch standard discovery queries in batches of 5
      for (const q of queries) {
        const jobId = await this.dispatchNext(
          'discovery',
          {
            searchQueries: [q!],
            maxResults: 10,
            masterAgentId,
            pipelineContext,
            dryRun: dryRun || undefined,
          },
          { delay: getBatchDelay(jobIndex) },
        );
        dispatchedJobIds.push(jobId);
        jobIndex++;
      }

      // 7c. Dispatch deep discovery job 15 minutes after start
      const deepJobId = await this.dispatchNext(
        'discovery',
        {
          deepDiscovery: true,
          discoveryParams: {
            keywords: queries.slice(0, 5),
            industry: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[])?.[0],
            location: (requirements.locations as string[])?.[0],
            techStack: requirements.requiredSkills as string[],
            targetRoles: requirements.targetRoles as string[],
            useCase: agent.useCase as 'recruitment' | 'sales',
            targetCountries: (agentConfig.targetCountries as string[]) ?? undefined,
          },
          masterAgentId,
          pipelineContext,
          dryRun: dryRun || undefined,
        },
        { delay: 900000 }, // 15 minutes
      );
      dispatchedJobIds.push(deepJobId);
    }

    this.sendMessage(null, 'task_assignment', {
      action: 'dispatched',
      toAgent: 'discovery',
      jobCount: dispatchedJobIds.length,
      queryCount: queries.length,
    });

    await this.emitEvent('master:started', {
      masterAgentId,
      queryCount: queries.length,
      jobIds: dispatchedJobIds,
      enabledAgents: enabledAgents ?? 'all',
    });

    this.logActivity('master_completed', 'completed', {
      details: { queryCount: queries.length, dispatchedJobs: dispatchedJobIds.length, enabledAgents: enabledAgents ?? 'all' },
    });
    await this.clearCurrentAction();

    logger.info({ tenantId: this.tenantId, masterAgentId, queryCount: queries.length, enabledAgents }, 'MasterAgent dispatched discovery jobs');

    return {
      parsedRequirements: requirements,
      queryCount: queries.length,
      dispatchedJobIds,
      enabledAgents: enabledAgents ?? 'all',
    };
  }

  /**
   * Orchestration loop — called periodically by a repeatable BullMQ job.
   * Collects pipeline metrics, makes decisions, and adjusts the pipeline.
   */
  async orchestrate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId } = input as { masterAgentId: string };

    logger.info({ tenantId: this.tenantId, masterAgentId }, 'MasterAgent orchestration loop starting');

    // 1. Collect pipeline metrics
    const metrics = await withTenant(this.tenantId, async (tx) => {
      const statusCounts = await tx
        .select({
          status: contacts.status,
          count: count(),
        })
        .from(contacts)
        .where(and(eq(contacts.tenantId, this.tenantId), eq(contacts.masterAgentId, masterAgentId)))
        .groupBy(contacts.status);

      const byStatus: Record<string, number> = {};
      for (const row of statusCounts) {
        byStatus[row.status] = Number(row.count);
      }

      return {
        discovered: byStatus.discovered ?? 0,
        enriched: byStatus.enriched ?? 0,
        scored: byStatus.scored ?? 0,
        contacted: byStatus.contacted ?? 0,
        archived: byStatus.archived ?? 0,
        rejected: byStatus.rejected ?? 0,
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      };
    });

    // 2. Compute rates
    const enrichmentRate = metrics.total > 0 ? ((metrics.enriched + metrics.scored + metrics.contacted) / metrics.total) * 100 : 0;
    const archiveRate = metrics.total > 0 ? (metrics.archived / metrics.total) * 100 : 0;
    const scoringAcceptRate = (metrics.enriched + metrics.scored + metrics.contacted) > 0
      ? ((metrics.scored + metrics.contacted) / (metrics.enriched + metrics.scored + metrics.contacted)) * 100 : 0;

    // 3. Make decisions and take action
    const decisions: string[] = [];
    const actions: string[] = [];

    if (archiveRate > 60) {
      decisions.push('High archive rate detected — discovery may be producing low-quality results.');
      this.sendMessage(null, 'reasoning', {
        action: 'orchestration_warning',
        warning: 'high_archive_rate',
        archiveRate: Math.round(archiveRate),
        suggestion: 'Review search queries — too many low-quality results are being archived.',
      });
    }

    if (scoringAcceptRate < 30 && (metrics.enriched + metrics.scored) > 10) {
      decisions.push('Low scoring acceptance rate — threshold may be too strict or enrichment data insufficient.');
    }

    if (metrics.discovered > 50 && metrics.enriched < 10) {
      decisions.push('Enrichment bottleneck detected — dispatching enrichment for unenriched companies.');

      // ACTION: Find companies with domain but low dataCompleteness and dispatch enrichment
      try {
        const unenrichedCompanies = await withTenant(this.tenantId, async (tx) => {
          return tx.select({ id: companies.id, name: companies.name, domain: companies.domain })
            .from(companies)
            .where(and(
              eq(companies.tenantId, this.tenantId),
              eq(companies.masterAgentId, masterAgentId),
              lt(companies.dataCompleteness, 70),
              isNotNull(companies.domain),
            ))
            .limit(10);
        });

        let dispatched = 0;
        for (const comp of unenrichedCompanies) {
          try {
            await this.dispatchNext('enrichment', {
              companyId: comp.id,
              masterAgentId,
            });
            dispatched++;
          } catch (err) {
            logger.warn({ err, companyId: comp.id }, 'Failed to dispatch company enrichment from orchestrator');
          }
        }

        if (dispatched > 0) {
          actions.push(`Dispatched enrichment for ${dispatched} unenriched companies`);
          this.sendMessage('enrichment', 'task_assignment', {
            action: 'orchestrator_enrichment_dispatch',
            companyCount: dispatched,
            reason: 'enrichment_bottleneck',
          });
        }
      } catch (err) {
        logger.warn({ err, masterAgentId }, 'Failed to query unenriched companies for orchestration');
      }
    }

    // Service outage detection: check last 10 enrichment tasks
    try {
      const recentEnrichments = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ output: agentTasks.output })
          .from(agentTasks)
          .where(and(
            eq(agentTasks.tenantId, this.tenantId),
            eq(agentTasks.masterAgentId, masterAgentId),
            eq(agentTasks.agentType, 'enrichment' as any),
            eq(agentTasks.status, 'completed'),
          ))
          .orderBy(sql`created_at DESC`)
          .limit(10);
      });

      if (recentEnrichments.length >= 10) {
        const allBelow20 = recentEnrichments.every(e => {
          const output = e.output as Record<string, unknown> | null;
          return (output?.dataCompleteness as number ?? 0) < 20;
        });
        if (allBelow20) {
          decisions.push('POSSIBLE SERVICE OUTAGE: last 10 enrichments all below 20% completeness');
          await this.emitEvent('pipeline:service_outage_suspected', { masterAgentId });
          logger.error({ masterAgentId }, 'Possible service outage — last 10 enrichments all below 20% completeness');
        }
      }
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'Failed to check for service outage in orchestrator');
    }

    // Re-enrichment disabled — enrichment_retry_count column not migrated to production DB
    // TODO: Re-enable after running db:generate + applying migration

    if (metrics.scored > 20 && metrics.contacted < 5) {
      decisions.push('Outreach bottleneck detected — scored contacts are not being contacted.');
    }

    this.sendMessage(null, 'reasoning', {
      action: 'orchestration_analysis',
      metrics,
      rates: {
        enrichmentRate: Math.round(enrichmentRate),
        archiveRate: Math.round(archiveRate),
        scoringAcceptRate: Math.round(scoringAcceptRate),
      },
      decisions: decisions.length > 0 ? decisions : ['Pipeline running normally — no adjustments needed.'],
      actionsTaken: actions.length > 0 ? actions : undefined,
    });

    this.logActivity('orchestration_completed', 'completed', {
      details: { metrics, decisions, actions },
    });

    logger.info({ masterAgentId, metrics, decisions, actions }, 'MasterAgent orchestration loop completed');

    return { metrics, decisions, actions };
  }
}
