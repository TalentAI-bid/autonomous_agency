import { eq, and, sql, count } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, opportunities, agentActivityLog } from '../db/schema/index.js';
import {
  buildInitialStrategySystemPrompt,
  buildInitialStrategyUserPrompt,
} from '../prompts/strategist.prompt.js';
import type { PipelineContext, SalesStrategy, PipelineStepParams } from '../types/pipeline-context.js';
import { createRedisConnection } from '../queues/setup.js';
import { SMART_MODEL } from '../tools/together-ai.tool.js';
import { detectMissionStrategyFromText } from '../utils/mission-intent.js';
import logger from '../utils/logger.js';

// ─── Validation + defaults for the new strategist contract ──────────────────

const DEFAULT_NEGATIVE_KEYWORDS = [
  'association', 'federation', 'chamber', 'community', 'meetup', 'club',
  'conference', 'summit', 'forum', 'expo', 'event series',
  'magazine', 'newsletter', 'podcast', 'media', 'publication', 'journal', 'review',
  'university', 'school', 'academy', 'lab', 'research center', 'department',
  'student', 'alumni', 'msc', 'phd', 'course', 'bootcamp', 'training',
  'book', 'publisher', 'press',
  'ngo', 'non-profit', 'nonprofit',
  'freelancer', 'self-employed',
  'headhunter', 'recruitment agency', 'staffing agency',
  'incubator', 'accelerator',
];

const DEFAULT_FORBIDDEN_PHRASES = [
  'appears to', 'may need', 'likely needs', 'possibly', 'could benefit from',
  'limited team', 'small team managing', 'no visible',
  'website appears', 'may have', 'potential need', 'seems to',
];

const DEFAULT_GROUNDING_INSTRUCTION =
  "Extract only signals that are directly supported by an exact phrase in the input. " +
  "Each signal MUST include a 'citation' field with the supporting substring. " +
  "If no signal is supported by the input, return an empty signals array. " +
  "An empty output is the correct, honest answer for most companies. " +
  "Never fabricate pain points, tech gaps, or outreach angles. " +
  "Output without citations will be rejected by the validation layer and logged as a hallucination.";

const DEFAULT_ICS = (): NonNullable<SalesStrategy['idealCustomerShape']> => ({
  sizeRange: { min: 20, max: 500 },
  preferredStages: [],
  buyerSignals: [],
  antiSignals: ['association', 'media', 'meetup', 'university', 'freelancer'],
  geographicScope: ['Global'],
  buyerFunctions: ['CEO', 'CTO', 'Founder'],
});

