import { eq, and, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, masterAgents, type MasterAgent } from '../db/schema/index.js';
import { extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import {
  buildFitScoreSystemPrompt,
  buildFitScoreUserPrompt,
  type SellerProfile,
  type ScrapedCompany,
  type FitScoreVerdict,
  type FitScoreSignals,
} from '../prompts/buyer-fit-score.prompt.js';
import logger from '../utils/logger.js';

// ─── Continuous fit-score validation + aggregation ─────────────────────────

interface RawComponentScore {
  score: number | null;
  reasoning: string;
}

interface RawLLMResponse {
  component_scores: {
    is_real_business: RawComponentScore;
    icp_match: RawComponentScore;
    buyer_signal_strength: RawComponentScore;
    decision_maker_reachable: RawComponentScore;
  };
  key_person: FitScoreVerdict['key_person'];
  key_person_problem: FitScoreVerdict['key_person_problem'];
  signals: FitScoreSignals;
  fit_summary: string;
}

function isFiniteScoreOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

function isFiniteScore(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isValidLLMResponse(v: unknown): v is RawLLMResponse {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const cs = o.component_scores as Record<string, RawComponentScore> | undefined;
  if (!cs) return false;
  const required = ['is_real_business', 'icp_match', 'buyer_signal_strength', 'decision_maker_reachable'] as const;
  for (const k of required) {
    const c = cs[k];
    if (!c || typeof c !== 'object') return false;
    if (typeof c.reasoning !== 'string') return false;
    if (k === 'decision_maker_reachable') {
      if (!isFiniteScoreOrNull(c.score)) return false;
    } else {
      if (!isFiniteScore(c.score)) return false;
    }
  }
  if (typeof o.fit_summary !== 'string' || !o.fit_summary) return false;
  if (!o.signals || typeof o.signals !== 'object') return false;
  const s = o.signals as Record<string, unknown>;
  for (const k of ['hiring_signals', 'funding_signals', 'growth_signals', 'tech_signals', 'pain_hypotheses']) {
    if (!Array.isArray(s[k])) return false;
  }
  if (o.key_person !== null && (typeof o.key_person !== 'object' || Array.isArray(o.key_person))) return false;
  return true;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Compute the aggregate buyer_fit_score from the four components.
 * - decision_maker_reachable.score === null  →  redistribute its 10% across
 *   the other three components proportionally (40/30/20 → 40/0.9, 30/0.9, 20/0.9).
 * - decision_maker_reachable.score numeric   →  weighted sum at 40/30/20/10.
 *
 * Returns { score, dataCompleteness } so the caller can stamp the verdict.
 */
export function computeBuyerFitScore(components: RawLLMResponse['component_scores']): { score: number; dataCompleteness: 'partial' | 'full' } {
  const real = clamp(components.is_real_business.score ?? 0, 0, 100);
  const icp = clamp(components.icp_match.score ?? 0, 0, 100);
  const sig = clamp(components.buyer_signal_strength.score ?? 0, 0, 100);
  const dmr = components.decision_maker_reachable.score;

  if (dmr === null) {
    const score = Math.round((real * 0.40 + icp * 0.30 + sig * 0.20) / 0.90);
    return { score, dataCompleteness: 'partial' };
  }
  const dmrClamped = clamp(dmr, 0, 100);
  const score = Math.round(real * 0.40 + icp * 0.30 + sig * 0.20 + dmrClamped * 0.10);
  return { score, dataCompleteness: 'full' };
}

// ─── Citation grounding (drop hallucinated signals) ─────────────────────────

function buildInputCorpus(scraped: ScrapedCompany): string {
  const parts: string[] = [];
  if (scraped.description) parts.push(scraped.description);
  if (scraped.specialties?.length) parts.push(scraped.specialties.join(' '));
  if (scraped.rawMeta?.length) parts.push(scraped.rawMeta.join(' '));
  if (scraped.openPositions?.length) {
    for (const p of scraped.openPositions) {
      if (p?.title) parts.push(p.title);
      if (p?.description) parts.push(p.description);
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function dropUngroundedSignals(signals: FitScoreSignals, scraped: ScrapedCompany): { cleaned: FitScoreSignals; droppedCount: number } {
  const corpus = buildInputCorpus(scraped);
  if (!corpus) {
    // Nothing to verify against — pass-through. (Description-less company.)
    return { cleaned: signals, droppedCount: 0 };
  }
  let dropped = 0;
  const filterArr = <T extends { citation?: string }>(arr: T[] | undefined): T[] =>
    (arr ?? []).filter((s) => {
      if (!s?.citation) { dropped++; return false; }
      if (corpus.includes(s.citation.toLowerCase())) return true;
      dropped++;
      return false;
    });
  return {
    cleaned: {
      hiring_signals: filterArr(signals.hiring_signals),
      funding_signals: filterArr(signals.funding_signals),
      growth_signals: filterArr(signals.growth_signals),
      tech_signals: filterArr(signals.tech_signals),
      // pain_hypotheses use stated_fact, not citation — keep as-is for now.
      pain_hypotheses: signals.pain_hypotheses ?? [],
    },
    droppedCount: dropped,
  };
}

// ─── Seller profile derivation (unchanged from prior task) ──────────────────

function getSalesContext(masterAgent: MasterAgent): Record<string, unknown> | null {
  const cfg = (masterAgent.config ?? {}) as Record<string, unknown>;
  const pc = cfg.pipelineContext as Record<string, unknown> | undefined;
  if (pc && typeof pc === 'object' && pc.sales && typeof pc.sales === 'object') {
    return pc.sales as Record<string, unknown>;
  }
  return null;
}

function deriveBuyerFunctions(offering: string, useCase: string): string[] {
  const lower = offering.toLowerCase();
  if (/(\bai\b|engineering|tech|software|saas|developer|devtool|infra|data|ml\b|llm)/i.test(lower)) {
    return ['Engineering', 'AI', 'Data', 'Product', 'CTO'];
  }
  if (/(hr\b|recruit|talent|people|hiring)/i.test(lower)) {
    return ['People', 'Talent', 'HR'];
  }
  if (/(market|sales|growth|revenue|brand)/i.test(lower)) {
    return ['Marketing', 'Sales', 'Growth', 'Revenue'];
  }
  if (useCase === 'recruitment') {
    return ['CEO', 'Founder', 'Head of Engineering', 'CTO', 'VP Engineering'];
  }
  return ['CEO', 'Founder', 'VP/Head of relevant function'];
}

const DEFAULT_EXCLUSIONS = [
  'Trade associations, industry bodies, federations, chambers',
  'Meetups, communities, networking groups',
  'Conferences, event series, summit organizers',
  'News publications, magazines, podcasts, media outlets',
  'Universities, research labs, student groups, academic programs',
  'Books, courses, MOOCs, certifications',
  'Recruitment agencies and job boards (unless seller targets recruiters)',
  'Personal brands and solo influencers',
  'Government bodies, NGOs, non-profits (unless seller explicitly targets them)',
];

export function deriveSellerProfile(masterAgent: MasterAgent): SellerProfile {
  const cfg = (masterAgent.config ?? {}) as Record<string, unknown>;
  const explicit = cfg.sellerProfile as Partial<SellerProfile> | undefined;

  if (
    explicit &&
    typeof explicit.offering === 'string' &&
    Array.isArray(explicit.targetIndustries) &&
    typeof explicit.sizeMin === 'number' &&
    typeof explicit.sizeMax === 'number' &&
    typeof explicit.geography === 'string' &&
    Array.isArray(explicit.buyerFunctions) &&
    Array.isArray(explicit.exclusions)
  ) {
    logger.debug({ masterAgentId: masterAgent.id, path: 'explicit' }, 'deriveSellerProfile');
    return explicit as SellerProfile;
  }

  const sales = getSalesContext(masterAgent);
  if (sales) {
    const services = Array.isArray(sales.services) ? (sales.services as string[]) : [];
    const industries = Array.isArray(sales.industries)
      ? (sales.industries as string[])
      : Array.isArray((sales.salesStrategy as Record<string, unknown> | undefined)?.targetIndustries)
        ? ((sales.salesStrategy as Record<string, unknown>).targetIndustries as string[])
        : [];
    const regions = Array.isArray(sales.regions) ? (sales.regions as string[]) : [];

    const offering = services.length ? services.join(', ') : (masterAgent.mission || 'B2B services');
    const profile: SellerProfile = {
      offering,
      targetIndustries: industries,
      sizeMin: 20,
      sizeMax: 500,
      geography: regions.length ? regions.join(', ') : 'Global',
      buyerFunctions: deriveBuyerFunctions(offering, masterAgent.useCase),
      exclusions: DEFAULT_EXCLUSIONS,
    };
    logger.debug({ masterAgentId: masterAgent.id, path: 'pipelineContext' }, 'deriveSellerProfile');
    return profile;
  }

  const offering = masterAgent.mission || `${masterAgent.useCase} services`;
  const profile: SellerProfile = {
    offering,
    targetIndustries: [],
    sizeMin: 20,
    sizeMax: 500,
    geography: 'Global',
    buyerFunctions: deriveBuyerFunctions(offering, masterAgent.useCase),
    exclusions: DEFAULT_EXCLUSIONS,
  };
  logger.debug({ masterAgentId: masterAgent.id, path: 'default' }, 'deriveSellerProfile');
  return profile;
}

export function buildScrapedCompany(company: typeof companies.$inferSelect): ScrapedCompany {
  const raw = (company.rawData ?? {}) as Record<string, unknown>;
  const get = <T>(key: string): T | undefined => raw[key] as T | undefined;

  const headquartersField = get<unknown>('headquarters') ?? get<unknown>('hq') ?? get<unknown>('location');
  const headquarters =
    typeof headquartersField === 'string'
      ? headquartersField
      : headquartersField && typeof headquartersField === 'object' && 'city' in (headquartersField as Record<string, unknown>)
        ? String((headquartersField as Record<string, unknown>).city ?? '')
        : null;

  const peopleRaw = get<Array<Record<string, unknown>>>('people');
  const people = Array.isArray(peopleRaw)
    ? peopleRaw.map((p) => ({
        name: String(p.name ?? ''),
        title: typeof p.title === 'string' ? p.title : null,
        linkedinUrl: typeof p.linkedinUrl === 'string' ? p.linkedinUrl : null,
      })).filter((p) => p.name)
    : null;

  const positionsRaw = get<Array<Record<string, unknown>>>('openPositions') ?? get<Array<Record<string, unknown>>>('jobs');
  const openPositions = Array.isArray(positionsRaw)
    ? positionsRaw.map((j) => ({
        title: typeof j.title === 'string' ? j.title : undefined,
        location: typeof j.location === 'string' ? j.location : undefined,
        description: typeof j.description === 'string' ? j.description : undefined,
      }))
    : null;

  const specialtiesRaw = get<unknown>('specialties');
  const specialties = Array.isArray(specialtiesRaw)
    ? (specialtiesRaw as unknown[]).map(String)
    : typeof specialtiesRaw === 'string'
      ? specialtiesRaw.split(/,\s*/).filter(Boolean)
      : null;

  const rawMetaRaw = get<unknown>('rawMeta') ?? get<unknown>('metaItems');
  const rawMeta = Array.isArray(rawMetaRaw) ? (rawMetaRaw as unknown[]).map(String) : null;

  return {
    name: company.name,
    domain: company.domain ?? (typeof get<string>('website') === 'string' ? get<string>('website') ?? null : null),
    industry: company.industry ?? (typeof get<string>('industry') === 'string' ? get<string>('industry') ?? null : null),
    size: company.size ?? (typeof get<string>('size') === 'string' ? get<string>('size') ?? null : null),
    headquarters: headquarters || null,
    founded: typeof get<string | number>('founded') !== 'undefined' ? String(get<string | number>('founded')) : null,
    linkedinUrl: company.linkedinUrl ?? (typeof get<string>('linkedinUrl') === 'string' ? get<string>('linkedinUrl') ?? null : null),
    description: company.description ?? (typeof get<string>('description') === 'string' ? get<string>('description') ?? null : null),
    specialties,
    rawMeta,
    people,
    openPositions,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Score one company. Never rejects — every company gets a continuous
 * buyer_fit_score (0-100) plus a 4-component breakdown. Persists to
 * companies.rawData.fitScore. Old rawData.triage is left untouched for audit.
 */
export async function scoreCompany(params: {
  tenantId: string;
  companyId: string;
  masterAgentId: string;
  force?: boolean;
}): Promise<FitScoreVerdict | null> {
  const { tenantId, companyId, masterAgentId, force = false } = params;

  const loaded = await withTenant(tenantId, async (tx) => {
    const [company] = await tx.select().from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .limit(1);
    if (!company) return null;

    const [agent] = await tx.select().from(masterAgents)
      .where(and(eq(masterAgents.tenantId, tenantId), eq(masterAgents.id, masterAgentId)))
      .limit(1);
    if (!agent) return null;

    return { company, agent };
  });

  if (!loaded) {
    logger.debug({ tenantId, companyId, masterAgentId }, 'scoreCompany: company or agent not found');
    return null;
  }

  // Idempotency — return cached verdict unless force.
  const existingRaw = (loaded.company.rawData ?? {}) as Record<string, unknown>;
  const existingFit = existingRaw.fitScore as FitScoreVerdict | undefined;
  if (existingFit && !force) {
    return existingFit;
  }

  const seller = deriveSellerProfile(loaded.agent);
  const scraped = buildScrapedCompany(loaded.company);

  let parsed: unknown;
  try {
    parsed = await extractJSON<unknown>(
      tenantId,
      [
        { role: 'system', content: buildFitScoreSystemPrompt() },
        { role: 'user', content: buildFitScoreUserPrompt(seller, scraped) },
      ],
      2,
      { model: SMART_MODEL, temperature: 0.1 },
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), companyId }, 'scoreCompany: LLM call failed');
    return null;
  }

  if (!isValidLLMResponse(parsed)) {
    logger.warn({ companyId, parsed }, 'scoreCompany: invalid response shape from LLM');
    return null;
  }

  // Drop any signal whose citation is not a substring of the scraped input.
  const { cleaned: cleanedSignals, droppedCount } = dropUngroundedSignals(parsed.signals, scraped);
  if (droppedCount > 0) {
    logger.info({ companyId, droppedCount }, 'scoreCompany: dropped ungrounded signals');
  }

  // If signals are empty after grounding check, cap buyer_signal_strength ≤ 30.
  const totalSignals =
    cleanedSignals.hiring_signals.length +
    cleanedSignals.funding_signals.length +
    cleanedSignals.growth_signals.length +
    cleanedSignals.tech_signals.length;
  const components = { ...parsed.component_scores };
  if (totalSignals === 0 && (components.buyer_signal_strength.score ?? 0) > 30) {
    components.buyer_signal_strength = {
      score: 30,
      reasoning: components.buyer_signal_strength.reasoning + ' (capped at 30 — no grounded signals)',
    };
  }

  const { score, dataCompleteness } = computeBuyerFitScore(components);

  // Build the verdict. The component types match RawComponentScore for the
  // optional case (decision_maker_reachable can carry null score); for the
  // three required components we coerce to non-null.
  const verdict: FitScoreVerdict = {
    buyer_fit_score: score,
    component_scores: {
      is_real_business: { score: components.is_real_business.score ?? 0, reasoning: components.is_real_business.reasoning },
      icp_match: { score: components.icp_match.score ?? 0, reasoning: components.icp_match.reasoning },
      buyer_signal_strength: { score: components.buyer_signal_strength.score ?? 0, reasoning: components.buyer_signal_strength.reasoning },
      decision_maker_reachable: { score: components.decision_maker_reachable.score, reasoning: components.decision_maker_reachable.reasoning },
    },
    key_person: parsed.key_person,
    key_person_problem: parsed.key_person_problem,
    signals: cleanedSignals,
    fit_summary: parsed.fit_summary,
    scored_at: new Date().toISOString(),
    model_used: SMART_MODEL,
    data_completeness: dataCompleteness,
  };

  await withTenant(tenantId, async (tx) => {
    await tx.update(companies).set({
      rawData: { ...existingRaw, fitScore: verdict },
      updatedAt: new Date(),
    }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  });

  logger.info(
    { companyId, name: loaded.company.name, score, dataCompleteness, droppedSignals: droppedCount },
    'company scored',
  );

  return verdict;
}

export async function batchScoreCompanies(params: {
  tenantId: string;
  masterAgentId: string;
  companyIds?: string[];
  force?: boolean;
  concurrency?: number;
}): Promise<{
  scored: number;
  errors: number;
  distribution: Record<'80-100' | '60-79' | '40-59' | '20-39' | '0-19', number>;
  avgScore: number;
  fullDataCount: number;
  partialDataCount: number;
}> {
  const { tenantId, masterAgentId, companyIds, force = false, concurrency = 3 } = params;

  let targets: string[];
  if (companyIds && companyIds.length) {
    targets = companyIds;
  } else {
    const rows = await withTenant(tenantId, async (tx) => {
      const filter = force
        ? and(eq(companies.tenantId, tenantId), eq(companies.masterAgentId, masterAgentId))
        : and(
            eq(companies.tenantId, tenantId),
            eq(companies.masterAgentId, masterAgentId),
            sql`(${companies.rawData} -> 'fitScore') IS NULL`,
          );
      return tx.select({ id: companies.id }).from(companies).where(filter);
    });
    targets = rows.map((r) => r.id);
  }

  const counts: { scored: number; errors: number; sum: number; full: number; partial: number; dist: Record<'80-100' | '60-79' | '40-59' | '20-39' | '0-19', number> } = {
    scored: 0,
    errors: 0,
    sum: 0,
    full: 0,
    partial: 0,
    dist: { '80-100': 0, '60-79': 0, '40-59': 0, '20-39': 0, '0-19': 0 },
  };
  const chunkSize = Math.max(1, concurrency);

  for (let i = 0; i < targets.length; i += chunkSize) {
    const chunk = targets.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((id) => scoreCompany({ tenantId, companyId: id, masterAgentId, force })),
    );
    for (const r of results) {
      if (r.status === 'rejected' || r.value === null) {
        counts.errors += 1;
        continue;
      }
      counts.scored += 1;
      counts.sum += r.value.buyer_fit_score;
      if (r.value.data_completeness === 'full') counts.full += 1;
      else counts.partial += 1;
      const s = r.value.buyer_fit_score;
      if (s >= 80) counts.dist['80-100'] += 1;
      else if (s >= 60) counts.dist['60-79'] += 1;
      else if (s >= 40) counts.dist['40-59'] += 1;
      else if (s >= 20) counts.dist['20-39'] += 1;
      else counts.dist['0-19'] += 1;
    }
    logger.info(
      { masterAgentId, processed: Math.min(i + chunkSize, targets.length), total: targets.length, scored: counts.scored, errors: counts.errors },
      'batchScoreCompanies progress',
    );
  }

  const avgScore = counts.scored > 0 ? Math.round(counts.sum / counts.scored) : 0;
  logger.info(
    { masterAgentId, scored: counts.scored, distribution: counts.dist, avgScore, fullDataCount: counts.full, partialDataCount: counts.partial },
    'fit score batch complete',
  );
  return {
    scored: counts.scored,
    errors: counts.errors,
    distribution: counts.dist,
    avgScore,
    fullDataCount: counts.full,
    partialDataCount: counts.partial,
  };
}
