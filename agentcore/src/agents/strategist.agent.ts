import { eq, and, sql, count } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, opportunities } from '../db/schema/index.js';
import {
  buildInitialStrategySystemPrompt,
  buildInitialStrategyUserPrompt,
} from '../prompts/strategist.prompt.js';
import type { PipelineContext, SalesStrategy } from '../types/pipeline-context.js';
import { createRedisConnection } from '../queues/setup.js';
import { SMART_MODEL } from '../tools/together-ai.tool.js';
import { detectMissionStrategyFromText } from '../utils/mission-intent.js';
import logger from '../utils/logger.js';

const redis = createRedisConnection();

export class StrategistAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'strategist' });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const job = (input.job as string) ?? 'initialStrategy';
    const masterAgentId = (input.masterAgentId as string) || this.masterAgentId;

    if (job === 'initialStrategy') {
      return this.executeInitialStrategy(input, masterAgentId);
    }

    throw new Error(`Unknown strategist job: ${job}`);
  }

  private async executeInitialStrategy(
    input: Record<string, unknown>,
    masterAgentId: string,
  ): Promise<Record<string, unknown>> {
    logger.info({ tenantId: this.tenantId, masterAgentId }, 'StrategistAgent starting initial strategy');
    await this.setCurrentAction('initial_strategy', 'Generating initial sales strategy');

    const ctx = input.pipelineContext as PipelineContext | undefined;
    if (!ctx) throw new Error('PipelineContext required for initial strategy');

    // Load mission from master agent for richer context
    let mission: string | undefined;
    try {
      const [agent] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ mission: masterAgents.mission }).from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      mission = agent?.mission ?? undefined;
    } catch { /* continue without mission */ }

    // Call LLM for strategy. Wrap in retry + deterministic fallback so the
    // strategist always returns a usable SalesStrategy, even when the LLM is
    // flaky. The discovery gate in master-agent (master-agent.ts:830) trusts
    // ONLY this output — there is intentionally no agentConfig fallback there
    // — so this method is the single source of truth for bdStrategy and must
    // not throw or return null.
    const strategy = await this.generateStrategyWithFallback(ctx, mission, masterAgentId);

    // Safety net: the LLM occasionally picks bdStrategy='hiring_signal' for
    // industry-only missions when regional coverage is limited, which makes
    // master-agent dispatch (master-agent.ts:443 vs :574) take the wrong path.
    // If the mission text has clear industry markers and no hiring verbs, force
    // industry_target and clear stale pipelineSteps so the dispatcher rebuilds
    // root steps from targetIndustries instead of generic jobTitles.
    const intent = detectMissionStrategyFromText(mission ?? '');
    if (
      strategy.bdStrategy === 'hiring_signal' &&
      intent.hasIndustryMentions &&
      !intent.hasHiringVerbs
    ) {
      logger.warn(
        {
          masterAgentId,
          missionExcerpt: (mission ?? '').slice(0, 200),
          originalBdStrategy: strategy.bdStrategy,
          recommendedByHeuristic: intent.recommended,
        },
        'Strategist safety-net: overriding hiring_signal → industry_target for industry-only mission',
      );
      strategy.bdStrategy = 'industry_target';
      strategy.pipelineSteps = undefined;
    }

    // Save to masterAgent.config.salesStrategy
    await withTenant(this.tenantId, async (tx) => {
      const [agent] = await tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
      if (agent) {
        const currentConfig = (agent.config as Record<string, unknown>) ?? {};
        await tx.update(masterAgents)
          .set({
            config: { ...currentConfig, salesStrategy: strategy },
            updatedAt: new Date(),
          })
          .where(eq(masterAgents.id, masterAgentId));
      }
    });

    // Publish result to Redis so MasterAgent can pick it up
    const resultKey = `strategist-result:${masterAgentId}`;
    await redis.setex(resultKey, 86400, JSON.stringify(strategy));

    this.logActivity('initial_strategy_completed', 'completed', {
      details: {
        queryCount: strategy.opportunitySearchQueries?.length ?? 0,
        angleCount: strategy.emailStrategy?.angles?.length ?? 0,
      },
    });

    await this.emitEvent('strategy:completed', {
      masterAgentId,
      type: 'initial',
    });

    await this.clearCurrentAction();

    logger.info({ masterAgentId }, 'StrategistAgent initial strategy completed');
    return { strategy, status: 'completed' };
  }

  /**
   * Run extractJSON with a single retry, then fall back to a deterministic
   * strategy derived from the mission text. Never throws — the master-agent
   * discovery gate depends on ALWAYS having a strategist-produced bdStrategy.
   */
  private async generateStrategyWithFallback(
    ctx: PipelineContext,
    mission: string | undefined,
    masterAgentId: string,
  ): Promise<SalesStrategy> {
    const messages = [
      { role: 'system' as const, content: buildInitialStrategySystemPrompt() },
      { role: 'user' as const, content: buildInitialStrategyUserPrompt(ctx, mission) },
    ];

    const maxAttempts = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.extractJSON<SalesStrategy>(
          messages,
          undefined,
          { model: SMART_MODEL, temperature: 0.4 },
        );
      } catch (err) {
        lastErr = err;
        logger.warn(
          { err, attempt, maxAttempts, masterAgentId },
          'StrategistAgent: extractJSON attempt failed',
        );
      }
    }

    logger.error(
      { err: lastErr, masterAgentId, missionExcerpt: (mission ?? '').slice(0, 200) },
      'StrategistAgent: all extractJSON attempts failed — using deterministic fallback strategy',
    );
    return this.buildDeterministicStrategy(mission);
  }

  /**
   * Build a minimal but valid SalesStrategy from the mission text alone.
   * Picks bdStrategy via the same regex heuristic the chat-service intent
   * classifier uses. Empty arrays are intentional — the master-agent
   * dispatcher gracefully degrades to agentConfig.hiringKeywords / services
   * when strategy fields are missing.
   */
  private buildDeterministicStrategy(mission: string | undefined): SalesStrategy {
    const intent = detectMissionStrategyFromText(mission ?? '');
    const bdStrategy: SalesStrategy['bdStrategy'] = intent.recommended ?? 'industry_target';
    return {
      reasoning:
        'Deterministic fallback strategy — LLM call failed after retries. ' +
        'bdStrategy was derived from mission-text heuristics; downstream ' +
        'discovery uses agentConfig defaults for keywords/services.',
      userRole: 'vendor',
      bdStrategy,
      targetIndustries: [],
      painPointsAddressed: [],
      opportunitySearchQueries: [],
      hiringKeywords: [],
    };
  }
}
