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

    // Load mission AND user-chosen strategy from master agent.
    let mission: string | undefined;
    let userExplicitBdStrategy: SalesStrategy['bdStrategy'] | undefined;
    try {
      const [agent] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ mission: masterAgents.mission, config: masterAgents.config }).from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      mission = agent?.mission ?? undefined;
      const cfg = (agent?.config as Record<string, unknown> | null) ?? {};
      const explicit = cfg.userExplicitBdStrategy as string | undefined;
      if (explicit === 'hiring_signal' || explicit === 'industry_target' || explicit === 'hybrid') {
        userExplicitBdStrategy = explicit;
        logger.info({ masterAgentId, userExplicitBdStrategy }, 'Strategist: user-locked bdStrategy detected');
      }
    } catch { /* continue without mission */ }

    // Call LLM for strategy. Wrap in retry + deterministic fallback so the
    // strategist always returns a usable SalesStrategy, even when the LLM is
    // flaky. When userExplicitBdStrategy is set, it's passed as a hard
    // constraint to the prompt so the LLM generates the matching keyword set.
    const strategy = await this.generateStrategyWithFallback(ctx, mission, masterAgentId, userExplicitBdStrategy);

    if (userExplicitBdStrategy) {
      // User locked the choice in chat. Force the bdStrategy regardless of
      // LLM output, and skip the legacy industry-mention safety-net.
      strategy.bdStrategy = userExplicitBdStrategy;
      // Industry/hybrid paths require the extension. Force the flag so
      // master-agent's dispatch decision doesn't silently skip them.
      if (userExplicitBdStrategy === 'industry_target' || userExplicitBdStrategy === 'hybrid') {
        strategy.dataSourceStrategy = {
          ...(strategy.dataSourceStrategy ?? { primaryRegion: '', availableSources: [], expectedQuality: 'medium', userNotes: '' }),
          needsChromeExtension: true,
        };
      }

      // The LLM often emits BOTH a correct root step (matching the lock) and
      // a wrong-strategy root step (e.g. industry_target gets the right
      // LINKEDIN_EXTENSION:search_companies AND a stray
      // CRAWL4AI:search_linkedin_jobs). Filter out only the wrong-strategy
      // steps and clean up dependsOn references so the rest of the pipeline
      // (fetch_company_detail, LLM_ANALYSIS, REACHER, SCORING…) survives
      // intact. Only fall back to a fresh deterministic pipeline if filtering
      // leaves us with no valid root step at all.
      if (strategy.pipelineSteps?.length) {
        const before = strategy.pipelineSteps.map(s => `${s.tool}:${s.action}`);
        const filtered = this.filterStepsForLockedStrategy(strategy.pipelineSteps, userExplicitBdStrategy);
        if (filtered.length !== strategy.pipelineSteps.length) {
          logger.warn(
            {
              masterAgentId,
              userExplicitBdStrategy,
              llmSteps: before,
              keptSteps: filtered.map(s => `${s.tool}:${s.action}`),
            },
            'Strategist: removed wrong-strategy pipelineSteps that contradicted the user lock',
          );
          strategy.pipelineSteps = filtered;
        }
      }
      if (!this.pipelineStepsMatchStrategy(strategy.pipelineSteps, userExplicitBdStrategy)) {
        const before = strategy.pipelineSteps?.map(s => `${s.tool}:${s.action}`) ?? [];
        strategy.pipelineSteps = this.buildDeterministicPipelineSteps(userExplicitBdStrategy);
        logger.warn(
          {
            masterAgentId,
            userExplicitBdStrategy,
            llmSteps: before,
            replacedWith: strategy.pipelineSteps.map(s => `${s.tool}:${s.action}`),
          },
          'Strategist: pipelineSteps still missing required root after filtering — replaced with deterministic steps',
        );
      }

      logger.info({ masterAgentId, bdStrategy: strategy.bdStrategy, stepCount: strategy.pipelineSteps?.length ?? 0 }, 'Strategist: applied user-locked bdStrategy');
    } else {
      // Safety net: the LLM occasionally picks bdStrategy='hiring_signal' for
      // industry-only missions when regional coverage is limited, which makes
      // master-agent dispatch take the wrong path. If the mission text has
      // clear industry markers and no hiring verbs, force industry_target.
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
    forcedBdStrategy?: SalesStrategy['bdStrategy'],
  ): Promise<SalesStrategy> {
    const messages = [
      { role: 'system' as const, content: buildInitialStrategySystemPrompt(forcedBdStrategy) },
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
      pipelineSteps: this.buildDeterministicPipelineSteps(bdStrategy),
    };
  }

  /**
   * Deterministic pipelineSteps[] for a given bdStrategy. Used as a safe
   * fallback when:
   *   - the LLM call fails (buildDeterministicStrategy)
   *   - the LLM emits steps that contradict the user-locked bdStrategy
   * Each strategy maps to a fixed root-step toolset:
   *   - industry_target → LINKEDIN_EXTENSION:search_companies (root)
   *   - hiring_signal   → CRAWL4AI:search_linkedin_jobs (root)
   *   - hybrid          → BOTH as parallel roots
   */
  private buildDeterministicPipelineSteps(bdStrategy: SalesStrategy['bdStrategy']): NonNullable<SalesStrategy['pipelineSteps']> {
    const steps: NonNullable<SalesStrategy['pipelineSteps']> = [];
    if (bdStrategy === 'hiring_signal' || bdStrategy === 'hybrid') {
      steps.push({
        id: 'discover_jobs',
        tool: 'CRAWL4AI',
        action: 'search_linkedin_jobs',
        dependsOn: [],
        params: {},
      });
    }
    if (bdStrategy === 'industry_target' || bdStrategy === 'hybrid') {
      steps.push({
        id: 'discover_companies',
        tool: 'LINKEDIN_EXTENSION',
        action: 'search_companies',
        dependsOn: [],
        params: {},
      });
    }
    return steps;
  }

  /**
   * Remove pipelineSteps that contradict the locked bdStrategy, preserving
   * the rest of the chain.
   *   - locked=industry_target → drop any CRAWL4AI jobs-search steps
   *   - locked=hiring_signal   → drop LINKEDIN_EXTENSION:search_companies (root only)
   *   - locked=hybrid          → keep everything (both roots are wanted)
   *
   * After dropping a step we strip its id from every other step's dependsOn
   * so the dispatcher's dependency graph stays consistent.
   */
  private filterStepsForLockedStrategy(
    steps: NonNullable<SalesStrategy['pipelineSteps']>,
    bdStrategy: SalesStrategy['bdStrategy'],
  ): NonNullable<SalesStrategy['pipelineSteps']> {
    const isWrong = (s: { tool: string; action: string }) => {
      if (bdStrategy === 'industry_target') {
        return s.tool === 'CRAWL4AI'
          && (s.action === 'search_linkedin_jobs' || s.action === 'linkedin_jobs' || s.action === 'search_jobs');
      }
      if (bdStrategy === 'hiring_signal') {
        return s.tool === 'LINKEDIN_EXTENSION' && s.action === 'search_companies';
      }
      return false;
    };

    const wrongIds = new Set(steps.filter(isWrong).map(s => s.id));
    if (wrongIds.size === 0) return steps;

    return steps
      .filter(s => !wrongIds.has(s.id))
      .map(s => ({
        ...s,
        dependsOn: (s.dependsOn ?? []).filter(d => !wrongIds.has(d)),
      }));
  }

  /**
   * True iff the LLM-emitted pipelineSteps[] match the locked bdStrategy.
   * Mismatch examples we reject:
   *   - locked=industry_target but steps contain CRAWL4AI:search_linkedin_jobs
   *   - locked=hiring_signal but steps contain LINKEDIN_EXTENSION:search_companies as a root
   *   - locked=hybrid but missing one of the two roots
   *   - any locked but no root step at all
   */
  private pipelineStepsMatchStrategy(
    steps: SalesStrategy['pipelineSteps'] | undefined,
    bdStrategy: SalesStrategy['bdStrategy'],
  ): boolean {
    if (!steps || steps.length === 0) return false;
    const isExtSearch = (s: { tool: string; action: string }) =>
      s.tool === 'LINKEDIN_EXTENSION' && s.action === 'search_companies';
    const isJobsSearch = (s: { tool: string; action: string }) =>
      s.tool === 'CRAWL4AI'
      && (s.action === 'search_linkedin_jobs' || s.action === 'linkedin_jobs' || s.action === 'search_jobs');

    const hasExt = steps.some(isExtSearch);
    const hasJobs = steps.some(isJobsSearch);

    if (bdStrategy === 'industry_target') return hasExt && !hasJobs;
    if (bdStrategy === 'hiring_signal') return hasJobs && !hasExt;
    if (bdStrategy === 'hybrid') return hasExt && hasJobs;
    return true;
  }
}
