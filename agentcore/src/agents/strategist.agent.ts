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

// Country / region names that MUST NOT appear inside searchKeywords. The
// strategist puts geography in geographyFilter.regions instead. Substring
// match is case-insensitive against each keyword.
const COUNTRY_NAMES_IN_KEYWORDS_BANLIST = [
  'belgium', 'netherlands', 'france', 'germany', 'uk', 'united kingdom',
  'ireland', 'spain', 'italy', 'poland', 'lithuania', 'sweden', 'denmark',
  'norway', 'finland', 'portugal', 'austria', 'switzerland', 'luxembourg',
  'eu', 'europe', 'european union', 'united states', 'usa', 'us', 'canada',
  // MENA + region groups (Round 8)
  'united arab emirates', 'uae', 'saudi arabia', 'egypt', 'jordan', 'qatar',
  'kuwait', 'bahrain', 'morocco',
  'mena', 'middle east', 'gcc', 'north america',
];

// User's broad market-level inputs the strategist must EXPAND into specific
// sub-categories (e.g. "fintech" → "payment infrastructure"). If a broad term
// reaches the search step verbatim, the strategist hasn't done its job.
// Whole-keyword match (lowercased + trimmed).
const UNEXPANDED_BROAD_TERMS = [
  'fintech', 'ai', 'artificial intelligence', 'machine learning',
  'healthtech', 'health tech', 'health-tech',
  'saas', 'b2b', 'b2b saas', 'b2c',
  'tech', 'software', 'startup', 'technology',
  'ecommerce', 'e-commerce',
  'marketing', 'sales', 'hr',
];

// Phrases empirically shown to return zero LinkedIn results. Substring match
// against the keyword's lowercase form (so "AI-powered fintech" trips
// "ai-powered" even though it's part of a larger keyword).
const BANNED_PHRASES = [
  'hiring developers', 'hiring engineers', 'hiring software',
  'looking for talent', 'looking for engineers',
  'need engineers', 'need developers',
  'gdpr compliant', 'gdpr compliance', 'hipaa compliant',
  'ai-powered', 'ai powered', 'best-in-class', 'industry leading',
  'scaling team', 'growing team',
  'building the next generation', 'next generation of',
];

/**
 * Round 8 — detect legacy strategy shapes that should trigger an auto-regen
 * the next time the master-agent loads. Returns the specific reason so the
 * agent_activity_log row + provenance metadata are diagnosable later.
 *
 * Trigger reasons (any one is enough):
 *   - missing_idealCustomerShape  — Round 7 contract field absent
 *   - broad_term_in_keywords      — Round 8: user's broad input ("fintech") in searchKeywords
 *   - banned_phrase_in_keywords   — Round 8: empirically-zero phrases ("hiring developers")
 *   - country_in_keywords         — Round 8: region names that belong in geographyFilter
 *
 * Geography inconsistency across search steps is logged as a soft signal
 * but does NOT trigger regen.
 */
type LegacyReason =
  | 'missing_idealCustomerShape'
  | 'broad_term_in_keywords'
  | 'banned_phrase_in_keywords'
  | 'country_in_keywords';

export function detectLegacyShape(
  saved: SalesStrategy | null,
  masterAgentIdForLog?: string,
): { legacy: boolean; reason: LegacyReason | null } {
  if (!saved?.pipelineSteps?.length) return { legacy: false, reason: null };
  if (!saved.idealCustomerShape) return { legacy: true, reason: 'missing_idealCustomerShape' };

  const searchSteps = saved.pipelineSteps.filter(
    (s) => s.tool === 'LINKEDIN_EXTENSION' && s.action === 'search_companies',
  );

  // Round 12 — broad terms are now a first-class part of the contract
  // (broad-quantity steps). Saved strategies containing broad terms are no
  // longer legacy. Banned phrases + country names in keywords still are.
  for (const step of searchSteps) {
    const params = step.params as PipelineStepParams | undefined;
    for (const kw of params?.searchKeywords ?? []) {
      const lower = kw.trim().toLowerCase();
      if (BANNED_PHRASES.some((p) => lower.includes(p))) {
        return { legacy: true, reason: 'banned_phrase_in_keywords' };
      }
      if (COUNTRY_NAMES_IN_KEYWORDS_BANLIST.includes(lower)) {
        return { legacy: true, reason: 'country_in_keywords' };
      }
    }
  }

  // Soft signal — log but don't trigger regen on geography inconsistency alone.
  if (searchSteps.length >= 2) {
    const firstRegions = JSON.stringify(
      ((searchSteps[0]?.params as PipelineStepParams | undefined)?.geographyFilter?.regions ?? [])
        .slice()
        .sort(),
    );
    const allSame = searchSteps.every(
      (s) =>
        JSON.stringify(
          ((s.params as PipelineStepParams | undefined)?.geographyFilter?.regions ?? [])
            .slice()
            .sort(),
        ) === firstRegions,
    );
    if (!allSame) {
      logger.info(
        { masterAgentId: masterAgentIdForLog, steps: searchSteps.length },
        'lazy_migration: geography inconsistent across search steps — soft signal only, not regenerating',
      );
    }
  }

  return { legacy: false, reason: null };
}