export function validateStrategistOutput(strategy: SalesStrategy): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!strategy.idealCustomerShape) errors.push('missing idealCustomerShape');
  if (!strategy.idealCustomerShape?.sizeRange) errors.push('missing idealCustomerShape.sizeRange');
  if (!strategy.idealCustomerShape?.buyerFunctions?.length) errors.push('idealCustomerShape.buyerFunctions empty');
  if (!strategy.idealCustomerShape?.antiSignals?.length) errors.push('idealCustomerShape.antiSignals empty');
  if (!strategy.queryDesignNotes) errors.push('missing queryDesignNotes');

  for (const step of strategy.pipelineSteps ?? []) {
    const isDiscoveryStep = step.tool === 'LINKEDIN_EXTENSION' || step.tool === 'CRAWL4AI';
    const isAnalysisStep = step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING' || step.tool === 'CRAWL4AI';
    const params = step.params as PipelineStepParams | undefined;

    if (isDiscoveryStep) {
      if (!params?.negativeKeywords?.length) errors.push(`step ${step.id} missing params.negativeKeywords`);
      if (!params?.requiredAttributes) errors.push(`step ${step.id} missing params.requiredAttributes`);
    }
    if (isAnalysisStep) {
      if (!params?.groundingRequired) errors.push(`step ${step.id} missing params.groundingRequired`);
      if (!params?.outputContract) errors.push(`step ${step.id} missing params.outputContract`);
    }
    if (step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING') {
      if (!params?.instruction) errors.push(`step ${step.id} missing params.instruction`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Mutate-in-place: fill any missing required params on each pipelineStep with
 * deterministic defaults. Used as a last-resort safety net so a downstream
 * dispatcher never sees a strategy without the contract fields.
 */
export function fillStrategyDefaults(strategy: SalesStrategy): SalesStrategy {
  if (!strategy.idealCustomerShape) strategy.idealCustomerShape = DEFAULT_ICS();
  if (!strategy.icpSegmentation) strategy.icpSegmentation = [];
  if (!strategy.queryDesignNotes) {
    strategy.queryDesignNotes =
      'Downstream agents must produce grounded output only. Empty signals/painPoints arrays are ' +
      'preferred over fabricated content. Every painPoint and outreachAngle must include a citation ' +
      'field referencing the exact phrase from scraped input that supports it.';
  }

  const ics = strategy.idealCustomerShape;
  const requiredAttributes = {
    minSize: ics.sizeRange.min,
    maxSize: ics.sizeRange.max,
    geographicScope: ics.geographicScope,
  };
  const outputContract = {
    noFabrication: true,
    requireCitations: true,
    forbiddenPhrases: DEFAULT_FORBIDDEN_PHRASES,
    allowEmptyOutput: true,
  };

  for (const step of strategy.pipelineSteps ?? []) {
    const params = (step.params ?? {}) as PipelineStepParams;
    const isDiscoveryStep = step.tool === 'LINKEDIN_EXTENSION' || step.tool === 'CRAWL4AI';
    const isAnalysisStep = step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING' || step.tool === 'CRAWL4AI';

    if (isDiscoveryStep) {
      if (!params.negativeKeywords?.length) params.negativeKeywords = [...DEFAULT_NEGATIVE_KEYWORDS];
      if (!params.requiredAttributes) params.requiredAttributes = requiredAttributes;
    }
    if (isAnalysisStep) {
      if (!params.groundingRequired) params.groundingRequired = true;
      if (!params.outputContract) params.outputContract = outputContract;
    }
    if (step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING') {
      if (!params.instruction) params.instruction = DEFAULT_GROUNDING_INSTRUCTION;
    }
    step.params = params;
  }

  return strategy;
}

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
    let savedStrategy: SalesStrategy | undefined;
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
      savedStrategy = cfg.salesStrategy as SalesStrategy | undefined;
    } catch { /* continue without mission */ }

    // Defense-in-depth idempotency: the strategy is generated ONCE during
    // chat setup. If a saved strategy with pipelineSteps already exists,
    // return it without calling the LLM or overwriting config. The only
    // sanctioned path to recompute is POST /:id/regenerate-strategy, which
    // sets `force: true` on the input.
    let force = input.force === true;

    // PART 7 — lazy migration: existing strategies that pre-date the
    // idealCustomerShape contract get auto-regenerated the first time they
    // run. Without this, downstream validation would reject them.
    const isLegacyShape = savedStrategy?.pipelineSteps?.length && !savedStrategy.idealCustomerShape;
    if (isLegacyShape && !force) {
      logger.info(
        { masterAgentId },
        'Strategist: saved strategy missing idealCustomerShape — forcing regeneration (lazy migration)',
      );
      try {
        await withTenant(this.tenantId, async (tx) => {
          await tx.insert(agentActivityLog).values({
            tenantId: this.tenantId,
            masterAgentId,
            agentType: 'strategist',
            action: 'lazy_migration_idealCustomerShape',
            status: 'started',
            details: { reason: 'saved strategy lacks idealCustomerShape' },
          });
        });
      } catch (err) {
        logger.debug({ err }, 'Strategist: failed to log lazy-migration event (non-fatal)');
      }
      force = true;
    }

    if (!force && savedStrategy?.pipelineSteps?.length) {
      logger.info(
        { masterAgentId, stepCount: savedStrategy.pipelineSteps.length },
        'Strategist: saved salesStrategy present — short-circuiting (use force=true to regenerate)',
      );
      await this.clearCurrentAction();
      return { strategy: savedStrategy, status: 'reused' };
    }

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
   * Run extractJSON with a single retry on JSON-parse failure, validate the
   * structured contract (idealCustomerShape + per-step grounding params), and
   * re-prompt the LLM ONCE if validation fails. Final safety net: deterministic
   * strategy with defaults filled in. Never throws — the master-agent
   * discovery gate depends on ALWAYS having a strategist-produced bdStrategy.
   */
  private async generateStrategyWithFallback(
    ctx: PipelineContext,
    mission: string | undefined,
    masterAgentId: string,
    forcedBdStrategy?: SalesStrategy['bdStrategy'],
  ): Promise<SalesStrategy> {
    const baseMessages = [
      { role: 'system' as const, content: buildInitialStrategySystemPrompt(forcedBdStrategy) },
      { role: 'user' as const, content: buildInitialStrategyUserPrompt(ctx, mission) },
    ];

    // First call — extract JSON with the existing 2-attempt JSON-parse retry.
    let strategy: SalesStrategy | null = null;
    let firstErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        strategy = await this.extractJSON<SalesStrategy>(
          baseMessages,
          undefined,
          { model: SMART_MODEL, temperature: 0.2 },
        );
        break;
      } catch (err) {
        firstErr = err;
        logger.warn({ err, attempt, masterAgentId }, 'StrategistAgent: extractJSON attempt failed');
      }
    }

    if (!strategy) {
      logger.error(
        { err: firstErr, masterAgentId, missionExcerpt: (mission ?? '').slice(0, 200) },
        'StrategistAgent: all extractJSON attempts failed — using deterministic fallback strategy',
      );
      return fillStrategyDefaults(this.buildDeterministicStrategy(mission));
    }

    // Schema-level validation. If invalid, log and re-prompt ONCE with errors.
    const firstCheck = validateStrategistOutput(strategy);
    if (firstCheck.valid) return strategy;

    logger.warn(
      { masterAgentId, errors: firstCheck.errors },
      'StrategistAgent: validation failed — re-prompting LLM once',
    );
    try {
      await withTenant(this.tenantId, async (tx) => {
        await tx.insert(agentActivityLog).values({
          tenantId: this.tenantId,
          masterAgentId,
          agentType: 'strategist',
          action: 'validation_failed',
          status: 'failed',
          details: { attempt: 'first', errors: firstCheck.errors },
        });
      });
    } catch (err) {
      logger.debug({ err }, 'Strategist: failed to log validation_failed (non-fatal)');
    }

    const retryMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: JSON.stringify(strategy) },
      {
        role: 'user' as const,
        content:
          'Your previous strategy was missing the following required fields: ' +
          firstCheck.errors.join('; ') +
          '. Re-emit the COMPLETE strategy with these fields filled in. Same JSON format.',
      },
    ];

    let retried: SalesStrategy | null = null;
    try {
      retried = await this.extractJSON<SalesStrategy>(
        retryMessages,
        undefined,
        { model: SMART_MODEL, temperature: 0.2 },
      );
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'StrategistAgent: re-prompt extractJSON failed');
    }

    if (retried) {
      const secondCheck = validateStrategistOutput(retried);
      if (secondCheck.valid) {
        logger.info({ masterAgentId }, 'StrategistAgent: re-prompt produced valid strategy');
        return retried;
      }
      logger.warn(
        { masterAgentId, errors: secondCheck.errors },
        'StrategistAgent: re-prompt still invalid — falling back to defaults',
      );
      try {
        await withTenant(this.tenantId, async (tx) => {
          await tx.insert(agentActivityLog).values({
            tenantId: this.tenantId,
            masterAgentId,
            agentType: 'strategist',
            action: 'validation_failed',
            status: 'failed',
            details: { attempt: 'retry', errors: secondCheck.errors },
          });
        });
      } catch (err) {
        logger.debug({ err }, 'Strategist: failed to log retry validation_failed (non-fatal)');
      }
      // Take the retried strategy (closer to LLM intent) and fill missing pieces.
      return fillStrategyDefaults(retried);
    }

    // Both LLM passes failed validation; patch the first response with defaults.
    return fillStrategyDefaults(strategy);
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
      idealCustomerShape: DEFAULT_ICS(),
      icpSegmentation: [],
      queryDesignNotes:
        'Downstream agents must produce grounded output only. Empty signals/painPoints arrays are ' +
        'preferred over fabricated content. Every painPoint and outreachAngle must include a citation ' +
        'field referencing the exact phrase from scraped input that supports it.',
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
