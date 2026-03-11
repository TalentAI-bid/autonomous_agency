import { eq, and, sql, count, desc } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import {
  masterAgents, agentActivityLog, agentDailyStrategy, emailsSent, contacts, campaigns, opportunities,
} from '../db/schema/index.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/strategy.prompt.js';
import logger from '../utils/logger.js';

interface StrategyResult {
  search_query_changes: { add: string[]; remove: string[]; reasoning: string };
  scoring_adjustments: { threshold_change?: number; weight_changes?: Record<string, number>; reasoning: string };
  email_strategy: { angle_change?: string; tone_change?: string; timing_change?: string; reasoning: string };
  followup_strategy: { delay_change_days?: number; max_followups?: number; reasoning: string };
  source_changes: { enable?: string[]; disable?: string[]; reasoning: string };
  overall_assessment: string;
  todays_plan: string[];
}

export class StrategyAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'strategy' });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const masterAgentId = (input.masterAgentId as string) || this.masterAgentId;
    const today = new Date().toISOString().slice(0, 10);

    logger.info({ tenantId: this.tenantId, masterAgentId }, 'StrategyAgent starting');
    await this.setCurrentAction('daily_strategy', 'Analyzing performance and planning strategy');

    // Check for existing strategy today (prevent duplicates)
    const [existing] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(agentDailyStrategy)
        .where(and(
          eq(agentDailyStrategy.masterAgentId, masterAgentId),
          eq(agentDailyStrategy.strategyDate, today),
        ))
        .limit(1);
    });

    if (existing && existing.executionStatus === 'completed') {
      logger.info({ masterAgentId, today }, 'Strategy already completed for today, skipping');
      await this.clearCurrentAction();
      return { skipped: true, reason: 'already_completed_today' };
    }

    // Create or get strategy record
    const strategyId = existing?.id ?? await withTenant(this.tenantId, async (tx) => {
      const [record] = await tx.insert(agentDailyStrategy).values({
        tenantId: this.tenantId,
        masterAgentId,
        strategyDate: today,
        executionStatus: 'analyzing',
      }).onConflictDoUpdate({
        target: [agentDailyStrategy.masterAgentId, agentDailyStrategy.strategyDate],
        set: { executionStatus: 'analyzing' },
      }).returning({ id: agentDailyStrategy.id });
      return record!.id;
    });

    try {
      // 1. Gather yesterday's metrics from activity log
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
      const activityMetrics = await withTenant(this.tenantId, async (tx) => {
        return tx.select({
          agentType: agentActivityLog.agentType,
          action: agentActivityLog.action,
          total: count(),
          failed: sql<number>`COUNT(*) FILTER (WHERE ${agentActivityLog.status} = 'failed')`,
          avgDuration: sql<number>`ROUND(AVG(${agentActivityLog.durationMs}))`,
        })
        .from(agentActivityLog)
        .where(and(
          eq(agentActivityLog.tenantId, this.tenantId),
          eq(agentActivityLog.masterAgentId, masterAgentId),
          sql`${agentActivityLog.createdAt} >= ${yesterday}`,
        ))
        .groupBy(agentActivityLog.agentType, agentActivityLog.action);
      });

      // 2. Email metrics
      const emailMetrics = await withTenant(this.tenantId, async (tx) => {
        const [metrics] = await tx.select({
          sent: count(),
          opened: sql<number>`COUNT(*) FILTER (WHERE ${emailsSent.openedAt} IS NOT NULL)`,
          replied: sql<number>`COUNT(*) FILTER (WHERE ${emailsSent.repliedAt} IS NOT NULL)`,
          bounced: sql<number>`COUNT(*) FILTER (WHERE ${emailsSent.bouncedAt} IS NOT NULL)`,
        }).from(emailsSent)
        .where(sql`${emailsSent.sentAt} >= ${yesterday}`);
        return metrics ?? { sent: 0, opened: 0, replied: 0, bounced: 0 };
      });

      // 3. Pipeline stats
      const pipelineStats = await withTenant(this.tenantId, async (tx) => {
        return tx.select({
          status: contacts.status,
          total: count(),
        }).from(contacts)
        .where(and(
          eq(contacts.tenantId, this.tenantId),
          eq(contacts.masterAgentId, masterAgentId),
        ))
        .groupBy(contacts.status);
      });

      // 3b. Opportunity metrics
      const opportunityMetrics = await withTenant(this.tenantId, async (tx) => {
        return tx.select({
          type: opportunities.opportunityType,
          total: count(),
          avgScore: sql<number>`ROUND(AVG(${opportunities.buyingIntentScore}))`,
        })
        .from(opportunities)
        .where(and(
          eq(opportunities.masterAgentId, masterAgentId),
          eq(opportunities.tenantId, this.tenantId),
        ))
        .groupBy(opportunities.opportunityType);
      });

      // 4. Load master agent config for mission/context
      const [agent] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });

      if (!agent) throw new Error(`Master agent ${masterAgentId} not found`);
      const config = (agent.config as Record<string, unknown>) ?? {};

      // 5. Call LLM for strategy
      const strategyResult = await this.extractJSON<StrategyResult>([
        { role: 'system', content: buildSystemPrompt() },
        {
          role: 'user',
          content: buildUserPrompt({
            mission: agent.mission ?? agent.name,
            useCase: agent.useCase,
            services: config.services as string[] | undefined,
            activityMetrics: { byAgentAction: activityMetrics },
            emailMetrics,
            pipelineStats: { byStatus: pipelineStats },
            opportunityMetrics: opportunityMetrics.length > 0 ? opportunityMetrics : undefined,
          }),
        },
      ]);

      // 6. Save strategy record
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(agentDailyStrategy)
          .set({
            performanceAnalysis: { activityMetrics, emailMetrics, pipelineStats } as Record<string, unknown>,
            strategyDecisions: strategyResult as unknown as Record<string, unknown>,
            actionPlan: { plan: strategyResult.todays_plan } as Record<string, unknown>,
            executionStatus: 'executing',
          })
          .where(eq(agentDailyStrategy.id, strategyId));
      });

      // 7. Execute plan: dispatch new discovery queries if recommended
      if (strategyResult.search_query_changes?.add?.length > 0) {
        try {
          await this.dispatchNext('discovery', {
            searchQueries: strategyResult.search_query_changes.add,
            maxResults: 10,
            masterAgentId,
            source: 'daily_strategy',
          });
          logger.info({ queryCount: strategyResult.search_query_changes.add.length }, 'Strategy dispatched new discovery queries');
        } catch (err) {
          logger.warn({ err }, 'Failed to dispatch strategy discovery queries');
        }
      }

      // 8. Mark completed
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(agentDailyStrategy)
          .set({ executionStatus: 'completed', executedAt: new Date() })
          .where(eq(agentDailyStrategy.id, strategyId));
      });

      this.logActivity('strategy_completed', 'completed', {
        details: {
          assessment: strategyResult.overall_assessment,
          newQueries: strategyResult.search_query_changes?.add?.length ?? 0,
          planItems: strategyResult.todays_plan?.length ?? 0,
        },
      });

      await this.emitEvent('strategy:completed', {
        masterAgentId,
        strategyDate: today,
        assessment: strategyResult.overall_assessment,
      });

      await this.clearCurrentAction();

      logger.info({ masterAgentId, today }, 'StrategyAgent completed');

      return {
        strategyId,
        strategyDate: today,
        decisions: strategyResult,
        status: 'completed',
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      await withTenant(this.tenantId, async (tx) => {
        await tx.update(agentDailyStrategy)
          .set({ executionStatus: 'failed', error: errorMsg })
          .where(eq(agentDailyStrategy.id, strategyId));
      });

      this.logActivity('strategy_failed', 'failed', { error: errorMsg });
      await this.clearCurrentAction();
      throw err;
    }
  }
}