export function validateStrategistOutput(strategy: SalesStrategy): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!strategy.idealCustomerShape) errors.push('missing idealCustomerShape');
  if (!strategy.idealCustomerShape?.sizeRange) errors.push('missing idealCustomerShape.sizeRange');
  if (!strategy.idealCustomerShape?.buyerFunctions?.length) errors.push('idealCustomerShape.buyerFunctions empty');
  if (!strategy.idealCustomerShape?.antiSignals?.length) errors.push('idealCustomerShape.antiSignals empty');
  if (!strategy.queryDesignNotes) errors.push('missing queryDesignNotes');

  // Root-step count requirements branch on bdStrategy. Each strategy has a
  // DIFFERENT required root step per the prompt contract (strategist.prompt.ts:75):
  //   - industry_target / undefined: ≥3 LINKEDIN_EXTENSION:search_companies (query variety beats volume)
  //   - hiring_signal:                ≥1 CRAWL4AI:search_linkedin_jobs (LinkedIn Jobs is public, no extension)
  //   - hybrid:                       both rules apply (parallel root steps)
  const liSearchSteps = (strategy.pipelineSteps ?? []).filter(
    (s) => s.tool === 'LINKEDIN_EXTENSION' && s.action === 'search_companies',
  );
  const jobsSearchSteps = (strategy.pipelineSteps ?? []).filter(
    (s) => s.tool === 'CRAWL4AI' && s.action === 'search_linkedin_jobs',
  );
  const gmapsSearchSteps = (strategy.pipelineSteps ?? []).filter(
    (s) => s.tool === 'GMAPS_EXTENSION' && s.action === 'search_businesses',
  );
  const bd = strategy.bdStrategy;
  if (bd === 'hiring_signal') {
    if (jobsSearchSteps.length < 1) {
      errors.push(
        `too_few_jobs_search_steps (have ${jobsSearchSteps.length}, need ≥1 CRAWL4AI:search_linkedin_jobs root step for bdStrategy='hiring_signal')`,
      );
    }
  } else if (bd === 'local_business') {
    // Local discovery is Maps-only: niche-query variety beats volume (the
    // gmaps search cap is ~20/day, so 3-6 steps is the right shape).
    if (gmapsSearchSteps.length < 3) {
      errors.push(
        `too_few_gmaps_search_steps (have ${gmapsSearchSteps.length}, need ≥3 GMAPS_EXTENSION:search_businesses root steps for bdStrategy='local_business')`,
      );
    }
  } else if (bd === 'local_hybrid') {
    if (gmapsSearchSteps.length < 2) {
      errors.push(
        `too_few_gmaps_search_steps (have ${gmapsSearchSteps.length}, need ≥2 GMAPS_EXTENSION:search_businesses root steps for bdStrategy='local_hybrid')`,
      );
    }
    if (liSearchSteps.length < 3) {
      errors.push(`too_few_search_steps (have ${liSearchSteps.length}, need ≥3)`);
    }
  } else if (bd === 'hybrid') {
    if (jobsSearchSteps.length < 1) {
      errors.push(
        `too_few_jobs_search_steps (have ${jobsSearchSteps.length}, need ≥1 CRAWL4AI:search_linkedin_jobs root step for bdStrategy='hybrid')`,
      );
    }
    if (liSearchSteps.length < 3) {
      errors.push(`too_few_search_steps (have ${liSearchSteps.length}, need ≥3)`);
    }
  } else {
    // industry_target (and default for unset bdStrategy — preserves legacy behavior).
    if (liSearchSteps.length < 3) {
      errors.push(`too_few_search_steps (have ${liSearchSteps.length}, need ≥3)`);
    }
  }

  for (const step of strategy.pipelineSteps ?? []) {
    const isLinkedInSearch = step.tool === 'LINKEDIN_EXTENSION' && step.action === 'search_companies';
    const isGmapsSearch = step.tool === 'GMAPS_EXTENSION' && step.action === 'search_businesses';
    const isAnalysisStep = step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING' || step.tool === 'CRAWL4AI';
    const params = step.params as PipelineStepParams | undefined;

    if (isGmapsSearch) {
      // Contract: query (niche only) + location (city/region) + queryRationale.
      if (typeof params?.query !== 'string' || !params.query.trim()) {
        errors.push(`step ${step.id} missing params.query`);
      }
      if (typeof params?.location !== 'string' || !params.location.trim()) {
        errors.push(`step ${step.id} missing params.location`);
      }
      if (!params?.queryRationale) {
        errors.push(`step ${step.id} missing params.queryRationale`);
      }
      // Geography belongs in params.location, never in query — same rule as
      // the LinkedIn searchKeywords/geographyFilter separation.
      const q = typeof params?.query === 'string' ? params.query.toLowerCase() : '';
      for (const banned of COUNTRY_NAMES_IN_KEYWORDS_BANLIST) {
        const pattern = new RegExp(`(^|[^a-z])${banned.replace(/\s/g, '\\s')}([^a-z]|$)`, 'i');
        if (pattern.test(q)) {
          errors.push(`step ${step.id} geography_in_query ("${params?.query}" contains "${banned}" — put the city/region in params.location)`);
          break;
        }
      }
    }

    if (isLinkedInSearch) {
      // New contract: searchKeywords + geographyFilter + queryRationale.
      if (!params?.searchKeywords?.length) {
        errors.push(`step ${step.id} missing params.searchKeywords`);
      }
      if (!params?.geographyFilter || !Array.isArray(params.geographyFilter.regions) || params.geographyFilter.regions.length === 0) {
        errors.push(`step ${step.id} missing params.geographyFilter.regions`);
      }
      if (!params?.queryRationale) {
        errors.push(`step ${step.id} missing params.queryRationale`);
      }

      // geography_in_keywords — substring match each keyword against the
      // banlist. The most common LLM mistake is "fintech Belgium" instead
      // of separating into keywords + geographyFilter.
      const kws = (params?.searchKeywords ?? []) as string[];
      for (const kw of kws) {
        const lower = kw.toLowerCase();
        for (const banned of COUNTRY_NAMES_IN_KEYWORDS_BANLIST) {
          // Word-boundary match to avoid e.g. "us" matching "Tussle".
          const pattern = new RegExp(`(^|[^a-z])${banned.replace(/\s/g, '\\s')}([^a-z]|$)`, 'i');
          if (pattern.test(lower)) {
            errors.push(`step ${step.id} geography_in_keywords ("${kw}" contains "${banned}" — move to geographyFilter)`);
            break;
          }
        }
      }

      // Round 12 — broad terms ARE allowed (broad-quantity steps).
      // No broad-term rejection at the per-step level. Mix shape (broad +
      // narrow) is enforced by the prompt, not the validator.

      // Round 8 — banned-phrase rejection (substring match).
      for (const kw of kws) {
        const lower = kw.toLowerCase();
        for (const banned of BANNED_PHRASES) {
          if (lower.includes(banned)) {
            errors.push(
              `step ${step.id} banned_phrase_in_keywords ("${kw}" contains "${banned}" — empirically returns zero LinkedIn results, use sub-category nouns only)`,
            );
            break;
          }
        }
      }

      // Round 11 — max 4 keywords per step (sub-category noun + 1-2 technical
      // specialties + optional service word). Round 8's "max 2" was too
      // restrictive — single-noun queries returned categorically wrong matches
      // (LinkedIn ranks by relevance, not category, so "HR tech" alone caught
      // furniture companies). Banned phrases (Round 8) stay banned — they
      // still return zero results.
      if (kws.length > 4) {
        errors.push(
          `step ${step.id} too_many_keywords (${kws.length}) — max 4 (sub-category + 1-2 technical specialties + optional service word), split further into separate steps`,
        );
      }
    }

    if (isAnalysisStep) {
      if (!params?.groundingRequired) errors.push(`step ${step.id} missing params.groundingRequired`);
      if (!params?.outputContract) errors.push(`step ${step.id} missing params.outputContract`);
    }
    if (step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING') {
      if (!params?.instruction) errors.push(`step ${step.id} missing params.instruction`);
    }
  }

  // teamRoleKeywords — required when the pipeline includes fetch_company_team
  // (the LinkedIn `/people/?keywords=<kw>` scrape). Each entry feeds one
  // per-company task.
  const fetchTeamSteps = (strategy.pipelineSteps ?? []).filter(
    (s) => s.tool === 'LINKEDIN_EXTENSION' && s.action === 'fetch_company_team',
  );
  const rawTeamKw = (strategy as SalesStrategy & { teamRoleKeywords?: unknown }).teamRoleKeywords;
  if (rawTeamKw !== undefined && rawTeamKw !== null) {
    if (!Array.isArray(rawTeamKw)) {
      errors.push('teamRoleKeywords must be a string[]');
    } else {
      if (rawTeamKw.length > 10) {
        errors.push(`teamRoleKeywords too_many (${rawTeamKw.length}, max 10)`);
      }
      for (const kw of rawTeamKw) {
        if (typeof kw !== 'string') {
          errors.push('teamRoleKeywords contains non-string entry');
          break;
        }
        const trimmed = kw.trim();
        if (trimmed.length === 0) {
          errors.push('teamRoleKeywords contains empty string');
          break;
        }
        if (trimmed.length > 60) {
          errors.push(`teamRoleKeywords entry too_long ("${trimmed.slice(0, 30)}…", max 60 chars)`);
          break;
        }
      }
    }
  }
  if (fetchTeamSteps.length > 0) {
    const teamKw = Array.isArray(rawTeamKw)
      ? rawTeamKw.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];
    if (teamKw.length === 0) {
      errors.push(
        'teamRoleKeywords empty — pipelineSteps include LINKEDIN_EXTENSION:fetch_company_team, so 3-6 decision-maker titles (e.g. ["CTO","VP Engineering","Founder"]) are required to drive `/people/?keywords=<kw>`',
      );
    }
  }

  // Round 8 — geography consistency across search steps. Warn-only; the
  // strategist should reuse the same regions array on every search step,
  // but a deliberate per-step variation is allowed.
  if (liSearchSteps.length >= 2) {
    const firstRegions = JSON.stringify(
      ((liSearchSteps[0]?.params as PipelineStepParams | undefined)?.geographyFilter?.regions ?? [])
        .slice()
        .sort(),
    );
    const allSame = liSearchSteps.every(
      (s) =>
        JSON.stringify(
          ((s.params as PipelineStepParams | undefined)?.geographyFilter?.regions ?? [])
            .slice()
            .sort(),
        ) === firstRegions,
    );
    if (!allSame) {
      logger.warn(
        { steps: liSearchSteps.length },
        'strategist: search steps have different geographyFilter.regions — may miss companies that LinkedIn matches across the full geography',
      );
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
    const isLinkedInSearch = step.tool === 'LINKEDIN_EXTENSION' && step.action === 'search_companies';
    const isDiscoveryStep = step.tool === 'LINKEDIN_EXTENSION' || step.tool === 'CRAWL4AI';
    const isAnalysisStep = step.tool === 'LLM_ANALYSIS' || step.tool === 'SCORING' || step.tool === 'CRAWL4AI';

    if (isLinkedInSearch) {
      // New contract — fall back to seller's idealCustomerShape when the LLM
      // didn't emit per-step searchKeywords / geographyFilter / sizeFilter.
      if (!params.searchKeywords?.length) {
        // CRITICAL: Do NOT auto-fill with strategy.targetIndustries.
        // targetIndustries are user-input BROAD terms ("Fintech", "AI",
        // "Healthtech", "B2B SaaS") that return associations and media outlets
        // on LinkedIn — exactly what the validator rejects. Auto-filling them
        // produces broken queries that burn LinkedIn search quota on garbage.
        //
        // If the LLM emitted a search step without keywords, that's a bug
        // upstream. The right answer is to NOT dispatch the broken step,
        // not to fabricate keywords from a forbidden source.
        logger.warn(
          {
            stepId: step.id,
            masterAgentId: (strategy as any).masterAgentId,
            targetIndustries: strategy.targetIndustries,
          },
          'fillStrategyDefaults: search step has no keywords — marking step inactive instead of auto-filling broad terms',
        );
        (step as any).inactive = true;
        params.searchKeywords = [];
      }
      if (!params.geographyFilter || !Array.isArray(params.geographyFilter.regions) || params.geographyFilter.regions.length === 0) {
        params.geographyFilter = {
          regions: ics.geographicScope?.length ? [...ics.geographicScope] : ['Global'],
        };
      }
      if (!params.sizeFilter) {
        params.sizeFilter = { min: ics.sizeRange.min, max: ics.sizeRange.max };
      }
      if (!params.queryRationale) {
        params.queryRationale = 'Auto-filled rationale: targeting ICP-shaped companies in the configured geography and size range.';
      }
    }
    if (isDiscoveryStep) {
      // Legacy fields are still emitted for old consumers but inert.
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
      if (
        explicit === 'hiring_signal' || explicit === 'industry_target' || explicit === 'hybrid'
        || explicit === 'local_business' || explicit === 'local_hybrid'
      ) {
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

    // PART 7 / Round 8 — lazy migration: existing strategies that pre-date
    // the current contract get auto-regenerated. Detector returns the
    // SPECIFIC reason so the agent_activity_log row is greppable and the
    // regenerated strategy can be tagged with provenance metadata.
    //
    // Trigger reasons:
    //   - missing_idealCustomerShape  (Round 7 contract)
    //   - broad_term_in_keywords      (Round 8 — "fintech" etc. in searchKeywords)
    //   - banned_phrase_in_keywords   (Round 8 — "hiring developers" etc.)
    //   - country_in_keywords         (Round 8 — country names that should be in geographyFilter)
    //
    // Geography inconsistency is a soft signal: logged but does not trigger regen.
    const detection = detectLegacyShape(savedStrategy ?? null, masterAgentId);
    if (detection.legacy && !force) {
      // Guardrail 1 — Redis lock per agent: dedupe concurrent regens
      // (e.g. two dashboard tabs loading the same agent simultaneously).
      const lockKey = `strategist:regen-lock:${masterAgentId}`;
      const lockAcquired = await redis.set(lockKey, '1', 'EX', 60, 'NX');
      if (!lockAcquired) {
        logger.info(
          { masterAgentId, reason: detection.reason },
          'lazy_migration: regen already in flight for this agent — returning cached strategy',
        );
        await this.clearCurrentAction();
        return { strategy: savedStrategy, status: 'reused' };
      }

      // Guardrail 2 — per-tenant throttle: cap regens at N per minute so a
      // tenant with many agents can't trigger a thundering herd.
      const maxPerMinute = Number(process.env.STRATEGIST_REGEN_MAX_PER_TENANT_PER_MIN ?? 3);
      const throttleKey = `strategist:regen-throttle:${this.tenantId}`;
      const count = await redis.incr(throttleKey);
      if (count === 1) await redis.expire(throttleKey, 60);
      if (count > maxPerMinute) {
        logger.warn(
          { tenantId: this.tenantId, count, maxPerMinute, reason: detection.reason },
          'lazy_migration: throttled — returning cached strategy',
        );
        await this.clearCurrentAction();
        return { strategy: savedStrategy, status: 'reused' };
      }

      logger.info(
        { masterAgentId, reason: detection.reason },
        'lazy_migration: legacy strategy detected — auto-regenerating',
      );
      // Guardrail 3 — structured event so every auto-regen is greppable.
      try {
        await withTenant(this.tenantId, async (tx) => {
          await tx.insert(agentActivityLog).values({
            tenantId: this.tenantId,
            masterAgentId,
            agentType: 'strategist',
            action: 'legacy_strategy_auto_regenerated',
            status: 'started',
            details: { reason: detection.reason },
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

    // Call LLM for strategy. Round 8 contract: returns null when validation
    // failed twice (and there was no LLM transport-level safe deterministic
    // fallback). On null, we try last-known-good before failing loud.
    const strategy = await this.generateStrategyWithFallback(ctx, mission, masterAgentId, userExplicitBdStrategy);

    if (!strategy) {
      // Round 8 — fail-loud path. Try last-known-good before giving up.
      const lkg = await this.loadLastKnownGoodStrategy(masterAgentId);
      if (lkg) {
        logger.warn(
          { masterAgentId },
          'StrategistAgent: reusing last-known-good strategy after validation failure',
        );
        lkg._source = 'fallback_reused';
        await this.clearCurrentAction();
        return { strategy: lkg, status: 'fallback_reused' };
      }
      // No backup — surface to dashboard, do not enqueue search tasks.
      logger.error(
        { masterAgentId },
        'StrategistAgent: validation failed twice and no last-known-good available — failing loud',
      );
      await this.clearCurrentAction();
      return { strategy: null, status: 'failed', error: 'strategy_generation_failed' };
    }

    if (userExplicitBdStrategy) {
      // User locked the choice in chat. Force the bdStrategy regardless of
      // LLM output, and skip the legacy industry-mention safety-net.
      strategy.bdStrategy = userExplicitBdStrategy;
      // Industry/hybrid/local paths require the extension (LinkedIn and/or
      // Google Maps scrapes both run through it). Force the flag so
      // master-agent's dispatch decision doesn't silently skip them.
      if (
        userExplicitBdStrategy === 'industry_target' || userExplicitBdStrategy === 'hybrid'
        || userExplicitBdStrategy === 'local_business' || userExplicitBdStrategy === 'local_hybrid'
      ) {
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
        // Round 8 — tag provenance so dashboard debugging can distinguish
        // deterministic-fallback strategies from LLM-generated.
        strategy._source = 'deterministic';
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
    } else if (detection.legacy && detection.reason) {
      // Provenance metadata — tag regenerated strategies so future debugging
      // can distinguish auto-migrated from freshly generated. Read-only field.
      strategy._regeneratedFrom = `legacy_${detection.reason}`;
      logger.info(
        { masterAgentId, reason: detection.reason },
        'lazy_migration: regenerated strategy tagged with provenance metadata',
      );
    }
    // Below: existing safety net for non-locked strategies (LLM picks
    // hiring_signal but mission says industry-only). Gated on userExplicitBdStrategy
    // remaining unset so the lazy-migration provenance branch above can short-circuit.
    if (!userExplicitBdStrategy) {
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

    // Save to masterAgent.config.salesStrategy. Round 8 — backup-on-save:
    // copy the existing strategy to config.salesStrategyPrevious first,
    // so the next failed-LLM-validation can fall back to it via
    // loadLastKnownGoodStrategy. Single JSONB column, no migration.
    await withTenant(this.tenantId, async (tx) => {
      const [agent] = await tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
      if (agent) {
        const currentConfig = (agent.config as Record<string, unknown>) ?? {};
        const previousStrategy = currentConfig.salesStrategy as SalesStrategy | undefined;
        const newConfig: Record<string, unknown> = {
          ...currentConfig,
          salesStrategy: strategy,
        };
        // Only back up the prior strategy if it has pipelineSteps (i.e. it
        // was a real generation, not a half-written placeholder).
        if (previousStrategy?.pipelineSteps?.length) {
          newConfig.salesStrategyPrevious = previousStrategy;
        }
        await tx.update(masterAgents)
          .set({
            config: newConfig,
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
   * Round 8 — load the most recent successful strategy as a last-known-good
   * fallback. Populated by backup-on-save in executeInitialStrategy.
   * Returns null when there is no prior strategy (fresh agent, or first
   * generation also failed validation).
   */
  private async loadLastKnownGoodStrategy(masterAgentId: string): Promise<SalesStrategy | null> {
    try {
      const [agent] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config }).from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      const cfg = (agent?.config as Record<string, unknown> | null) ?? {};
      const lkg = cfg.salesStrategyPrevious as SalesStrategy | undefined;
      if (lkg?.pipelineSteps?.length) return lkg;
      return null;
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'StrategistAgent: loadLastKnownGoodStrategy failed');
      return null;
    }
  }

  /**
   * Run extractJSON with a single retry on JSON-parse failure, validate the
   * structured contract (idealCustomerShape + per-step grounding params), and
   * re-prompt the LLM ONCE if validation fails.
   *
   * Returns:
   *   - SalesStrategy on success (LLM produced a valid strategy, possibly on retry)
   *   - SalesStrategy with _source='deterministic' if extractJSON itself
   *     never returned parseable JSON (LLM transport-level failure — different
   *     from validation failure, deterministic skeleton is safe)
   *   - null if validation failed twice — caller must reuse last-known-good or
   *     surface a strategy_generation_failed error to the dashboard
   */
  private async generateStrategyWithFallback(
    ctx: PipelineContext,
    mission: string | undefined,
    masterAgentId: string,
    forcedBdStrategy?: SalesStrategy['bdStrategy'],
  ): Promise<SalesStrategy | null> {
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
      // LLM transport-level failure (different from validation failure).
      // Deterministic skeleton is safe — no broad-term keywords, just bdStrategy
      // + empty pipeline-step params. Tag with _source so dashboard debugging
      // can distinguish from LLM-generated strategies.
      const det = fillStrategyDefaults(this.buildDeterministicStrategy(mission));
      det._source = 'deterministic';
      return det;
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

    // Build a targeted retry message — call out specific common failures
    // explicitly so the LLM has a direct fix, not just a list of errors.
    const errorJoined = firstCheck.errors.join('; ');
    const fixHints: string[] = [];
    if (firstCheck.errors.some((e) => e.includes('geography_in_keywords'))) {
      fixHints.push(
        'Move every country / region / city name OUT of searchKeywords and INTO geographyFilter.regions. searchKeywords describe what the company DOES (e.g. "payment infrastructure"), not where it is.',
      );
    }
    if (firstCheck.errors.some((e) => e.includes('too_few_search_steps'))) {
      fixHints.push(
        'Generate 3-5 LINKEDIN_EXTENSION search_companies steps with DIFFERENT angles (different keyword combinations, different geographies, different ICP slices). Query variety beats query volume.',
      );
    }
    if (firstCheck.errors.some((e) => e.includes('too_few_jobs_search_steps'))) {
      fixHints.push(
        "Add a root CRAWL4AI step with action 'search_linkedin_jobs', dependsOn: [], and params { jobTitles: <3-5 role names from your hiringKeywords>, location: '<target country/region>' }. This is the discovery root for hiring_signal — the master-agent scrapes LinkedIn Jobs publicly (no Chrome extension needed). Do NOT add LINKEDIN_EXTENSION:search_companies steps for hiring_signal — those would contradict the user-locked strategy.",
      );
    }
    if (firstCheck.errors.some((e) => /missing params\.(searchKeywords|geographyFilter|queryRationale)/.test(e))) {
      fixHints.push(
        'Each LINKEDIN_EXTENSION search_companies step MUST have: searchKeywords (array of behavior/function terms, no geography), geographyFilter.regions (array of country/region names), sizeFilter.{min,max}, and queryRationale (one sentence).',
      );
    }
    if (firstCheck.errors.some((e) => e.includes('groundingRequired') || e.includes('outputContract') || e.includes('instruction'))) {
      fixHints.push(
        'Each LLM_ANALYSIS / SCORING / CRAWL4AI step needs groundingRequired:true, outputContract (with forbiddenPhrases), and instruction. See the GROUNDED-OR-NOTHING section.',
      );
    }
    if (firstCheck.errors.some((e) => e.includes('banned_phrase_in_keywords'))) {
      fixHints.push(
        'Remove urgency / stage / marketing phrases ("hiring developers", "GDPR compliant", "AI-powered", "scaling team", "Series A") from searchKeywords. These return zero LinkedIn results. Use sub-category NOUNS only ("payment infrastructure", "neobank", "MLOps").',
      );
    }
    if (firstCheck.errors.some((e) => e.includes('too_many_keywords'))) {
      fixHints.push(
        'Each search step has AT MOST 4 keywords: sub-category name + 1-2 technical specialties + optional service word (e.g. ["payment processing","API","PCI"] or ["neobank","core banking","BaaS"]). If you have more sub-categories, split them across SEPARATE search steps.',
      );
    }
    if (firstCheck.errors.some((e) => e.includes('too_few_gmaps_search_steps'))) {
      fixHints.push(
        "Generate 3-6 GMAPS_EXTENSION steps with action 'search_businesses', dependsOn: [], and params { query: '<niche keywords, NO city/country>', location: '<city or region>', limit: 20, queryRationale: '<one sentence>' }. Mix broad niches ('restaurant') with narrow ones ('asian restaurant', 'sushi restaurant'). For local_business do NOT add LINKEDIN_EXTENSION:search_companies or CRAWL4AI jobs steps.",
      );
    }
    if (firstCheck.errors.some((e) => e.includes('geography_in_query') || /missing params\.(query|location)\b/.test(e))) {
      fixHints.push(
        "Each GMAPS_EXTENSION search_businesses step MUST have params.query (the niche ONLY, e.g. 'asian restaurant' — never a city/country name) and params.location (the city/region, e.g. 'Riyadh'). Move any geography out of query and into location.",
      );
    }
    const retryMessages = [
      ...baseMessages,
      { role: 'assistant' as const, content: JSON.stringify(strategy) },
      {
        role: 'user' as const,
        content:
          `Your previous strategy had these issues: ${errorJoined}. ` +
          (fixHints.length ? `Fix specifically: ${fixHints.join(' ')} ` : '') +
          'Re-emit the COMPLETE strategy. Same JSON format.',
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

    // Round 8 — fail loud on double-validation-failure. Don't fabricate a
    // strategy via fillStrategyDefaults — that masked LLM regressions and
    // produced searches the user didn't notice were broken. Instead: log
    // the error with full context and return null. The caller decides
    // whether to reuse last-known-good or surface a dashboard error.
    if (retried) {
      const secondCheck = validateStrategistOutput(retried);
      if (secondCheck.valid) {
        logger.info({ masterAgentId }, 'StrategistAgent: re-prompt produced valid strategy');
        return retried;
      }
      logger.error(
        { masterAgentId, attempt1Errors: firstCheck.errors, attempt2Errors: secondCheck.errors },
        'StrategistAgent: validation failed twice — refusing to fabricate strategy',
      );
      try {
        await withTenant(this.tenantId, async (tx) => {
          await tx.insert(agentActivityLog).values({
            tenantId: this.tenantId,
            masterAgentId,
            agentType: 'strategist',
            action: 'strategy_generation_failed',
            status: 'failed',
            details: {
              attempt1Errors: firstCheck.errors,
              attempt2Errors: secondCheck.errors,
              missionExcerpt: (mission ?? '').slice(0, 200),
              llmOutputExcerpt: JSON.stringify(retried).slice(0, 1000),
            },
          });
        });
      } catch (err) {
        logger.debug({ err }, 'Strategist: failed to log strategy_generation_failed (non-fatal)');
      }
      return null;
    }

    // Re-prompt extractJSON failed entirely (LLM transport problem). Same
    // policy as above: log loud, return null, let caller fall back to
    // last-known-good or fail loud.
    logger.error(
      { masterAgentId, attempt1Errors: firstCheck.errors },
      'StrategistAgent: re-prompt extractJSON failed and first attempt invalid — refusing to fabricate strategy',
    );
    try {
      await withTenant(this.tenantId, async (tx) => {
        await tx.insert(agentActivityLog).values({
          tenantId: this.tenantId,
          masterAgentId,
          agentType: 'strategist',
          action: 'strategy_generation_failed',
          status: 'failed',
          details: {
            attempt1Errors: firstCheck.errors,
            reason: 'reprompt_extractjson_failed',
            missionExcerpt: (mission ?? '').slice(0, 200),
          },
        });
      });
    } catch (err) {
      logger.debug({ err }, 'Strategist: failed to log strategy_generation_failed (non-fatal)');
    }
    return null;
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
    if (bdStrategy === 'industry_target' || bdStrategy === 'hybrid' || bdStrategy === 'local_hybrid') {
      steps.push({
        id: 'discover_companies',
        tool: 'LINKEDIN_EXTENSION',
        action: 'search_companies',
        dependsOn: [],
        params: {},
      });
    }
    if (bdStrategy === 'local_business' || bdStrategy === 'local_hybrid') {
      // Empty params are acceptable — the master-agent dispatch branch falls
      // back to config targetIndustries/services for query and locations for
      // the Maps location.
      steps.push({
        id: 'discover_businesses',
        tool: 'GMAPS_EXTENSION',
        action: 'search_businesses',
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
      const isJobsRoot = s.tool === 'CRAWL4AI'
        && (s.action === 'search_linkedin_jobs' || s.action === 'linkedin_jobs' || s.action === 'search_jobs');
      const isLiSearchRoot = s.tool === 'LINKEDIN_EXTENSION' && s.action === 'search_companies';
      const isGmapsStep = s.tool === 'GMAPS_EXTENSION';
      if (bdStrategy === 'industry_target') {
        return isJobsRoot || isGmapsStep;
      }
      if (bdStrategy === 'hiring_signal') {
        return isLiSearchRoot || isGmapsStep;
      }
      if (bdStrategy === 'hybrid') {
        return isGmapsStep;
      }
      if (bdStrategy === 'local_business') {
        // Maps-only discovery — no LinkedIn or jobs roots.
        return isJobsRoot || isLiSearchRoot;
      }
      if (bdStrategy === 'local_hybrid') {
        // Maps + LinkedIn companies, no jobs.
        return isJobsRoot;
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

    const isGmapsSearch = (s: { tool: string; action: string }) =>
      s.tool === 'GMAPS_EXTENSION' && s.action === 'search_businesses';

    const hasExt = steps.some(isExtSearch);
    const hasJobs = steps.some(isJobsSearch);
    const hasGmaps = steps.some(isGmapsSearch);

    if (bdStrategy === 'industry_target') return hasExt && !hasJobs && !hasGmaps;
    if (bdStrategy === 'hiring_signal') return hasJobs && !hasExt && !hasGmaps;
    if (bdStrategy === 'hybrid') return hasExt && hasJobs && !hasGmaps;
    if (bdStrategy === 'local_business') return hasGmaps && !hasExt && !hasJobs;
    if (bdStrategy === 'local_hybrid') return hasGmaps && hasExt && !hasJobs;
    return true;
  }
}
