import { eq, and, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, masterAgents, type MasterAgent } from '../db/schema/index.js';
import { extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import {
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  type SellerProfile,
  type ScrapedCompany,
  type TriageVerdict,
} from '../prompts/company-triage.prompt.js';
import logger from '../utils/logger.js';

const VALID_VERDICTS = new Set(['accept', 'reject', 'review']);

function isValidVerdict(v: unknown): v is TriageVerdict {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.verdict !== 'string' || !VALID_VERDICTS.has(o.verdict)) return false;
  if (typeof o.fit_score !== 'number' || !Number.isFinite(o.fit_score)) return false;
  if (typeof o.fit_score_explanation !== 'string') return false;
  if (!o.signals || typeof o.signals !== 'object') return false;
  const s = o.signals as Record<string, unknown>;
  for (const k of ['hiring_signals', 'funding_signals', 'growth_signals', 'tech_signals', 'pain_hypotheses']) {
    if (!Array.isArray(s[k])) return false;
  }
  if (o.key_person !== null && (typeof o.key_person !== 'object' || Array.isArray(o.key_person))) return false;
  return true;
}

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

function buildScrapedCompany(company: typeof companies.$inferSelect): ScrapedCompany {
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

export async function triageCompany(params: {
  tenantId: string;
  companyId: string;
  masterAgentId: string;
  force?: boolean;
}): Promise<TriageVerdict | null> {
  const { tenantId, companyId, masterAgentId, force = false } = params;

  // 1. Load company + master agent in a tenant-scoped transaction.
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
    logger.debug({ tenantId, companyId, masterAgentId }, 'triageCompany: company or agent not found');
    return null;
  }

  // 2. Idempotency — return cached verdict unless force.
  const existingRaw = (loaded.company.rawData ?? {}) as Record<string, unknown>;
  const existingTriage = existingRaw.triage as TriageVerdict | undefined;
  if (existingTriage && !force) {
    return existingTriage;
  }

  // 3. Build prompts.
  const seller = deriveSellerProfile(loaded.agent);
  const scraped = buildScrapedCompany(loaded.company);

  // 4. Call LLM (outside transaction — network I/O).
  let parsed: unknown;
  try {
    parsed = await extractJSON<unknown>(
      tenantId,
      [
        { role: 'system', content: buildTriageSystemPrompt() },
        { role: 'user', content: buildTriageUserPrompt(seller, scraped) },
      ],
      2,
      { model: SMART_MODEL, temperature: 0.1 },
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), companyId }, 'triageCompany: LLM call failed');
    return null;
  }

  if (!isValidVerdict(parsed)) {
    logger.warn({ companyId, parsed }, 'triageCompany: invalid verdict shape from LLM');
    return null;
  }

  const verdict: TriageVerdict = {
    ...parsed,
    triaged_at: new Date().toISOString(),
    model_used: SMART_MODEL,
  };

  // 5. Persist verdict (merge into rawData).
  await withTenant(tenantId, async (tx) => {
    await tx.update(companies).set({
      rawData: { ...existingRaw, triage: verdict },
      updatedAt: new Date(),
    }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  });

  logger.info(
    { companyId, name: loaded.company.name, verdict: verdict.verdict, fit_score: verdict.fit_score },
    'company triaged',
  );

  return verdict;
}

export async function batchTriageCompanies(params: {
  tenantId: string;
  masterAgentId: string;
  companyIds?: string[];
  force?: boolean;
  concurrency?: number;
}): Promise<{ triaged: number; accepted: number; rejected: number; reviewed: number; errors: number }> {
  const { tenantId, masterAgentId, companyIds, force = false, concurrency = 3 } = params;

  // Resolve target list.
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
            sql`(${companies.rawData} -> 'triage') IS NULL`,
          );
      return tx.select({ id: companies.id }).from(companies).where(filter);
    });
    targets = rows.map((r) => r.id);
  }

  const counts = { triaged: 0, accepted: 0, rejected: 0, reviewed: 0, errors: 0 };
  const chunkSize = Math.max(1, concurrency);

  for (let i = 0; i < targets.length; i += chunkSize) {
    const chunk = targets.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((id) => triageCompany({ tenantId, companyId: id, masterAgentId, force })),
    );
    for (const r of results) {
      if (r.status === 'rejected' || r.value === null) {
        counts.errors += 1;
        continue;
      }
      counts.triaged += 1;
      if (r.value.verdict === 'accept') counts.accepted += 1;
      else if (r.value.verdict === 'reject') counts.rejected += 1;
      else counts.reviewed += 1;
    }
    logger.info(
      { masterAgentId, processed: Math.min(i + chunkSize, targets.length), total: targets.length, ...counts },
      'batchTriageCompanies progress',
    );
  }

  return counts;
}
