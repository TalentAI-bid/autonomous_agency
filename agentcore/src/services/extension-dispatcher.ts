import { eq, and, asc, desc, gt, isNull, lte, or, exists, inArray, sql } from 'drizzle-orm';
import { db, withTenant } from '../config/database.js';
import { companies, contacts, extensionSessions, extensionTasks, masterAgents } from '../db/schema/index.js';
import { userTenants } from '../db/schema/user-tenants.js';
import type { ExtensionTask } from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import { dispatchJob } from './queue.service.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { enqueueFitScore } from '../queues/fit-score-queues.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { logPipelineError, formatRateLimitMessage } from '../utils/pipeline-error.js';
import { logEvent } from './timeline.service.js';
import { ingestGmapsBusiness } from './gmaps-lead.service.js';
import type { GmapsBusinessInput } from './gmaps-lead.service.js';
import { scrape } from '../tools/crawl4ai.tool.js';
import { prospectStages } from '../db/schema/index.js';

// ─── Rate limits (server-authoritative; client mirrors these) ──────────────
//
// Quotas live on the per-user extension_sessions row (dailyTasksCount JSONB).
// After multi-workspace, a user has exactly one extension session regardless
// of how many tenants they're a member of, so the cap is effectively
// per-user — i.e. per LinkedIn account. 80 search-tasks/day is one quota
// across ALL the user's workspaces, not per-workspace; this matches reality
// because the LinkedIn account is shared.

export type ExtensionSite = 'linkedin' | 'gmaps' | 'crunchbase' | 'google';
export type ExtensionTaskType =
  | 'search_companies'
  | 'fetch_company'
  | 'fetch_company_info'
  | 'fetch_company_team'
  | 'fetch_profile'
  | 'linkedin_message'
  | 'linkedin_connect'
  | 'search_people'
  | 'search_businesses'
  | 'fetch_business'
  | 'search_serp';

export const EXTENSION_SITE_LIMITS = {
  linkedin: {
    // Mirrors extension/lib/rate-limiter.js. minDelayMs is enforced
    // client-side (server only enforces dailyCap); kept in sync here as
    // documentation. Caps raised after the prior 10-search/100-fetch values
    // bottlenecked multi-agent demo runs (one agent burning 10 starved every
    // other agent on the same session for 24h). 80 search-tasks/day per
    // session covers ~8 strategist runs of 10 search steps each;
    // 400 fetch-tasks/day supports ~200 enriched companies per session.
    search_companies: { dailyCap: 80, minDelayMs: 4000 },
    fetch_company: { dailyCap: 100, minDelayMs: 8000 },
    // Split adapters get the same cap each — together they double the rate
    // of LinkedIn page hits per company. minDelayMs stays at 8s per call so
    // the per-tab pacing matches the legacy combined adapter.
    fetch_company_info: { dailyCap: 400, minDelayMs: 8000 },
    fetch_company_team: { dailyCap: 400, minDelayMs: 8000 },
    // Single-person profile re-scrape (user-triggered contact correction).
    // Profile-page views are the most sensitive LinkedIn surface, so keep a
    // conservative cap and the same 8s pacing as the team fetch.
    fetch_profile: { dailyCap: 100, minDelayMs: 8000 },
    // Review-then-send outreach: user-initiated, one at a time. Conservative.
    linkedin_message: { dailyCap: 50, minDelayMs: 5000 },
    linkedin_connect: { dailyCap: 50, minDelayMs: 5000 },
    // Global people search — same surface as company search but conservative,
    // since people-result pages are more aggressively throttled by LinkedIn.
    search_people: { dailyCap: 80, minDelayMs: 4000 },
  },
  gmaps: {
    // Free plan: 200 Maps searches/day. Dispatched in batches of 20 by the
    // list_verification path (see master-agent.ts) so the day's quota spreads
    // across ~10 batches rather than firing at once.
    search_businesses: { dailyCap: 200, minDelayMs: 2000 },
    fetch_business: { dailyCap: 200, minDelayMs: 2000 },
  },
  crunchbase: {
    search_companies: { dailyCap: 10, minDelayMs: 5000 },
    fetch_company: { dailyCap: 50, minDelayMs: 5000 },
  },
  google: {
    // Google web-search (SERP) scrape for the web_search discovery strategy.
    // Google CAPTCHAs aggressively on velocity even in a real browser session,
    // so this is deliberately conservative: ~40 dork searches/day, 6s apart.
    // The result page returns many URLs per search, so a handful of dorks
    // yields plenty of leads. A CAPTCHA reuses the blocked_by_popup re-pend.
    search_serp: { dailyCap: 40, minDelayMs: 6000 },
  },
} as const;

function getLimit(site: ExtensionSite, type: ExtensionTaskType): { dailyCap: number; minDelayMs: number } | undefined {
  const siteLimits = EXTENSION_SITE_LIMITS[site] as Record<string, { dailyCap: number; minDelayMs: number } | undefined>;
  return siteLimits?.[type];
}

// ─── Defensive enqueue guard ────────────────────────────────────────────────
// fetch_company_info / fetch_company_team REQUIRE a per-company linkedinUrl
// in params. Standalone strategist steps without one fail later inside the
// extension with `invalid linkedinUrl=undefined`, polluting metrics. This
// guard catches the bug at the enqueue boundary and logs the call site via
// stack trace so we can find whoever's calling without a URL.
function looksLikeMissingLinkedInUrl(
  type: ExtensionTaskType,
  params: Record<string, unknown> | undefined,
): boolean {
  const urlRequired = type === 'fetch_company_info' || type === 'fetch_company_team' || type === 'fetch_profile'
    || type === 'linkedin_message' || type === 'linkedin_connect';
  if (!urlRequired) return false;
  const url = params?.linkedinUrl;
  return typeof url !== 'string' || url.trim().length === 0;
}

function rejectMissingLinkedInUrl(
  callsite: 'single' | 'batch',
  task: { tenantId: string; masterAgentId?: string | null; site: ExtensionSite; type: ExtensionTaskType; params: Record<string, unknown> | undefined },
): void {
  logger.error(
    {
      callsite,
      tenantId: task.tenantId,
      masterAgentId: task.masterAgentId ?? null,
      site: task.site,
      type: task.type,
      paramKeys: Object.keys(task.params ?? {}),
      linkedinUrl: task.params?.linkedinUrl,
      stack: new Error('linkedinUrl_missing_at_enqueue').stack,
    },
    'CRITICAL: enqueueing fetch_company_info/_team/_profile task with no linkedinUrl — bug somewhere',
  );
}

// ─── Strict list-verification helpers ────────────────────────────────────────
// Used by the `list_verification` bdStrategy. When a search task carries
// `params.strictMatch = { companyId, name }`, the ingestion picks the SINGLE
// best name-match from the results and attaches it to the pre-created company
// row — never creating the other (decoy) results. No confident match → fail
// loud (rawData.*NotFound) rather than fabricate.

export interface StrictMatch {
  companyId: string;
  name: string;
}

/** Lowercase, strip accents, drop legal suffixes, collapse to single spaces. */
export function normalizeCompanyName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents: Société → societe
    .replace(/\b(inc|llc|ltd|limited|sa|sarl|sas|spa|srl|gmbh|ag|bv|nv|corp|co|company|group|holding|holdings|sa\.?r\.?l)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** 1 = exact, 0.85 = substring, else token Jaccard. */
export function nameMatchScore(a: string, b: string): number {
  const na = normalizeCompanyName(a);
  const nb = normalizeCompanyName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const sa = new Set(na.split(' ').filter(Boolean));
  const sb = new Set(nb.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  const inter = [...sa].filter((t) => sb.has(t)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

export const STRICT_NAME_MATCH_THRESHOLD = 0.8;

/**
 * Pick the single best-matching candidate by company name, or null when the
 * best score is below the confidence threshold.
 */
export function pickBestNameMatch<T extends Record<string, unknown>>(
  targetName: string,
  candidates: T[],
  getName: (c: T) => string,
): { match: T; score: number } | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = nameMatchScore(targetName, getName(c));
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best && bestScore >= STRICT_NAME_MATCH_THRESHOLD) {
    return { match: best, score: bestScore };
  }
  return null;
}

/**
 * Crawl4AI must NEVER be pointed at LinkedIn or Google Maps — those are
 * scraped only through the authenticated browser extension. Returns false for
 * those domains (and for anything that isn't a parseable http(s) URL).
 */
export function isCrawlable(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host.includes('linkedin.com')) return false;
    if (host.includes('maps.google') || host === 'goo.gl' || host.includes('maps.app.goo.gl')) return false;
    if (/(^|\.)google\.[a-z.]+$/.test(host) && /\/maps/.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Merge a small set of flags into companies.rawData for a row by id. */
export async function markRawDataFlag(
  tenantId: string,
  companyId: string,
  flags: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ rawData: companies.rawData })
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
        .limit(1);
      const existing = (row?.rawData as Record<string, unknown> | null) ?? {};
      await tx
        .update(companies)
        .set({ rawData: { ...existing, ...flags }, updatedAt: new Date() })
        .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)));
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId, flags: Object.keys(flags) },
      'markRawDataFlag failed (non-fatal)',
    );
  }
}

// Crawl markdown can be large; cap what we persist into the JSONB row.
const CRAWL_MARKDOWN_CAP = 40000;

/**
 * Crawl a URL with Crawl4AI and store the markdown under
 * `companies.rawData.crawl[kind]`. Used by the list_verification path to crawl
 * (a) the source URL provided in the uploaded list, and (b) the real website
 * discovered via LinkedIn fetch_company_info. NEVER crawls LinkedIn/Maps
 * (guarded by isCrawlable). Read-merge-write preserves sibling crawl keys and
 * the rest of rawData. Returns true when non-empty markdown was captured.
 */
export async function crawlAndStoreForCompany(
  tenantId: string,
  companyId: string,
  kind: 'sourceUrl' | 'website',
  url: string,
): Promise<boolean> {
  if (!url || !isCrawlable(url)) return false;
  let markdown = '';
  try {
    markdown = await scrape(tenantId, url);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId, kind, url },
      'list_verification: crawl4ai scrape failed (non-fatal)',
    );
  }
  const record = {
    url,
    markdownLength: markdown.length,
    fetchedAt: new Date().toISOString(),
    markdown: markdown.slice(0, CRAWL_MARKDOWN_CAP),
    ...(markdown.length > CRAWL_MARKDOWN_CAP ? { truncated: true } : {}),
  };
  try {
    await withTenant(tenantId, async (tx) => {
      const [row] = await tx
        .select({ rawData: companies.rawData })
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
        .limit(1);
      const existing = (row?.rawData as Record<string, unknown> | null) ?? {};
      const crawl = (existing.crawl as Record<string, unknown> | undefined) ?? {};
      await tx
        .update(companies)
        .set({
          rawData: { ...existing, crawl: { ...crawl, [kind]: record } },
          updatedAt: new Date(),
        })
        .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)));
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId, kind },
      'list_verification: storing crawl result failed (non-fatal)',
    );
  }
  return markdown.length > 0;
}

/**
 * Map a raw Google Maps business object (from a search card or a place-detail
 * fetch) into the GmapsBusinessInput shape `ingestGmapsBusiness` expects.
 * `nameOverride` lets the strict list-verification path force the name onto
 * the pre-created user_list company row (dedup is by exact name / domain).
 */
function gmapsBusinessToInput(
  b: Record<string, unknown>,
  params: Record<string, unknown>,
  isDetail: boolean,
  nameOverride?: string,
  knownCompanyId?: string,
): GmapsBusinessInput {
  return {
    name: (nameOverride ?? String(b.name ?? '')).trim(),
    knownCompanyId,
    category: typeof b.category === 'string' ? b.category : undefined,
    address: typeof b.address === 'string' ? b.address : undefined,
    phone: typeof b.phone === 'string' ? b.phone : undefined,
    website: typeof b.website === 'string' ? b.website : undefined,
    rating: typeof b.rating === 'number' ? b.rating : null,
    reviewCount: typeof b.reviewCount === 'number' ? b.reviewCount : null,
    reviewsCount: typeof b.reviewsCount === 'number' ? b.reviewsCount : null,
    mapsUrl: typeof b.mapsUrl === 'string' ? b.mapsUrl : undefined,
    searchQuery: typeof params.query === 'string' ? params.query : undefined,
    location: typeof params.location === 'string' ? params.location : undefined,
    hours: (typeof b.hours === 'string' || (b.hours && typeof b.hours === 'object'))
      ? (b.hours as string | Record<string, string>) : undefined,
    priceLevel: typeof b.priceLevel === 'string' ? b.priceLevel : undefined,
    description: typeof b.description === 'string' ? b.description : undefined,
    serviceOptions: Array.isArray(b.serviceOptions) ? (b.serviceOptions as string[]) : undefined,
    plusCode: typeof b.plusCode === 'string' ? b.plusCode : undefined,
    coordinates: (b.coordinates && typeof b.coordinates === 'object')
      ? (b.coordinates as { lat: number; lng: number }) : undefined,
    menuLink: typeof b.menuLink === 'string' ? b.menuLink : undefined,
    photoUrls: Array.isArray(b.photoUrls) ? (b.photoUrls as string[]) : undefined,
    pricePerPerson: typeof b.pricePerPerson === 'string' ? b.pricePerPerson : undefined,
    directionsUrl: typeof b.directionsUrl === 'string' ? b.directionsUrl : undefined,
    reviewsHtml: typeof b.reviewsHtml === 'string' ? b.reviewsHtml : undefined,
    ratingDistribution: Array.isArray(b.ratingDistribution)
      ? (b.ratingDistribution as Array<{ label: string }>) : undefined,
    aboutHtml: typeof b.aboutHtml === 'string' ? b.aboutHtml : undefined,
    detailFetched: isDetail || b.detailFetched === true,
  };
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

export async function enqueueExtensionTask(params: {
  tenantId: string;
  masterAgentId?: string;
  site: ExtensionSite;
  type: ExtensionTaskType;
  params: Record<string, unknown>;
  priority?: number;
  dispatchAfter?: Date;
}): Promise<{ taskId: string }> {
  if (looksLikeMissingLinkedInUrl(params.type, params.params)) {
    rejectMissingLinkedInUrl('single', {
      tenantId: params.tenantId,
      masterAgentId: params.masterAgentId ?? null,
      site: params.site,
      type: params.type,
      params: params.params,
    });
    throw new Error(`enqueueExtensionTask: ${params.type} requires params.linkedinUrl`);
  }

  const [row] = await withTenant(params.tenantId, async (tx) => {
    return tx
      .insert(extensionTasks)
      .values({
        tenantId: params.tenantId,
        masterAgentId: params.masterAgentId,
        site: params.site,
        type: params.type,
        params: params.params ?? {},
        priority: params.priority ?? 5,
        status: 'pending',
        ...(params.dispatchAfter ? { dispatchAfter: params.dispatchAfter } : {}),
      })
      .returning({ id: extensionTasks.id });
  });
  const taskId = row!.id;

  // Fire-and-forget immediate dispatch attempt (don't block the caller).
  // tryDispatch internally bails when dispatchAfter > now; the periodic
  // scheduled-drainer wakes the task up later.
  tryDispatch(params.tenantId, taskId).catch((err) => {
    logger.debug({ err, taskId }, 'Extension task immediate dispatch failed (will retry on reconnect)');
  });

  return { taskId };
}

// ─── GMaps enrichment for existing companies (dashboard button) ──────────────

const GMAPS_ENRICH_BATCH_SIZE = 20;
const GMAPS_ENRICH_BATCH_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h — spread 200/day quota

/**
 * Enqueue one GMaps `search_businesses` task per company (search by name →
 * phone/website/detail → generic-email crawl), with a Google-dork fallback when
 * Maps has no confident match. Backs the "Enrich via Google Maps" button on an
 * agent: it takes the agent's ALREADY-discovered companies and fills in
 * phone/website/generic email WITHOUT converting the agent into a list-bounded
 * one (its config is untouched — this is a one-shot enrichment, not a mode
 * switch). Batched 20 per ~2h to respect the 200/day free-plan quota;
 * `userInitiated` lets the tasks dispatch even while the agent is paused.
 */
export async function dispatchGmapsEnrichForCompanies(
  tenantId: string,
  masterAgentId: string,
  companies: Array<{ companyId: string; name: string }>,
  opts: { region?: string; userInitiated?: boolean } = {},
): Promise<number> {
  const region = (opts.region ?? '').trim();
  const now = Date.now();
  let enqueued = 0;
  for (let i = 0; i < companies.length; i++) {
    const entry = companies[i]!;
    const name = entry.name?.trim();
    if (!entry.companyId || !name) continue;
    const batchIndex = Math.floor(i / GMAPS_ENRICH_BATCH_SIZE);
    const dispatchAfter = new Date(now + batchIndex * GMAPS_ENRICH_BATCH_INTERVAL_MS);
    try {
      await enqueueExtensionTask({
        tenantId,
        masterAgentId,
        site: 'gmaps',
        type: 'search_businesses',
        params: {
          query: name,
          limit: 5,
          strictMatch: { companyId: entry.companyId, name },
          dorkFallback: true,
          region,
          ...(opts.userInitiated ? { userInitiated: true } : {}),
        },
        priority: 10,
        dispatchAfter,
      });
      enqueued++;
    } catch (err) {
      logger.warn({ err, masterAgentId, companyId: entry.companyId }, 'gmaps-enrich: enqueue failed');
    }
  }
  return enqueued;
}

// ─── Bulk batched enqueue ───────────────────────────────────────────────────

interface BatchTaskInput {
  masterAgentId?: string;
  site: ExtensionSite;
  type: ExtensionTaskType;
  params: Record<string, unknown>;
  priority?: number;
}

/**
 * Insert N tasks at once and stagger their `dispatchAfter` so they are
 * released to the extension in batches of `batchSize` separated by
 * `batchCooldownMs`. Defaults: 10 tasks per batch, 60s cooldown.
 *
 * Rationale: the LinkedIn Jobs scrape can find 100+ companies, and the
 * `search_companies` extension task can return a similar volume. Inserting
 * all of them with `dispatch_after = now()` queued them into the extension
 * back-to-back; the rate-limiter on the extension side serialised them but
 * piled up a long backlog of `pending` rows and reportedly tripped LinkedIn
 * rate-limits on long runs. Server-side staggering makes the queue visibly
 * paced and lets `pause` / `cancel` actually stop the chain mid-fan-out.
 *
 * Tasks within the same batch share the same `dispatchAfter` timestamp;
 * the extension's per-task minDelay still serialises them client-side.
 */
/**
 * Fan out company enrichment to the MODERN split tasks: one `fetch_company_info`
 * per company + one `fetch_company_team` per `teamRoleKeyword`. This makes the
 * extension load the simple `/company/<slug>/people/?keywords=<kw>` page — never
 * the legacy combined `fetch_company` task, which clicks through to LinkedIn's
 * canned `/search/results/people/?currentCompany=…` search.
 *
 * Shared by the `search_companies` auto-chain and the LinkedIn-Jobs (hiring
 * signal) discovery path so both behave identically.
 */
export async function enqueueCompanyEnrichmentFanout(
  tenantId: string,
  masterAgentId: string | undefined,
  companies: Array<{ linkedinUrl: string; companyId?: string }>,
  opts: { crawlWebsite?: boolean } = {},
): Promise<void> {
  if (companies.length === 0) return;

  // Keywords come from the strategist's saved sales-strategy
  // (config.salesStrategy.teamRoleKeywords); legacy chat-set keywords on
  // config.teamRoleKeywords are a fallback for agents whose strategy hasn't
  // been regenerated yet. If neither is set, the team fetch is skipped — the
  // user must re-run the strategist to populate them.
  let teamKeywords: string[] = [];
  if (masterAgentId) {
    try {
      const [agentRow] = await withTenant(tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config })
          .from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)))
          .limit(1);
      });
      const cfg = agentRow?.config as Record<string, unknown> | undefined;
      const strategyRaw = (cfg?.salesStrategy as Record<string, unknown> | undefined)?.teamRoleKeywords;
      const legacyRaw = cfg?.teamRoleKeywords;
      const pickFrom = (raw: unknown): string[] =>
        Array.isArray(raw)
          ? raw
              .filter((k): k is string => typeof k === 'string')
              .map((s) => s.trim())
              .filter((s) => s.length > 0 && s.length <= 60)
          : [];
      const strategyKw = pickFrom(strategyRaw);
      const legacyKw = pickFrom(legacyRaw);
      teamKeywords = strategyKw.length > 0 ? strategyKw : legacyKw;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), masterAgentId },
        'Failed to load teamRoleKeywords for fanout — skipping team fetch',
      );
    }
  }

  const fanoutTasks: BatchTaskInput[] = [];
  for (const c of companies) {
    fanoutTasks.push({
      masterAgentId,
      site: 'linkedin',
      type: 'fetch_company_info',
      params: { linkedinUrl: c.linkedinUrl, companyId: c.companyId, ...(opts.crawlWebsite ? { crawlWebsite: true } : {}) },
      priority: 3,
    });
    for (const keyword of teamKeywords) {
      fanoutTasks.push({
        masterAgentId,
        site: 'linkedin',
        type: 'fetch_company_team',
        params: { linkedinUrl: c.linkedinUrl, companyId: c.companyId, keyword },
        priority: 3,
      });
    }
  }
  if (teamKeywords.length === 0) {
    logger.info(
      { masterAgentId, companyCount: companies.length },
      'team_fetch_skipped_no_keywords — strategist did not emit config.salesStrategy.teamRoleKeywords; re-run /regenerate-strategy to populate',
    );
  }
  await enqueueExtensionTaskBatch(tenantId, fanoutTasks);
}

export async function enqueueExtensionTaskBatch(
  tenantId: string,
  tasks: BatchTaskInput[],
  opts: { batchSize?: number; batchCooldownMs?: number; firstBatchDelayMs?: number } = {},
): Promise<{ taskIds: string[]; batches: number }> {
  if (tasks.length === 0) return { taskIds: [], batches: 0 };

  // Filter out fetch_company_info/_team rows missing linkedinUrl. These
  // would otherwise reach the extension and fail with `invalid linkedinUrl=undefined`,
  // burning a daily-cap slot for nothing. Log each rejection so we can find
  // the upstream code path that's producing them.
  const validTasks = tasks.filter((t) => {
    if (looksLikeMissingLinkedInUrl(t.type, t.params)) {
      rejectMissingLinkedInUrl('batch', {
        tenantId,
        masterAgentId: t.masterAgentId ?? null,
        site: t.site,
        type: t.type,
        params: t.params,
      });
      return false;
    }
    return true;
  });
  if (validTasks.length === 0) return { taskIds: [], batches: 0 };

  const batchSize = opts.batchSize ?? 10;
  const batchCooldownMs = opts.batchCooldownMs ?? 60_000;
  const firstBatchDelayMs = opts.firstBatchDelayMs ?? 0;

  const now = Date.now();
  const values = validTasks.map((t, idx) => {
    const batchIdx = Math.floor(idx / batchSize);
    const dispatchAfter = new Date(now + firstBatchDelayMs + batchIdx * batchCooldownMs);
    return {
      tenantId,
      masterAgentId: t.masterAgentId,
      site: t.site,
      type: t.type,
      params: t.params ?? {},
      priority: t.priority ?? 5,
      status: 'pending' as const,
      dispatchAfter,
    };
  });

  const inserted = await withTenant(tenantId, async (tx) => {
    return tx.insert(extensionTasks).values(values).returning({ id: extensionTasks.id });
  });

  const taskIds = inserted.map((r) => r.id);
  const batches = Math.ceil(validTasks.length / batchSize);
  const rejected = tasks.length - validTasks.length;

  logger.info(
    { tenantId, requested: tasks.length, count: validTasks.length, rejected, batches, batchSize, batchCooldownMs },
    'Enqueued extension tasks in batches',
  );

  // Fire-and-forget dispatch on the first batch only — later batches wake up
  // via the scheduled drainer when their dispatchAfter passes.
  for (let i = 0; i < Math.min(batchSize, taskIds.length); i++) {
    tryDispatch(tenantId, taskIds[i]!).catch((err) => {
      logger.debug({ err, taskId: taskIds[i] }, 'Batch first-wave dispatch attempt failed');
    });
  }

  return { taskIds, batches };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function tryDispatch(tenantId: string, taskId: string): Promise<boolean> {
  // Load the task — we always need a fresh row before considering dispatch.
  const task = await withTenant(tenantId, async (tx) => {
    const [t] = await tx
      .select()
      .from(extensionTasks)
      .where(and(eq(extensionTasks.id, taskId), eq(extensionTasks.tenantId, tenantId)))
      .limit(1);
    if (!t || t.status !== 'pending') return null;
    // Skip silently if the task is scheduled for the future — the periodic
    // re-drainer will pick it up at its dispatchAfter timestamp.
    if (t.dispatchAfter && t.dispatchAfter.getTime() > Date.now()) return null;
    return t;
  });
  if (!task) return false;

  // User-initiated one-off tasks (a dashboard button click: refetch team/info,
  // re-scrape profile, stage a LinkedIn message) must run NOW regardless of the
  // owning agent's automated-run state. They carry the agent's id only for
  // attribution, so without this flag the paused/quota gate below would swallow
  // them — the user clicks "Team" and nothing happens because the background
  // agent is paused. They still respect the per-session daily cap.
  const userInitiated = (task.params as { userInitiated?: boolean } | null)?.userInitiated === true;

  // Gate dispatch on the owning master agent's lifecycle. A task that still
  // carries a master_agent_id must not dispatch if that agent has been deleted
  // (row gone) or paused — otherwise queued tasks keep firing at the extension
  // long after the agent is gone, with no way to stop them. User-initiated
  // tasks bypass the paused/quota skip (but a deleted agent still cancels them).
  if (task.masterAgentId) {
    const [agentRow] = await withTenant(tenantId, async (tx) => {
      return tx.select({ status: masterAgents.status })
        .from(masterAgents)
        .where(eq(masterAgents.id, task.masterAgentId as string))
        .limit(1);
    });
    if (!agentRow) {
      // Agent deleted out from under the task — cancel it so the sweep stops retrying.
      await withTenant(tenantId, async (tx) => {
        await tx.update(extensionTasks)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(extensionTasks.id, taskId), eq(extensionTasks.tenantId, tenantId)));
      });
      logger.info({ taskId, masterAgentId: task.masterAgentId }, 'Cancelled dispatch — master agent deleted');
      return false;
    }
    if (!userInitiated && (agentRow.status === 'paused' || agentRow.status === 'paused_quota')) {
      logger.info({ taskId, masterAgentId: task.masterAgentId, status: agentRow.status }, 'Skipped dispatch — master agent paused');
      return false;
    }
  }

  // Load ALL eligible (connected, recent heartbeat, non-revoked) sessions
  // that can reach this tenant. The previous .limit(1) most-recent picker
  // stalled the queue whenever the chosen session was at cap — even if a
  // sibling session had headroom. We fall back across sessions in
  // lastSeenAt-desc order so the healthiest one wins first.
  //
  // When ENABLE_MULTI_WORKSPACE_DISPATCH is on, a session is reachable if
  // its USER is a member of the requested tenant via user_tenants — that is
  // the same predicate for both legacy per-tenant sessions and new
  // tenant-less multi-workspace sessions. This is what unblocks shiran
  // without requiring him to re-login: his existing tenant=2a559a80 session
  // becomes eligible for tasks in c0e5f997 because user_tenants lists him
  // as an owner there.
  //
  // With the flag off we preserve the old per-tenant predicate exactly so
  // rollback is a one-env-var flip.
  const tenantMatch = env.ENABLE_MULTI_WORKSPACE_DISPATCH
    ? exists(
        db
          .select({ one: sql<number>`1` })
          .from(userTenants)
          .where(and(
            eq(userTenants.userId, extensionSessions.userId),
            eq(userTenants.tenantId, tenantId),
            inArray(userTenants.role, ['owner', 'admin', 'member']),
          )),
      )
    : eq(extensionSessions.tenantId, tenantId);

  const eligibleSessions = await db
    .select()
    .from(extensionSessions)
    .where(and(
      tenantMatch!,
      eq(extensionSessions.connected, true),
      isNull(extensionSessions.revokedAt),
      gt(extensionSessions.lastSeenAt, sql`NOW() - INTERVAL '90 seconds'`),
    ))
    .orderBy(desc(extensionSessions.lastSeenAt));

  if (eligibleSessions.length === 0) {
    logger.info(
      { taskId, tenantId, masterAgentId: task.masterAgentId, type: task.type },
      'Extension task queued but not dispatched — no connected extension session',
    );
    return false;
  }

  const limit = getLimit(task.site as ExtensionSite, task.type as ExtensionTaskType);
  const key = `${task.site}:${task.type}`;
  const now = new Date();

  // Look up the master-agent name once — used by all dispatch attempts below.
  let masterAgentName: string | null = null;
  if (task.masterAgentId) {
    const [agentRow] = await withTenant(tenantId, async (tx) => {
      return tx
        .select({ name: masterAgents.name })
        .from(masterAgents)
        .where(eq(masterAgents.id, task.masterAgentId as string))
        .limit(1);
    });
    masterAgentName = agentRow?.name ?? null;
  }

  const { hasLiveExtensionSocket } = await import('../websocket/extension.js');

  // Track the most recently-seen at-cap session so we can surface its real
  // dailyResetAt in the rate-limit pipeline error if every session refuses.
  let lastAtCap: { session: typeof eligibleSessions[number]; used: number; cap: number } | null = null;

  for (const session of eligibleSessions) {
    // Even if the DB says connected=true, the in-memory socket map is the
    // source of truth — a crashed/restarted process leaves orphan rows that
    // would otherwise consume dispatches into a dead Redis subscriber.
    if (!hasLiveExtensionSocket(session.id)) {
      await withTenant(tenantId, async (tx) => {
        await tx
          .update(extensionSessions)
          .set({ connected: false, updatedAt: new Date() })
          .where(eq(extensionSessions.id, session.id));
      });
      logger.warn(
        { sessionId: session.id, tenantId },
        'self_healed_orphan_session_no_live_socket',
      );
      continue;
    }

    // Per-session daily-cap check. Reset counters if dailyResetAt older than 24h.
    const resetAt = session.dailyResetAt ? new Date(session.dailyResetAt) : new Date(0);
    const needsReset = now.getTime() - resetAt.getTime() > 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = needsReset
      ? {}
      : { ...((session.dailyTasksCount as Record<string, number>) ?? {}) };
    const used = counts[key] ?? 0;
    if (limit && used >= limit.dailyCap) {
      lastAtCap = { session, used, cap: limit.dailyCap };
      continue;
    }

    // Acquired a slot on this session. Mark dispatched + bump counter.
    counts[key] = used + 1;
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(extensionTasks)
        .set({
          status: 'dispatched',
          sessionId: session.id,
          dispatchedAt: now,
          updatedAt: now,
        })
        .where(eq(extensionTasks.id, task.id));

      await tx
        .update(extensionSessions)
        .set({
          dailyTasksCount: counts,
          dailyResetAt: needsReset ? now : session.dailyResetAt,
          updatedAt: now,
        })
        .where(eq(extensionSessions.id, session.id));
    });

    const payload = JSON.stringify({
      type: 'task',
      taskId: task.id,
      // Carried per-task so multi-workspace sessions can echo it back on
      // task_result and so the popup can attribute work to the right workspace.
      // Result-routing on the server still goes through the DB lookup as a
      // safety net (see onExtensionTaskComplete), so this field is advisory.
      tenantId,
      site: task.site,
      taskType: task.type,
      params: task.params,
      requestedAt: now.toISOString(),
      masterAgentId: task.masterAgentId ?? null,
      masterAgentName,
    });
    await pubRedis.publish(`extension-dispatch:${session.id}`, payload);

    logger.info({ taskId: task.id, tenantId, sessionId: session.id, site: task.site, type: task.type }, 'Extension task dispatched');
    return true;
  }

  // No session accepted. If at least one was at cap, surface a real-reset
  // pipeline error rather than the misleading static "Pausing for 1 hour".
  if (lastAtCap) {
    const baseResetAt = lastAtCap.session.dailyResetAt
      ? new Date(lastAtCap.session.dailyResetAt)
      : null;
    const nextResetAt = baseResetAt ? new Date(baseResetAt.getTime() + 24 * 60 * 60 * 1000) : null;
    logger.info(
      {
        taskId, tenantId, site: task.site, type: task.type,
        used: lastAtCap.used, cap: lastAtCap.cap,
        sessionCount: eligibleSessions.length,
      },
      'all_sessions_at_cap',
    );
    if (task.site === 'linkedin') {
      await logPipelineError({
        tenantId,
        masterAgentId: task.masterAgentId ?? null,
        step: 'extension.dispatch',
        tool: 'LINKEDIN_EXTENSION',
        errorType: 'linkedin_rate_limit',
        message: formatRateLimitMessage(nextResetAt),
        context: {
          taskId, site: task.site, type: task.type,
          used: lastAtCap.used, cap: lastAtCap.cap,
          sessionCount: eligibleSessions.length,
          nextResetAt: nextResetAt?.toISOString() ?? null,
        },
      });
    }
  }
  return false;
}

// ─── Drain on reconnect ─────────────────────────────────────────────────────

/**
 * Tell every live extension session that can serve this tenant to STOP NOW —
 * abort the in-flight scrape (close the tab), drop its in-memory task backlog,
 * and go idle. Used by agent /stop + DELETE so scraping halts instantly instead
 * of draining tasks the extension already received over the WS. Uses the same
 * multi-workspace session match as tryDispatch so tenant_id=NULL sessions are
 * reached. Fire-and-forget; never throws.
 */
export async function publishExtensionStop(tenantId: string, masterAgentId?: string): Promise<void> {
  try {
    const tenantMatch = env.ENABLE_MULTI_WORKSPACE_DISPATCH
      ? exists(
          db
            .select({ one: sql<number>`1` })
            .from(userTenants)
            .where(and(
              eq(userTenants.userId, extensionSessions.userId),
              eq(userTenants.tenantId, tenantId),
              inArray(userTenants.role, ['owner', 'admin', 'member']),
            )),
        )
      : eq(extensionSessions.tenantId, tenantId);

    const sessions = await db
      .select({ id: extensionSessions.id })
      .from(extensionSessions)
      .where(and(
        tenantMatch!,
        eq(extensionSessions.connected, true),
        isNull(extensionSessions.revokedAt),
      ));

    const payload = JSON.stringify({ type: 'stop_all', tenantId, masterAgentId: masterAgentId ?? null });
    for (const s of sessions) {
      await pubRedis.publish(`extension-dispatch:${s.id}`, payload);
    }
    logger.info({ tenantId, masterAgentId, sessions: sessions.length }, 'Published stop_all to extension sessions');
  } catch (err) {
    logger.error({ err, tenantId, masterAgentId }, 'Failed to publish stop_all to extension');
  }
}

export async function drainPending(tenantId: string, sessionId: string): Promise<number> {
  const pending = await withTenant(tenantId, async (tx) => {
    return tx
      .select({ id: extensionTasks.id })
      .from(extensionTasks)
      .where(and(
        eq(extensionTasks.tenantId, tenantId),
        eq(extensionTasks.status, 'pending'),
        lte(extensionTasks.dispatchAfter, new Date()),
      ))
      .orderBy(desc(extensionTasks.priority), asc(extensionTasks.createdAt))
      .limit(50);
  });

  let dispatched = 0;
  for (const row of pending) {
    const ok = await tryDispatch(tenantId, row.id);
    if (ok) dispatched++;
  }
  if (dispatched > 0) {
    logger.info({ tenantId, sessionId, dispatched, total: pending.length }, 'Drained pending extension tasks on reconnect');
  }
  return dispatched;
}

// Multi-workspace drain: pulls the oldest pending tasks across every tenant
// the session's user is a member of and dispatches each one through the
// regular per-tenant tryDispatch (which itself now allows tenant-less
// sessions). One JOIN, fair cross-workspace ordering by created_at.
export async function drainPendingForUser(userId: string, sessionId: string): Promise<number> {
  if (!env.ENABLE_MULTI_WORKSPACE_DISPATCH) {
    // Flag-off rollback: tenant-less sessions can't drain anything in this
    // mode, but they shouldn't exist either (the dispatcher and login code
    // both gate on the same flag in practice). Logged so we notice if it
    // ever happens.
    logger.warn({ sessionId, userId }, 'drainPendingForUser called with multi-workspace flag OFF — no-op');
    return 0;
  }

  const pending = await db
    .select({ id: extensionTasks.id, tenantId: extensionTasks.tenantId })
    .from(extensionTasks)
    .innerJoin(userTenants, eq(userTenants.tenantId, extensionTasks.tenantId))
    .where(and(
      eq(userTenants.userId, userId),
      inArray(userTenants.role, ['owner', 'admin', 'member']),
      eq(extensionTasks.status, 'pending'),
      lte(extensionTasks.dispatchAfter, new Date()),
    ))
    .orderBy(desc(extensionTasks.priority), asc(extensionTasks.createdAt))
    .limit(50);

  let dispatched = 0;
  for (const row of pending) {
    const ok = await tryDispatch(row.tenantId, row.id);
    if (ok) dispatched++;
  }
  if (pending.length > 0) {
    logger.info(
      { userId, sessionId, dispatched, total: pending.length, tenants: [...new Set(pending.map((p) => p.tenantId))].length },
      'Drained pending extension tasks on reconnect (multi-workspace)',
    );
  }
  return dispatched;
}

// ─── Scheduled drainer ──────────────────────────────────────────────────────
// Periodic sweep that picks up tasks whose `dispatch_after` has just passed.
// Without this, tasks staggered across batches would sit `pending` forever
// because the immediate-dispatch path bails for future-scheduled rows.

let scheduledDrainerInterval: NodeJS.Timeout | null = null;

export async function runScheduledDispatchSweep(): Promise<number> {
  // Use the global db (cross-tenant scan). RLS filters via withTenant aren't
  // needed here — the read joins by tenant_id and the dispatch path itself
  // re-loads under tenant context.
  const { db } = await import('../config/database.js');
  const eligible = await db
    .select({ id: extensionTasks.id, tenantId: extensionTasks.tenantId })
    .from(extensionTasks)
    .where(and(
      eq(extensionTasks.status, 'pending'),
      lte(extensionTasks.dispatchAfter, new Date()),
    ))
    .orderBy(desc(extensionTasks.priority), asc(extensionTasks.createdAt))
    .limit(200);

  let dispatched = 0;
  for (const row of eligible) {
    try {
      const ok = await tryDispatch(row.tenantId, row.id);
      if (ok) dispatched++;
    } catch (err) {
      logger.debug({ err, taskId: row.id, tenantId: row.tenantId }, 'Scheduled drainer dispatch failed');
    }
  }
  if (dispatched > 0) {
    logger.info({ dispatched, scanned: eligible.length }, 'Scheduled dispatch sweep dispatched batched tasks');
  }
  return dispatched;
}

export function startScheduledDispatcher(intervalMs = 15_000): void {
  if (scheduledDrainerInterval) return;
  scheduledDrainerInterval = setInterval(() => {
    runScheduledDispatchSweep().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Scheduled dispatcher sweep errored');
    });
  }, intervalMs);
  // Don't keep the event loop alive purely for this timer.
  scheduledDrainerInterval.unref?.();
  logger.info({ intervalMs }, 'Scheduled extension dispatcher started');
}

export function stopScheduledDispatcher(): void {
  if (scheduledDrainerInterval) {
    clearInterval(scheduledDrainerInterval);
    scheduledDrainerInterval = null;
  }
}

// ─── Stuck-dispatched watchdog ──────────────────────────────────────────────
// A task is marked `dispatched` the moment we publish to Redis, but if the
// extension's WS dies between publish and ack, no `task_result` ever comes
// back — the row sits in `dispatched` forever and the queue silently shrinks
// to zero throughput. This watchdog re-pends anything that's been dispatched
// for more than 5 minutes so the next drainer cycle gives it another chance.

let stuckWatchdogInterval: NodeJS.Timeout | null = null;

export async function rePendStuckDispatched(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60_000);
  const { db } = await import('../config/database.js');
  const res = await db
    .update(extensionTasks)
    .set({ status: 'pending', sessionId: null, dispatchedAt: null, updatedAt: new Date() })
    .where(and(eq(extensionTasks.status, 'dispatched'), lte(extensionTasks.dispatchedAt, cutoff)))
    .returning({ id: extensionTasks.id });
  if (res.length > 0) {
    logger.warn({ count: res.length }, 're_pended_stuck_dispatched_tasks');
  }
  return res.length;
}

export function startStuckDispatchedWatchdog(intervalMs = 60_000): void {
  if (stuckWatchdogInterval) return;
  stuckWatchdogInterval = setInterval(() => {
    rePendStuckDispatched().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Stuck-dispatched watchdog errored');
    });
  }, intervalMs);
  stuckWatchdogInterval.unref?.();
  logger.info({ intervalMs }, 'Stuck-dispatched watchdog started');
}

export function stopStuckDispatchedWatchdog(): void {
  if (stuckWatchdogInterval) {
    clearInterval(stuckWatchdogInterval);
    stuckWatchdogInterval = null;
  }
}

// ─── Task-complete handler ──────────────────────────────────────────────────

type CompletePayload =
  | { status: 'completed'; result: Record<string, unknown> }
  | { status: 'failed'; error: string };

export async function onExtensionTaskComplete(taskId: string, payload: CompletePayload): Promise<void> {
  // Look up the task (without tenant context) to learn tenant
  const [task] = await import('../config/database.js').then(({ db }) =>
    db.select().from(extensionTasks).where(eq(extensionTasks.id, taskId)).limit(1),
  );
  logger.debug(
    { taskId, found: !!task, tenantId: task?.tenantId, site: task?.site, type: task?.type },
    'extension_task_complete_start',
  );
  if (!task) {
    logger.warn({ taskId }, 'Extension task_result for unknown task');
    return;
  }

  // ─── Blocked-by-popup: reset to pending, don't count as a failed attempt ──
  // The extension has paused itself and the user will click Resume after
  // dismissing the LinkedIn modal. We want this exact task to re-dispatch
  // on reconnect, not stay in "failed".
  if (payload.status === 'failed' && payload.error === 'blocked_by_popup') {
    const resetAt = new Date();
    await withTenant(task.tenantId, async (tx) => {
      await tx
        .update(extensionTasks)
        .set({ status: 'pending', error: null, updatedAt: resetAt })
        .where(eq(extensionTasks.id, task.id));
    });
    logger.info(
      { taskId: task.id, tenantId: task.tenantId, site: task.site, type: task.type },
      'Extension task blocked by popup — reset to pending for retry on resume',
    );
    if (task.site === 'linkedin') {
      await logPipelineError({
        tenantId: task.tenantId,
        masterAgentId: task.masterAgentId ?? null,
        step: 'extension.task',
        tool: 'LINKEDIN_EXTENSION',
        errorType: 'linkedin_popup',
        context: { taskId: task.id, site: task.site, type: task.type },
      });
    }
    return;
  }

  // ─── Rate-limited (429): reset to pending for retry, don't count as attempt ──
  if (payload.status === 'failed' && payload.error === 'rate_limited_429') {
    const resetAt = new Date();
    await withTenant(task.tenantId, async (tx) => {
      await tx
        .update(extensionTasks)
        .set({ status: 'pending', error: null, updatedAt: resetAt })
        .where(eq(extensionTasks.id, task.id));
    });
    logger.info(
      { taskId: task.id, tenantId: task.tenantId, site: task.site, type: task.type },
      'Extension task rate-limited (429) — reset to pending for retry after backoff',
    );
    if (task.site === 'linkedin') {
      await logPipelineError({
        tenantId: task.tenantId,
        masterAgentId: task.masterAgentId ?? null,
        step: 'extension.task',
        tool: 'LINKEDIN_EXTENSION',
        errorType: 'linkedin_rate_limit',
        context: { taskId: task.id, site: task.site, type: task.type },
      });
    }
    return;
  }

  const now = new Date();
  await withTenant(task.tenantId, async (tx) => {
    await tx
      .update(extensionTasks)
      .set({
        status: payload.status,
        result: payload.status === 'completed' ? payload.result : undefined,
        error: payload.status === 'failed' ? payload.error : undefined,
        completedAt: now,
        updatedAt: now,
        attempts: (task.attempts ?? 0) + 1,
      })
      .where(eq(extensionTasks.id, task.id));
  });
  logger.debug({ taskId: task.id, newStatus: payload.status }, 'extension_task_status_updated');

  if (payload.status !== 'completed') return;

  // Ingest results. Track extracted-vs-saved so we can log a clear WARN when
  // a task completed but produced zero saves (the most common silent-failure
  // mode — usually means the site's DOM changed and the adapter selectors
  // need updating).
  try {
    const summary = await ingestResult(task, payload.result);
    if (summary.extracted === 0) {
      logger.warn(
        {
          taskId: task.id,
          tenantId: task.tenantId,
          site: task.site,
          type: task.type,
          resultKeys: Object.keys(payload.result ?? {}),
          resultSample: JSON.stringify(payload.result).slice(0, 500),
        },
        'Extension task completed with ZERO items extracted — likely DOM selectors out of date',
      );
    } else if (summary.saved === 0) {
      logger.warn(
        { taskId: task.id, extracted: summary.extracted },
        'Extension task extracted items but saved zero — all rejected by saveOrUpdateCompanyStatic',
      );
    } else {
      logger.info(
        { taskId: task.id, site: task.site, type: task.type, extracted: summary.extracted, saved: summary.saved },
        'Extension task ingested',
      );
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Failed to ingest extension task result into pipeline');
  }
}

type IngestSummary = { extracted: number; saved: number };

// ─── Server-side post-extraction geo filter ────────────────────────────────
// LinkedIn's `companyHqGeo` URL facet is a SOFT filter — when keyword
// matching is strong (e.g. "neobank digital bank"), LinkedIn surfaces
// globally-relevant companies even when their HQ is outside the requested
// URN list. We confirmed empirically: agent 4c232eb4-... requested EU only
// and got Mumbai/Atlanta/Istanbul rows alongside London/Paris/Amsterdam.
//
// The extension already extracts a `location` string per card. We match it
// against the strategist's `geographyFilter.regions` here. Companies whose
// location does not plausibly belong to any requested region are dropped
// before save. Empty location → pass through (don't drop on missing data;
// `fetch_company_info` will populate `headquarters` and the next pass can
// re-evaluate).
const CITY_TO_COUNTRY: Record<string, string> = {
  // EU
  london: 'united kingdom', manchester: 'united kingdom', edinburgh: 'united kingdom',
  birmingham: 'united kingdom', leeds: 'united kingdom', glasgow: 'united kingdom',
  paris: 'france', lyon: 'france', toulouse: 'france', marseille: 'france',
  berlin: 'germany', munich: 'germany', hamburg: 'germany', frankfurt: 'germany',
  cologne: 'germany', stuttgart: 'germany',
  amsterdam: 'netherlands', rotterdam: 'netherlands', 'the hague': 'netherlands',
  utrecht: 'netherlands', eindhoven: 'netherlands',
  stockholm: 'sweden', gothenburg: 'sweden', malmö: 'sweden', malmo: 'sweden',
  dublin: 'ireland', cork: 'ireland',
  madrid: 'spain', barcelona: 'spain', valencia: 'spain', seville: 'spain',
  milan: 'italy', rome: 'italy', turin: 'italy', naples: 'italy', bologna: 'italy',
  warsaw: 'poland', krakow: 'poland', kraków: 'poland', lublin: 'poland', mokotów: 'poland',
  brussels: 'belgium', antwerp: 'belgium', ghent: 'belgium',
  copenhagen: 'denmark', oslo: 'norway', helsinki: 'finland',
  lisbon: 'portugal', porto: 'portugal',
  vienna: 'austria', zurich: 'switzerland', geneva: 'switzerland', basel: 'switzerland',
  vilnius: 'lithuania', luxembourg: 'luxembourg',
  // MENA
  dubai: 'united arab emirates', 'abu dhabi': 'united arab emirates',
  riyadh: 'saudi arabia', jeddah: 'saudi arabia',
  cairo: 'egypt', alexandria: 'egypt',
  doha: 'qatar', 'kuwait city': 'kuwait',
  casablanca: 'morocco', rabat: 'morocco',
  // NA
  'new york': 'united states', 'san francisco': 'united states', 'palo alto': 'united states',
  miami: 'united states', atlanta: 'united states', somerville: 'united states',
  boston: 'united states', chicago: 'united states', seattle: 'united states',
  'los angeles': 'united states', austin: 'united states', denver: 'united states',
  toronto: 'canada', vancouver: 'canada', montreal: 'canada', ottawa: 'canada',
};

// Region-name aliases LinkedIn occasionally puts in the location string
// (state/country variants beyond the canonical names in geographyFilter).
const REGION_ALIASES: Record<string, string> = {
  uk: 'united kingdom',
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  uae: 'united arab emirates',
  usa: 'united states',
  us: 'united states',
};

export function isLocationInRegions(
  location: string | undefined | null,
  requestedRegions: string[],
): boolean {
  if (!location || !location.trim()) return true; // pass-through on missing data
  if (!requestedRegions.length) return true;
  const loc = location.toLowerCase();
  const wanted = new Set(requestedRegions.map((r) => r.trim().toLowerCase()));

  // Direct country-name substring match — handles "London, England, United Kingdom"
  // and "İstanbul, Şişli" (latter doesn't contain any wanted country → drop).
  for (const w of wanted) {
    if (loc.includes(w)) return true;
  }

  // Alias check (LinkedIn says "England" — strategist says "United Kingdom").
  for (const [alias, canonical] of Object.entries(REGION_ALIASES)) {
    if (wanted.has(canonical) && new RegExp(`\\b${alias}\\b`, 'i').test(loc)) {
      return true;
    }
  }

  // City-level fallback. Tokenise the location string on commas + middle-dot
  // and look up each token in CITY_TO_COUNTRY.
  const tokens = loc
    .split(/[,•·]/g)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    const country = CITY_TO_COUNTRY[tok];
    if (country && wanted.has(country)) return true;
  }

  return false;
}

async function ingestResult(task: ExtensionTask, result: Record<string, unknown>): Promise<IngestSummary> {
  const site = task.site as ExtensionSite;
  const type = task.type as ExtensionTaskType;

  logger.debug(
    { taskId: task.id, site, type, resultKeys: Object.keys(result ?? {}) },
    'ingest_start',
  );

  if (site === 'linkedin' && type === 'search_companies') {
    const rawCompanies = (result.companies ?? []) as Array<Record<string, unknown>>;
    logger.info({ taskId: task.id, rawCount: rawCompanies.length }, 'ingest_linkedin_search_companies_raw');

    // ── Strict list-verification path ──────────────────────────────────────
    // `params.strictMatch` means this search was scoped to ONE known company
    // from a user-uploaded list. Pick the single best name-match, attach its
    // LinkedIn URL to the pre-created row, fan out info+team for that row ONLY,
    // and never create the other (decoy) results. No confident match → fail
    // loud (rawData.linkedinNotFound). Set for list-bounded agents (those
    // seeded from an uploaded company list via config.verificationList).
    const strict = (task.params as { strictMatch?: StrictMatch } | null)?.strictMatch;
    if (strict?.companyId) {
      const candidatesWithUrl = rawCompanies.filter(
        (c) => typeof c.linkedinUrl === 'string' && (c.linkedinUrl as string).trim().length > 0
          && typeof c.name === 'string' && (c.name as string).trim().length > 0,
      );
      const best = pickBestNameMatch(strict.name, candidatesWithUrl, (c) => String(c.name ?? ''));
      if (best) {
        const linkedinUrl = String(best.match.linkedinUrl);
        await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            id: strict.companyId,
            name: strict.name,
            domain: typeof best.match.website === 'string' ? extractDomain(best.match.website as string) : undefined,
            industry: (best.match.industry as string) ?? undefined,
            size: (best.match.size as string) ?? undefined,
            linkedinUrl,
            rawData: {
              linkedinNotFound: false,
              linkedinMatchScore: best.score,
              linkedinMatchedName: best.match.name,
            },
          },
          task.masterAgentId ?? undefined,
        );
        await enqueueCompanyEnrichmentFanout(
          task.tenantId,
          task.masterAgentId ?? undefined,
          [{ linkedinUrl, companyId: strict.companyId }],
          { crawlWebsite: true },
        );
        logger.info(
          { taskId: task.id, companyId: strict.companyId, name: strict.name, score: best.score, linkedinUrl },
          'list_verification: linkedin strict match',
        );
        return { extracted: rawCompanies.length, saved: 1 };
      }
      await markRawDataFlag(task.tenantId, strict.companyId, { linkedinNotFound: true });
      logger.info(
        { taskId: task.id, companyId: strict.companyId, name: strict.name, candidates: rawCompanies.length },
        'list_verification: linkedin no confident match — flagged linkedinNotFound',
      );
      return { extracted: rawCompanies.length, saved: 0 };
    }

    let saved = 0;
    // No keyword pre-save filter — every company with a name + LinkedIn URL is
    // saved. The buyer-fit scorer (LLM) ranks them downstream; the dashboard
    // sorts by score. See plan: discovery-pipeline refactor PART 1.
    // Collect fetch_company auto-chain tasks and enqueue them in batches of
    // 10 (60s cooldown) at the end of the loop. With a 100-result search this
    // would otherwise queue 100 fetch_company tasks back-to-back into the
    // extension and trip LinkedIn 429s.
    const pendingFetchTasks: Array<{ linkedinUrl: string; companyId: string }> = [];
    const requestedRegions =
      ((task.params as { geographyFilter?: { regions?: string[] } })?.geographyFilter?.regions ?? [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
    let geoFlagged = 0;
    for (const c of rawCompanies) {
      const name = String(c.name ?? '').trim();
      if (!name || name.length < 2) continue;

      // Geo filter — LinkedIn's `companyHqGeo` is a soft facet that leaks
      // globally-relevant matches when keywords are strong. We no longer DROP
      // mismatches (the search adapter's `location` field is unreliable — it
      // sometimes contains a description snippet rather than a city). Instead
      // we annotate the row so the dashboard can render an "out of region"
      // tag, and let fetch_company_info populate the real headquarters for a
      // post-enrichment pass to re-evaluate.
      let geoMismatch: { expected: string[]; got: string } | null = null;
      if (requestedRegions.length > 0) {
        const cLocation = typeof c.location === 'string' ? c.location : '';
        if (cLocation && !isLocationInRegions(cLocation, requestedRegions)) {
          geoMismatch = { expected: requestedRegions, got: cLocation };
          geoFlagged++;
          logger.info(
            { taskId: task.id, name, location: cLocation, requestedRegions },
            'discovery_geo_mismatch_flagged',
          );
        }
      }

      // Dedup by linkedinUrl first. saveOrUpdateCompanyStatic only dedupes by
      // domain/name, and search results rarely carry a domain, so two sessions
      // that return "Acme Corp." and "Acme Corporation" with the same
      // linkedin_url would otherwise produce two rows. Skipping entirely also
      // preserves enriched fields (description, website, funding) that an
      // earlier fetch_company run may already have populated on the existing
      // row — the search-result payload is strictly slimmer.
      const linkedinUrl = typeof c.linkedinUrl === 'string' && c.linkedinUrl.trim().length > 0
        ? c.linkedinUrl
        : undefined;
      if (linkedinUrl) {
        const [existing] = await withTenant(task.tenantId, async (tx) => {
          return tx
            .select({ id: companies.id })
            .from(companies)
            .where(
              and(
                eq(companies.tenantId, task.tenantId),
                eq(companies.linkedinUrl, linkedinUrl),
              ),
            )
            .limit(1);
        });
        if (existing) {
          logger.debug(
            { linkedinUrl, existingId: existing.id },
            'Skipped duplicate company from LinkedIn extension (dedup by linkedinUrl)',
          );
          continue;
        }
      }

      try {
        const savedRow = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name,
            domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
            industry: (c.industry as string) ?? undefined,
            size: (c.size as string) ?? undefined,
            linkedinUrl,
            rawData: {
              source: 'linkedin_extension',
              ...c,
              ...(geoMismatch ? { geoMismatch } : {}),
            },
          },
          task.masterAgentId ?? undefined,
        );
        // Enrichment dispatch moved to fetch_company — search results lack domain
        logger.debug(
          { taskId: task.id, companyId: savedRow.id, name, linkedinUrl },
          'ingest_saved_company',
        );

        // Auto-chain the LinkedIn About-page fetch so enrichment gets a real
        // website/domain. companyId threads through so the detail task
        // updates this exact row by id rather than re-running fuzzy
        // domain/name dedup. Queued for batched dispatch below.
        if (linkedinUrl) {
          pendingFetchTasks.push({ linkedinUrl, companyId: savedRow.id });
        }

        saved++;
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid company from LinkedIn extension');
      }
    }

    if (pendingFetchTasks.length > 0) {
      // Parallel fanout: per company, enqueue fetch_company_info (about page)
      // + one fetch_company_team per teamRoleKeyword. Shared with the
      // LinkedIn-Jobs path — see enqueueCompanyEnrichmentFanout.
      try {
        await enqueueCompanyEnrichmentFanout(
          task.tenantId,
          task.masterAgentId ?? undefined,
          pendingFetchTasks,
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), count: pendingFetchTasks.length, taskId: task.id },
          'Batched fetch_company info+team auto-chain enqueue failed (non-fatal)',
        );
      }
    }

    logger.info(
      {
        taskId: task.id,
        masterAgentId: task.masterAgentId,
        rawResultCount: rawCompanies.length,
        saved,
        geoFlagged,
        requestedRegions,
      },
      'discovery_saved_summary',
    );

    return { extracted: rawCompanies.length, saved };
  }

  // ─── Parallel-fetch handlers (info + team) ──────────────────────────────
  // The legacy fetch_company adapter is split into two parallel adapters.
  // Each completion handler updates the same company row independently and
  // triggers the fit-score scorer. The legacy fetch_company branch below
  // stays as a backwards-compat shim for in-flight tasks during deploy.

  if (site === 'linkedin' && type === 'fetch_company_info') {
    return handleCompanyInfoComplete(task, result as Record<string, unknown>);
  }

  if (site === 'linkedin' && type === 'fetch_company_team') {
    return handleCompanyTeamComplete(task, result as Record<string, unknown>);
  }

  if (site === 'linkedin' && type === 'fetch_profile') {
    return handleProfileComplete(task, result as Record<string, unknown>);
  }

  if (site === 'linkedin' && type === 'search_people') {
    return handlePeopleSearchComplete(task, result as Record<string, unknown>);
  }

  if (site === 'linkedin' && (type === 'linkedin_message' || type === 'linkedin_connect')) {
    // Review-then-send: the adapter only stages the text in LinkedIn's box. The
    // actual outreach is recorded via /api/studio/record-action when the USER
    // clicks Send, so there is nothing to ingest from the task result here.
    const status = (result as { status?: string } | null)?.status ?? 'unknown';
    logger.info({ taskId: task.id, type, status }, 'linkedin_outreach_staged');
    return { extracted: 0, saved: 0 };
  }

  if (site === 'linkedin' && type === 'fetch_company') {
    // Legacy combined adapter — feed both handlers from a single payload so
    // tasks queued before the parallel split still get processed correctly.
    const r = result as Record<string, unknown>;
    const infoSummary = await handleCompanyInfoComplete(task, r);
    const teamSummary = await handleCompanyTeamComplete(task, r);
    return {
      extracted: infoSummary.extracted + teamSummary.extracted,
      saved: infoSummary.saved + teamSummary.saved,
    };
  }

  if (site === 'gmaps') {
    const items = (result.businesses ?? (type === 'fetch_business' ? [result] : [])) as Array<Record<string, unknown>>;
    const params = (task.params ?? {}) as Record<string, unknown>;

    // ── Strict list-verification path ──────────────────────────────────────
    // `params.strictMatch` scopes this Maps search to ONE known company. Pick
    // the single best name-match, ingest it onto the pre-created row (name
    // override forces the dedup to land there), thread strictMatch through the
    // place-detail fanout so the detail completion routes back here too. No
    // confident match → fail loud (rawData.gmapsNotFound).
    const strict = (params as { strictMatch?: StrictMatch }).strictMatch;
    if (strict?.companyId) {
      let chosen: Record<string, unknown> | undefined;
      let score = 1;
      if (type === 'fetch_business') {
        chosen = items[0];
      } else {
        const named = items.filter((b) => typeof b.name === 'string' && (b.name as string).trim().length > 0);
        const best = pickBestNameMatch(strict.name, named, (b) => String(b.name ?? ''));
        chosen = best?.match;
        score = best?.score ?? 0;
      }
      if (!chosen) {
        await markRawDataFlag(task.tenantId, strict.companyId, { gmapsNotFound: true });
        // GMaps-enrichment-only agents ask for a Google-dork fallback: when Maps
        // has no confident match, dork the web for the company's official site
        // (`"Name" "Region"`) and enrich from there. Only on the search miss —
        // never re-dork off a detail (fetch_business) miss.
        const dorkFallback = (params as { dorkFallback?: boolean }).dorkFallback === true;
        if (dorkFallback && type !== 'fetch_business') {
          const region = typeof (params as { region?: string }).region === 'string'
            ? (params as { region?: string }).region!.trim() : '';
          const dork = region ? `"${strict.name}" "${region}"` : `"${strict.name}"`;
          try {
            await enqueueExtensionTask({
              tenantId: task.tenantId,
              masterAgentId: task.masterAgentId ?? undefined,
              site: 'google',
              type: 'search_serp',
              params: {
                dork,
                limit: 10,
                queryRationale: 'GMaps had no confident match — find the official website to enrich.',
                strictMatch: strict,
              },
              priority: 6,
            });
            logger.info(
              { taskId: task.id, companyId: strict.companyId, name: strict.name, dork },
              'list_verification: gmaps miss — dork fallback enqueued',
            );
          } catch (err) {
            logger.warn({ err, companyId: strict.companyId }, 'list_verification: dork fallback enqueue failed');
          }
        } else {
          logger.info(
            { taskId: task.id, companyId: strict.companyId, name: strict.name, candidates: items.length },
            'list_verification: gmaps no confident match — flagged gmapsNotFound',
          );
        }
        return { extracted: items.length, saved: 0 };
      }
      const isDetail = type === 'fetch_business';
      const mapsUrl = typeof chosen.mapsUrl === 'string' ? chosen.mapsUrl : undefined;
      try {
        const ingest = await ingestGmapsBusiness(
          task.tenantId,
          task.masterAgentId ?? undefined,
          gmapsBusinessToInput(chosen, params, isDetail, strict.name, strict.companyId),
        );
        // Keep the user_list provenance + record the match; ingestGmapsBusiness
        // flips source to 'gmaps_extension' and we never want a stale not-found.
        await markRawDataFlag(task.tenantId, ingest.companyId, {
          source: 'user_list',
          listEntry: true,
          gmapsNotFound: false,
          gmapsMatchScore: score,
        });
        if (ingest.needsDetail && mapsUrl) {
          await enqueueExtensionTask({
            tenantId: task.tenantId,
            masterAgentId: task.masterAgentId ?? undefined,
            site: 'gmaps',
            type: 'fetch_business',
            params: { mapsUrl, strictMatch: strict },
            priority: 6,
          });
        }
        logger.info(
          { taskId: task.id, companyId: strict.companyId, name: strict.name, score, isDetail },
          'list_verification: gmaps strict match',
        );
        return { extracted: items.length, saved: 1 };
      } catch (err) {
        logger.warn({ err, taskId: task.id, companyId: strict.companyId }, 'list_verification: gmaps ingest failed');
        return { extracted: items.length, saved: 0 };
      }
    }

    let saved = 0;
    const detailFanout: BatchTaskInput[] = [];
    for (const b of items) {
      const name = String(b.name ?? '').trim();
      if (!name) continue;
      const mapsUrl = typeof b.mapsUrl === 'string' ? b.mapsUrl : undefined;
      const isDetail = type === 'fetch_business';
      try {
        // Shared with POST /api/extension/gmaps/capture — creates company +
        // business-contact + Lead-stage deal and dispatches enrichment when
        // the business has a website (Maps never shows emails).
        const ingest = await ingestGmapsBusiness(
          task.tenantId,
          task.masterAgentId ?? undefined,
          gmapsBusinessToInput(b, params, isDetail),
        );
        saved++;
        // Every business with a place URL gets one place-detail scrape (it has
        // phone/hours/menu the search card lacks). Fan out a fetch_business when
        // ingest reports the row still needs detailing — a fetch_business result
        // has detailFetched=true (needsDetail=false), so it never fans out from
        // itself. The completion re-enters ingest, backfilling the contact and
        // dispatching enrichment for a newly-known website + menu vision.
        if (ingest.needsDetail && mapsUrl) {
          detailFanout.push({
            masterAgentId: task.masterAgentId ?? undefined,
            site: 'gmaps',
            type: 'fetch_business',
            params: { mapsUrl },
            priority: 6,
          });
        }
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid gmaps business');
      }
    }
    if (detailFanout.length > 0) {
      try {
        await enqueueExtensionTaskBatch(task.tenantId, detailFanout);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), count: detailFanout.length, taskId: task.id },
          'gmaps fetch_business fanout enqueue failed (non-fatal)',
        );
      }
    }
    return { extracted: items.length, saved };
  }

  if (site === 'crunchbase') {
    const items = (result.companies ?? (type === 'fetch_company' ? [result] : [])) as Array<Record<string, unknown>>;
    let saved = 0;
    for (const c of items) {
      const name = String(c.name ?? '').trim();
      if (!name) continue;
      try {
        const savedRow = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name,
            domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
            description: (c.description as string) ?? undefined,
            rawData: { source: 'crunchbase_extension', ...c },
          },
          task.masterAgentId ?? undefined,
        );
        if (type === 'search_companies') {
          await dispatchJob(task.tenantId, 'enrichment', {
            companyId: savedRow.id,
            masterAgentId: task.masterAgentId ?? undefined,
            source: 'crunchbase_extension',
          });
        }
        saved++;
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid crunchbase company');
      }
    }
    return { extracted: items.length, saved };
  }

  if (site === 'google' && type === 'search_serp') {
    return handleSerpComplete(task, result as Record<string, unknown>);
  }

  return { extracted: 0, saved: 0 };
}

const JUNK_TITLE_REGEX = /^(status is (online|offline)|message|follow|connect|view profile|see more)$/i;

// LinkedIn's followers / "Pages similaires" (similar pages) sidebar leaks into
// the company-team scrape: those cards are page-followers or other companies,
// NOT employees. They carry markers like "<Name> suit cette page" (FR: follows
// this page) and titles full of "<industry> N abonnés" (followers) / "Page
// Vitrine" / "Filiale". Reject a person when its name OR title carries any of
// these markers — applied at ingest so junk never reaches contacts or rawData.
const JUNK_PERSON_REGEX = /\b(?:suit|suivent)\s+cette\s+page\b|\bfollows?\s+this\s+page\b|\bpages?\s+(?:similaires|associées)\b|\bpage\s+vitrine\b|\bfiliale\b|\d[\d\s.,]*\s*(?:abonnés?|followers?)\b/i;

export function isJunkPerson(name?: string | null, title?: string | null): boolean {
  return JUNK_PERSON_REGEX.test(`${name ?? ''} ${title ?? ''}`);
}

// Strip a trailing follower-count clause ("... 85 860 abonnés") that LinkedIn
// appends to similar-page subtitles, then drop the title entirely if it's pure
// UI junk.
function sanitizeTitle(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let trimmed = raw.trim();
  if (!trimmed) return undefined;
  trimmed = trimmed.replace(/\s*\d[\d\s.,]*\s*(?:abonnés?|followers?)\s*$/i, '').trim();
  if (!trimmed) return undefined;
  if (JUNK_TITLE_REGEX.test(trimmed)) return undefined;
  return trimmed;
}

// Defensive sanitiser for person names coming from the LinkedIn extension.
// LinkedIn's accessibility markup concatenates the visible name with a
// screen-reader span like "View NAME's profile" and `textContent` reads both
// with no separator → "Saurabh KaushikView Saurabh Kaushik's profile".
// We:
//   1. Extract the inner NAME from any embedded "View NAME's profile" pattern.
//   2. Otherwise strip a trailing "View ... profile" suffix.
//   3. Reject anything that still contains "view"/"profile" as a word, or that
//      lacks a sensible first-last shape.
export function sanitizePersonName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 2) return null;

  // Pattern A: "View NAME('s) profile" embedded → use NAME (the full name).
  // Accept straight, curly, and back-tick apostrophes — LinkedIn's HTML uses
  // U+2019 (right single quotation mark) by default, which the previous
  // ASCII-only `'` class missed entirely.
  const inner = name.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
  if (inner && inner[1]) {
    const candidate = inner[1].trim();
    if (candidate.length >= 2 && candidate.length <= 100) name = candidate;
  } else {
    // Pattern B: trailing "View ... profile" → strip.
    name = name.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
  }

  // Pattern C: bare concatenation residue with no trailing " profile" — strip
  // anything from `View` onward when `View` follows a letter (LinkedIn's
  // visible-name + screen-reader-suffix concat always lower→upper-case
  // boundary like "SeveroView"). Prevents leftover "SeveroView" from passing
  // the `\bView\b` reject below, since `\b` doesn't fire between two
  // word-characters.
  name = name.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();

  // Strip trailing punctuation residue.
  name = name.replace(/[‘’'"`]+\s*$/, '').trim();

  if (name.length < 2 || name.length > 100) return null;
  // Reject any residual screen-reader artefact. `View\b` covers both
  // "SeveroView" (boundary at end of string) and standalone " View …".
  if (/View\b/i.test(name)) return null;
  if (/\bprofile\b/i.test(name)) return null;
  if (/%[0-9A-Fa-f]{2}/.test(name)) return null;
  // Reject followers/similar-page sidebar leaks ("Michael suit cette page").
  if (JUNK_PERSON_REGEX.test(name)) return null;
  return name;
}

// Score a job title by how useful the person is for outreach / hiring-signal
// follow-up. Higher = more useful (decision-maker or recruiter). Uses
// substring matching on the lowercased title — LinkedIn titles vary widely
// in punctuation/casing, so word-boundary regex is too brittle.
function scorePersonTitle(title: string | undefined | null): number {
  if (!title) return 0;
  const t = title.toLowerCase();

  // Tier 1 — C-suite / founders / owners (top decision-makers).
  if (/\b(ceo|cto|cfo|coo|cmo|chro|cio|ciso)\b/.test(t)) return 100;
  if (/chief\s+\w+(?:\s+\w+)?\s+officer/.test(t)) return 100;
  if (/\b(founder|co[\s-]?founder|owner|president|managing\s+director|managing\s+partner)\b/.test(t)) return 100;

  // Tier 2 — Talent acquisition / HR / recruiting (literally posting the job).
  if (/\b(talent\s+(acquisition|partner|manager|lead|director))\b/.test(t)) return 90;
  if (/\b(recruit(er|ing|ment)?|sourcer|head\s+of\s+(talent|people|hr))\b/.test(t)) return 90;
  if (/\b(hr\s+(director|manager|partner|lead)|chief\s+people|people\s+(ops|operations|partner))\b/.test(t)) return 85;
  if (/\b(hiring\s+manager)\b/.test(t)) return 85;

  // Tier 3 — VPs and Heads of (functional leadership).
  if (/\bvp\b|vice\s+president/.test(t)) return 75;
  if (/\bhead\s+of\b/.test(t)) return 70;

  // Tier 4 — Directors and Principal-level.
  if (/\b(director|principal)\b/.test(t)) return 55;

  // Tier 5 — Functional managers / leads (engineering manager, team lead).
  if (/\b(engineering|product|design|sales|marketing|operations)\s+(manager|lead|director)\b/.test(t)) return 40;
  if (/\b(tech\s+lead|team\s+lead|staff\s+engineer)\b/.test(t)) return 35;

  // Tier 6 — Generic manager / lead.
  if (/\b(manager|lead)\b/.test(t)) return 25;

  // Tier 7 — Individual contributors (engineers, developers, analysts, etc.)
  return 5;
}

// Rank people by title relevance — pure prioritisation, no filtering. Every
// person LinkedIn returned is preserved; the top 10 by score get saved.
// Decision-makers (CEO/CTO/Founder, recruiters, VPs, directors) bubble to
// the top; engineers and analysts sink to the bottom but still land in the
// list when there's room.
function rankPeopleByTitle<T extends { title: string }>(people: readonly T[]): T[] {
  return [...people].sort((a, b) => scorePersonTitle(b.title) - scorePersonTitle(a.title));
}

/**
 * Merge a new keyword-scoped people batch into the existing
 * companies.rawData. Returns both the per-keyword map and a deduped flat
 * list (by linkedinUrl, falling back to lowercased name) for backwards
 * compatibility with readers that expect `rawData.people` as a flat array.
 */
function mergePeopleByKeyword(
  existingFlat: unknown,
  existingByKeyword: Record<string, unknown>,
  bucketKey: string,
  newPeople: Array<{ name: string; title: string; linkedinUrl: string }>,
): { byKeyword: Record<string, typeof newPeople>; flat: typeof newPeople } {
  const byKeyword: Record<string, typeof newPeople> = {};
  for (const [k, v] of Object.entries(existingByKeyword)) {
    if (Array.isArray(v)) byKeyword[k] = v as typeof newPeople;
  }
  byKeyword[bucketKey] = newPeople;

  // Build a deduped union across all buckets, falling back on the legacy
  // flat list if the byKeyword map is otherwise empty.
  const seen = new Set<string>();
  const flat: typeof newPeople = [];
  const pushUnique = (p: { name: string; title: string; linkedinUrl: string }) => {
    const id = (p.linkedinUrl || '').toLowerCase().trim() || (p.name || '').toLowerCase().trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    flat.push(p);
  };
  for (const list of Object.values(byKeyword)) {
    for (const p of list) pushUnique(p);
  }
  if (flat.length === 0 && Array.isArray(existingFlat)) {
    for (const p of existingFlat as typeof newPeople) pushUnique(p);
  }
  return { byKeyword, flat };
}

function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

// ─── Helpers used by the WS endpoint ───────────────────────────────────────

export async function markSessionConnected(sessionId: string, connected: boolean): Promise<void> {
  const { db } = await import('../config/database.js');
  await db
    .update(extensionSessions)
    .set({
      connected,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(extensionSessions.id, sessionId));
}

// ─── Auto-resume agents that paused waiting for the extension ────────────────
//
// When the master-agent needs the LinkedIn extension but none is connected it
// pauses (master-agent.ts ~1444) with config.pauseReason='extension_required'
// rather than falling back to the crawler. Resume was manual (POST /:id/start),
// so a single disconnect stranded the agent. These helpers, called from the WS
// connect handler the moment the extension reconnects, flip exactly those
// agents back to running and re-trigger dispatch — no manual Run needed.
//
// The flip is an atomic conditional UPDATE (… WHERE status='paused' RETURNING):
// only one of several concurrent reconnects wins the row, so execute() can't
// double-fire. The 'pauseReason' key is stripped from the jsonb config on resume.
async function resumeAgentRows(
  rows: Array<{ id: string; tenantId: string; mission: string | null }>,
): Promise<void> {
  if (!rows.length) return;
  const { MasterAgent } = await import('../agents/master-agent.js');
  for (const row of rows) {
    try {
      const updated = await db
        .update(masterAgents)
        .set({
          status: 'running',
          config: sql`${masterAgents.config} - 'pauseReason'`,
          updatedAt: new Date(),
        })
        .where(and(eq(masterAgents.id, row.id), eq(masterAgents.status, 'paused')))
        .returning({ id: masterAgents.id });
      if (!updated.length) continue; // another reconnect already resumed it
      logger.info(
        { masterAgentId: row.id, tenantId: row.tenantId },
        'Auto-resuming agent on extension reconnect',
      );
      const agent = new MasterAgent({ tenantId: row.tenantId, masterAgentId: row.id });
      agent
        .execute({ masterAgentId: row.id, mission: row.mission ?? '' })
        .catch((err) =>
          logger.warn({ err, masterAgentId: row.id }, 'Auto-resume execute() failed'),
        );
    } catch (err) {
      logger.warn({ err, masterAgentId: row.id }, 'Auto-resume update failed');
    }
  }
}

// Legacy per-tenant session reconnected → resume that tenant's extension-paused agents.
export async function resumeExtensionPausedAgents(tenantId: string): Promise<void> {
  const rows = await db
    .select({ id: masterAgents.id, tenantId: masterAgents.tenantId, mission: masterAgents.mission })
    .from(masterAgents)
    .where(
      and(
        eq(masterAgents.tenantId, tenantId),
        eq(masterAgents.status, 'paused'),
        sql`${masterAgents.config}->>'pauseReason' = 'extension_required'`,
      ),
    );
  await resumeAgentRows(rows);
}

// Multi-workspace session (tenantId null) reconnected → resume extension-paused
// agents across every tenant the user belongs to.
export async function resumeExtensionPausedAgentsForUser(userId: string): Promise<void> {
  const tenantRows = await db
    .select({ tenantId: userTenants.tenantId })
    .from(userTenants)
    .where(eq(userTenants.userId, userId));
  const tenantIds = tenantRows.map((r) => r.tenantId);
  if (!tenantIds.length) return;
  const rows = await db
    .select({ id: masterAgents.id, tenantId: masterAgents.tenantId, mission: masterAgents.mission })
    .from(masterAgents)
    .where(
      and(
        inArray(masterAgents.tenantId, tenantIds),
        eq(masterAgents.status, 'paused'),
        sql`${masterAgents.config}->>'pauseReason' = 'extension_required'`,
      ),
    );
  await resumeAgentRows(rows);
}

// Touch lastSeenAt only — used as a real liveness signal from the WS ping
// handler so stale lastSeenAt actually means the SW is dead, not just that
// no reconnect happened. Caller throttles to ≤1 write per 10s per session.
export async function touchSessionLastSeen(sessionId: string): Promise<void> {
  const { db } = await import('../config/database.js');
  await db
    .update(extensionSessions)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(extensionSessions.id, sessionId));
}

// tenantId is null for multi-workspace sessions (post-0029 migration); the
// dispatcher uses userId + user_tenants to fan out across the user's
// workspaces. Legacy per-tenant sessions still carry a non-null tenantId.
export async function findSessionByApiKeyHash(apiKeyHash: string): Promise<{ id: string; tenantId: string | null; userId: string } | null> {
  const { db } = await import('../config/database.js');
  const [row] = await db
    .select({
      id: extensionSessions.id,
      tenantId: extensionSessions.tenantId,
      userId: extensionSessions.userId,
    })
    .from(extensionSessions)
    .where(and(eq(extensionSessions.apiKeyHash, apiKeyHash), isNull(extensionSessions.revokedAt)))
    .limit(1);
  return row ?? null;
}

// Returns true iff the tenant currently has ≥1 live (connected, non-revoked)
// extension session. Used by the master-agent to decide whether to skip
// crawler-based discovery when the strategist has marked the mission as
// extension-primary. Scoped by tenantId in the WHERE clause; no RLS helper
// needed because only a boolean leaks.
export async function isExtensionConnected(tenantId: string): Promise<boolean> {
  const { db } = await import('../config/database.js');
  // Mirror the dispatcher's session-eligibility predicate (see ~line 619): with
  // ENABLE_MULTI_WORKSPACE_DISPATCH on, a session reaches this tenant if its USER
  // is a member via user_tenants — this is the ONLY predicate that recognises the
  // new tenant-less (tenant_id = NULL) multi-workspace sessions. Without this the
  // pause gate sees "no extension" for a tenant whose user is connected via a
  // multi-workspace session, and the master-agent pauses while the extension is
  // actually live and draining that tenant's tasks. Flag off → exact legacy behaviour.
  const tenantMatch = env.ENABLE_MULTI_WORKSPACE_DISPATCH
    ? exists(
        db
          .select({ one: sql<number>`1` })
          .from(userTenants)
          .where(and(
            eq(userTenants.userId, extensionSessions.userId),
            eq(userTenants.tenantId, tenantId),
            inArray(userTenants.role, ['owner', 'admin', 'member']),
          )),
      )
    : eq(extensionSessions.tenantId, tenantId);

  const [row] = await db
    .select({ id: extensionSessions.id })
    .from(extensionSessions)
    .where(
      and(
        tenantMatch!,
        eq(extensionSessions.connected, true),
        isNull(extensionSessions.revokedAt),
      ),
    )
    .limit(1);
  return !!row;
}

// ─── Single-profile re-scrape handler ───────────────────────────────────────
//
// Triggered by POST /api/contacts/:id/rescrape-linkedin → a `fetch_profile`
// extension task that opens ONE person's /in/<handle>/ page. We deliberately
// do NOT overwrite the live firstName/lastName/title — the scrape is stored as
// a SUGGESTION on rawData.linkedinRescrape so the dashboard can pre-fill the
// edit modal and let the user confirm (or override) before saving. This honors
// "fail loud over fabricate": a bad scrape never silently clobbers good data.
// ─── Global LinkedIn People search → import as leads ─────────────────────────
// Unlike fetch_company_team (people of one known company), search_people returns
// people across many companies. Save each as a contact with companyId = NULL
// (companyName left blank — the card rarely exposes a clean employer). Dedup by
// the (tenant_id, linkedin_url) unique constraint so re-running a search is safe.
// Optional geo post-filter (best-effort: only drops a person when their card
// location is present AND clearly outside the requested regions).
async function handlePeopleSearchComplete(task: ExtensionTask, result: Record<string, unknown>): Promise<IngestSummary> {
  const rawPeople = (Array.isArray(result.people) ? result.people : []) as Array<{
    name?: string; title?: string; linkedinUrl?: string; location?: string;
  }>;
  const params = (task.params as { geographyFilter?: { regions?: string[] }; keyword?: string } | null) ?? {};
  const regions = (params.geographyFilter?.regions ?? []).filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  const keyword = typeof params.keyword === 'string' ? params.keyword : null;

  let saved = 0;
  const MAX_SAVE = 50; // a single user-initiated search shouldn't flood the pipeline
  for (const person of rawPeople) {
    if (saved >= MAX_SAVE) break;
    const url = (person.linkedinUrl || '').split('?')[0];
    if (!url) continue;

    // Best-effort geo filter — keep when location is unknown (don't over-drop).
    if (regions.length && person.location && !isLocationInRegions(person.location, regions)) continue;

    const cleanName = sanitizePersonName(person.name);
    if (!cleanName) continue;
    const nameParts = cleanName.split(/\s+/);
    const pFirstName = nameParts[0] || '';
    const pLastName = nameParts.slice(1).join(' ');
    if (!pFirstName || /^(view|profile)$/i.test(pFirstName)) continue;

    try {
      const [existing] = await withTenant(task.tenantId, async (tx) => {
        return tx.select({ id: contacts.id }).from(contacts)
          .where(and(eq(contacts.tenantId, task.tenantId), eq(contacts.linkedinUrl, url)))
          .limit(1);
      });
      if (existing) continue; // dedup by linkedin_url across the whole tenant

      const [inserted] = await withTenant(task.tenantId, async (tx) => {
        return tx.insert(contacts).values({
          tenantId: task.tenantId,
          masterAgentId: task.masterAgentId ?? undefined,
          firstName: pFirstName,
          lastName: pLastName,
          title: sanitizeTitle(person.title),
          linkedinUrl: url,
          companyId: null,
          source: 'linkedin_profile',
          sourceType: 'ai_discovery',
          sourceMetadata: { discoverySource: 'linkedin_people_search', keyword },
          rawData: { discoverySource: 'linkedin_people_search', keyword, ...person },
        }).returning({ id: contacts.id });
      });
      if (!inserted) continue;
      saved++;
      try {
        await withTenant(task.tenantId, async (tx) => {
          await tx.insert(prospectStages).values({
            contactId: inserted.id,
            tenantId: task.tenantId,
            currentStage: 'new',
          }).onConflictDoNothing();
        });
      } catch (err) {
        logger.warn({ err, contactId: inserted.id }, 'search_people: prospect_stages seed failed (non-fatal)');
      }
    } catch (err) {
      logger.warn({ err, linkedinUrl: url }, 'search_people: contact insert failed');
    }
  }

  logger.info({ taskId: task.id, extracted: rawPeople.length, saved, keyword, regions }, 'search_people complete');
  return { extracted: rawPeople.length, saved };
}

async function handleProfileComplete(task: ExtensionTask, result: Record<string, unknown>): Promise<IngestSummary> {
  const contactId = (task.params as { contactId?: string } | null)?.contactId;
  if (!contactId) {
    logger.error({ taskId: task.id }, 'fetch_profile result has no contactId in params');
    return { extracted: 0, saved: 0 };
  }

  const name = sanitizePersonName(typeof result.name === 'string' ? result.name : undefined);
  const title = sanitizeTitle(typeof result.title === 'string' ? result.title : undefined);
  // Additive fields (fetch-profile.js now reverse-engineers the current
  // employer from the Experience section). Older extension builds omit them —
  // the branch below is skipped when they're absent, so this is backwards-safe.
  const companyName = typeof result.companyName === 'string' ? result.companyName.trim() : '';
  const companyLinkedinUrl = typeof result.companyLinkedinUrl === 'string'
    ? normalizeLiCompanyUrlFromRaw(result.companyLinkedinUrl) : '';

  if (!name && !title) {
    logger.warn({ taskId: task.id, contactId }, 'fetch_profile yielded no usable name/title');
    // Still record the attempt so the dashboard poll stops waiting and can
    // surface "couldn't read this profile" instead of spinning forever.
  }

  const suggestion = {
    name: name ?? null,
    title: title ?? null,
    scrapedAt: new Date().toISOString(),
  };

  const outcome = await withTenant(task.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ rawData: contacts.rawData, companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (!existing) {
      logger.warn({ taskId: task.id, contactId }, 'fetch_profile: contact not found');
      return { saved: 0, needsCompanyLink: false as const };
    }
    const rawData = { ...((existing.rawData as Record<string, unknown> | null) ?? {}), linkedinRescrape: suggestion };
    await tx
      .update(contacts)
      .set({ rawData, updatedAt: new Date() })
      .where(eq(contacts.id, contactId));
    // Only reverse-engineer the employer when the contact has no company yet
    // (the google_serp discovery path) AND the profile gave us something to
    // link. Already-linked contacts keep their company untouched.
    return {
      saved: 1,
      needsCompanyLink: !existing.companyId && (!!companyLinkedinUrl || companyName.length >= 2),
    };
  });

  // ── Reverse-engineer + link the current employer (google_serp path) ────────
  if (outcome.needsCompanyLink) {
    try {
      const derivedName = companyName.length >= 2
        ? companyName
        : (companyLinkedinUrl.match(LI_COMPANY_RE)?.[1] ?? '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).trim();
      if (derivedName.length >= 2) {
        const company = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name: derivedName,
            ...(companyLinkedinUrl ? { linkedinUrl: companyLinkedinUrl } : {}),
            rawData: { discoverySource: 'google_serp_profile', reverseEngineeredFromContactId: contactId },
          },
          task.masterAgentId ?? undefined,
        );
        await withTenant(task.tenantId, async (tx) => {
          await tx.update(contacts).set({ companyId: company.id, updatedAt: new Date() }).where(eq(contacts.id, contactId));
        });
        // Enrich the freshly-linked company (info+team) and the contact itself.
        if (companyLinkedinUrl) {
          await enqueueCompanyEnrichmentFanout(
            task.tenantId,
            task.masterAgentId ?? undefined,
            [{ linkedinUrl: companyLinkedinUrl, companyId: company.id }],
            { crawlWebsite: true },
          );
        }
        await dispatchJob(task.tenantId, 'enrichment', {
          contactId,
          masterAgentId: task.masterAgentId ?? undefined,
          source: 'google_serp_profile',
        });
        logger.info({ taskId: task.id, contactId, companyId: company.id, companyName: derivedName, companyLinkedinUrl }, 'fetch_profile: reverse-engineered + linked employer');
      }
    } catch (err) {
      logger.warn({ err, taskId: task.id, contactId }, 'fetch_profile: employer reverse-engineer failed (non-fatal)');
    }
  }

  logger.info({ taskId: task.id, contactId, name: suggestion.name, title: suggestion.title }, 'fetch_profile ingested');
  return { extracted: name || title ? 1 : 0, saved: outcome.saved };
}

// ─── Google SERP (web_search strategy) ──────────────────────────────────────
// The extension returns { results: [{ url, title, snippet, position }] } from a
// google.com/search dork. Routing is LinkedIn-only for now: company URLs → save
// + enrich; person URLs → save contact + a fetch_profile that reverse-engineers
// the employer (handleProfileComplete). Non-LinkedIn URLs are left in the task
// result for a future open-web router. The scraper itself stays generic.

const LI_COMPANY_RE = /linkedin\.com\/company\/([^/?#]+)/i;
const LI_PERSON_RE = /linkedin\.com\/in\/([^/?#]+)/i;

/**
 * True only when the URL's HOST is linkedin.com (or a subdomain). The classify
 * regexes above are unanchored substring matches, so without this a Google
 * redirect / aggregator / a google.com page whose text merely contains
 * "linkedin.com/company/…" would be saved as a LinkedIn company. Parse the host
 * and require it to actually be LinkedIn.
 */
function isLinkedInHost(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'linkedin.com' || h.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

// Megabrand / generic company slugs that rank high on broad dorks and are never
// the local business we're after — skip so they don't pollute the pipeline.
const SERP_COMPANY_SLUG_BLOCKLIST = new Set<string>([
  'google', 'youtube', 'facebook', 'meta', 'linkedin', 'instagram', 'twitter', 'x',
  'microsoft', 'apple', 'amazon', 'tiktok', 'whatsapp', 'gmail',
]);

/** Normalize any LinkedIn company URL/slug string to canonical form. */
function normalizeLiCompanyUrlFromRaw(raw: string): string {
  const m = raw.match(LI_COMPANY_RE);
  return m ? `https://www.linkedin.com/company/${m[1].toLowerCase()}` : '';
}

// Social / aggregator / directory hosts that rank high on a "Name Region" web
// dork but are never the company's OWN site — skip them when picking a website
// to enrich (we want the domain that carries a generic inbox).
const NON_WEBSITE_HOST_SUFFIXES = [
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'pinterest.com', 'snapchat.com', 'threads.net',
  'google.com', 'goo.gl', 'g.co', 'yelp.com', 'tripadvisor.com', 'wikipedia.org',
  'foursquare.com', 'crunchbase.com', 'bloomberg.com', 'glassdoor.com',
  'indeed.com', 'apple.com', 'play.google.com', 'maps.google.com', 'wa.me',
  'booking.com', 'trustpilot.com', 'yellowpages.com', 'europages.com',
];

/** True when the URL is a real, enrichable company website (not social/aggregator). */
function isEnrichableWebsite(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return !NON_WEBSITE_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  } catch {
    return false;
  }
}

/** Strip "| LinkedIn" and follower-count tails from a SERP result title. */
function cleanSerpTitle(title: string | undefined): string {
  return (title ?? '')
    .replace(/\s*[|–—-]\s*LinkedIn\s*$/i, '')
    .replace(/\s*·?\s*[\d.,]+\s*(followers|abonn[ée]s).*$/i, '')
    .trim();
}

async function handleSerpComplete(task: ExtensionTask, result: Record<string, unknown>): Promise<IngestSummary> {
  const results = (Array.isArray(result.results) ? result.results : []) as Array<{
    url?: string; title?: string; snippet?: string;
  }>;
  const dork = (task.params as { dork?: string } | null)?.dork ?? null;

  // ── Strict dork-fallback path (GMaps-enrichment-only) ──────────────────────
  // This SERP was fired because GMaps had no confident match for a known list
  // company. Don't run the LinkedIn-only discovery routing — take the top
  // organic non-social result as the company's official website and enrich it
  // (ingestGmapsBusiness binds to the pre-created row by name, sets the domain,
  // and dispatches the generic-email crawl). Fail loud (leave gmapsNotFound) if
  // nothing usable turns up.
  const strict = (task.params as { strictMatch?: StrictMatch } | null)?.strictMatch;
  if (strict?.companyId) {
    const website = results
      .map((r) => (r.url ?? '').split('#')[0])
      .find((u) => u && isEnrichableWebsite(u));
    if (!website) {
      logger.info(
        { taskId: task.id, companyId: strict.companyId, name: strict.name, candidates: results.length },
        'search_serp dork fallback: no usable website in results (fail-soft)',
      );
      return { extracted: results.length, saved: 0 };
    }
    try {
      const ingest = await ingestGmapsBusiness(
        task.tenantId,
        task.masterAgentId ?? undefined,
        { name: strict.name, website, knownCompanyId: strict.companyId },
      );
      await markRawDataFlag(task.tenantId, ingest.companyId, {
        source: 'user_list',
        listEntry: true,
        gmapsNotFound: false,
        dorkResolved: true,
      });
      logger.info(
        { taskId: task.id, companyId: strict.companyId, name: strict.name, website },
        'search_serp dork fallback: website resolved + enriched',
      );
      return { extracted: results.length, saved: 1 };
    } catch (err) {
      logger.warn({ err, taskId: task.id, companyId: strict.companyId }, 'search_serp dork fallback: ingest failed');
      return { extracted: results.length, saved: 0 };
    }
  }

  let saved = 0;
  let companiesSaved = 0;
  let contactsSaved = 0;
  const MAX_SAVE = 60;
  const seenCompany = new Set<string>();
  const seenPerson = new Set<string>();

  for (const r of results) {
    if (saved >= MAX_SAVE) break;
    const rawUrl = (r.url ?? '').split('#')[0];
    if (!rawUrl) continue;
    // Host must genuinely be LinkedIn — kills google.com / redirect / aggregator
    // URLs that merely contain a "linkedin.com/company/…" substring.
    if (!isLinkedInHost(rawUrl)) continue;

    const companyMatch = rawUrl.match(LI_COMPANY_RE);
    const personMatch = rawUrl.match(LI_PERSON_RE);

    // ── Company result → save + fan out enrichment ──────────────────────────
    if (companyMatch) {
      const slug = companyMatch[1];
      if (SERP_COMPANY_SLUG_BLOCKLIST.has(slug.toLowerCase())) continue;
      const url = `https://www.linkedin.com/company/${slug.toLowerCase()}`;
      if (seenCompany.has(url)) continue;
      seenCompany.add(url);
      const cleaned = cleanSerpTitle(r.title);
      const name = cleaned.length >= 2
        ? cleaned
        : slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).trim();
      if (name.length < 2) continue;
      try {
        const company = await saveOrUpdateCompanyStatic(
          task.tenantId,
          { name, linkedinUrl: url, rawData: { discoverySource: 'google_serp', dork, serpTitle: r.title ?? null } },
          task.masterAgentId ?? undefined,
        );
        await enqueueCompanyEnrichmentFanout(
          task.tenantId,
          task.masterAgentId ?? undefined,
          [{ linkedinUrl: url, companyId: company.id }],
          { crawlWebsite: true },
        );
        saved++; companiesSaved++;
      } catch (err) {
        logger.warn({ err, url }, 'search_serp: company save/fanout failed');
      }
      continue;
    }

    // ── Person result → save contact + reverse-engineer employer via profile ─
    if (personMatch) {
      const slug = personMatch[1];
      const url = `https://www.linkedin.com/in/${slug}`;
      if (seenPerson.has(url)) continue;
      seenPerson.add(url);
      // SERP title for /in/ is usually "First Last - Title - Company | LinkedIn".
      const cleaned = cleanSerpTitle(r.title);
      const segments = cleaned.split(/\s+[-–—]\s+/);
      const cleanName = sanitizePersonName(segments[0]);
      if (!cleanName) continue;
      const nameParts = cleanName.split(/\s+/);
      const pFirstName = nameParts[0] || '';
      const pLastName = nameParts.slice(1).join(' ');
      if (!pFirstName || /^(view|profile)$/i.test(pFirstName)) continue;
      try {
        const [existing] = await withTenant(task.tenantId, async (tx) => {
          return tx.select({ id: contacts.id }).from(contacts)
            .where(and(eq(contacts.tenantId, task.tenantId), eq(contacts.linkedinUrl, url)))
            .limit(1);
        });
        if (existing) continue;
        const [inserted] = await withTenant(task.tenantId, async (tx) => {
          return tx.insert(contacts).values({
            tenantId: task.tenantId,
            masterAgentId: task.masterAgentId ?? undefined,
            firstName: pFirstName,
            lastName: pLastName,
            title: sanitizeTitle(segments[1]),
            linkedinUrl: url,
            companyId: null,
            source: 'web_search',
            sourceType: 'ai_discovery',
            sourceMetadata: { discoverySource: 'google_serp', dork },
            rawData: { discoverySource: 'google_serp', dork, serpTitle: r.title ?? null, serpSnippet: r.snippet ?? null },
          }).returning({ id: contacts.id });
        });
        if (!inserted) continue;
        saved++; contactsSaved++;
        try {
          await withTenant(task.tenantId, async (tx) => {
            await tx.insert(prospectStages).values({
              contactId: inserted.id, tenantId: task.tenantId, currentStage: 'new',
            }).onConflictDoNothing();
          });
        } catch (err) {
          logger.warn({ err, contactId: inserted.id }, 'search_serp: prospect_stages seed failed (non-fatal)');
        }
        // Open the profile → handleProfileComplete reverse-engineers + links the
        // employer once fetch-profile returns companyLinkedinUrl/companyName.
        await enqueueExtensionTask({
          tenantId: task.tenantId,
          masterAgentId: task.masterAgentId ?? undefined,
          site: 'linkedin',
          type: 'fetch_profile',
          params: { contactId: inserted.id, linkedinUrl: url, resolveCompany: true },
          priority: 4,
        });
      } catch (err) {
        logger.warn({ err, url }, 'search_serp: contact insert failed');
      }
      continue;
    }
    // Non-LinkedIn URL — left for a future open-web router.
  }

  logger.info({ taskId: task.id, extracted: results.length, saved, companiesSaved, contactsSaved, dork }, 'search_serp complete');
  return { extracted: results.length, saved };
}

// ─── Parallel-fetch completion handlers ─────────────────────────────────────
//
// These split the legacy fetch_company logic into two independent handlers:
//
//   handleCompanyInfoComplete:
//     Merges about-page fields (industry, size, HQ, description, etc.) into
//     the company row. Sets rawData.infoFetchedAt. Dispatches enrichment
//     (we have the real domain). Triggers the fit scorer.
//
//   handleCompanyTeamComplete:
//     Merges the people array into rawData.people. Sets rawData.teamFetchedAt.
//     Inserts the top-3 ranked people as contacts (preserving existing
//     outreach behaviour). Dispatches per-contact enrichment. Triggers the
//     fit scorer.
//
// Each handler tolerates the other not having run yet — the fit scorer reads
// data_completeness from whichever fetched-at flags are present.

async function handleCompanyInfoComplete(
  task: ExtensionTask,
  c: Record<string, unknown>,
): Promise<{ extracted: number; saved: number }> {
  const name = String(c.name ?? '').trim();
  const p = task.params as { linkedinUrl?: string; companyId?: string; crawlWebsite?: boolean };
  if (!name && !p.companyId) {
    logger.debug({ taskId: task.id }, 'fetch_company_info: no name + no companyId, skipping');
    return { extracted: 0, saved: 0 };
  }

  // Merge into companies row. saveOrUpdateCompanyStatic is id → domain → name
  // so passing companyId from the auto-chain hits the exact row.
  const savedCompany = await saveOrUpdateCompanyStatic(
    task.tenantId,
    {
      id: p.companyId,
      name: name || 'unknown',
      domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
      industry: (c.industry as string) ?? undefined,
      size: (c.size as string) ?? undefined,
      linkedinUrl: (c.linkedinUrl as string) ?? p.linkedinUrl,
      description: (c.description as string) ?? undefined,
      rawData: { source: 'linkedin_extension_info', infoFetchedAt: new Date().toISOString(), ...c },
    },
    task.masterAgentId ?? undefined,
  );

  // Dispatch enrichment now that we have the real domain.
  await dispatchJob(task.tenantId, 'enrichment', {
    companyId: savedCompany.id,
    masterAgentId: task.masterAgentId ?? undefined,
    source: 'linkedin_extension_info',
  });

  // Trigger fit scorer asynchronously. The worker debounces within 30s so a
  // sibling team_arrived event fired moments later won't double-score.
  if (task.masterAgentId) {
    try {
      await enqueueFitScore({
        tenantId: task.tenantId,
        companyId: savedCompany.id,
        reason: 'info_arrived',
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), companyId: savedCompany.id },
        'enqueueFitScore after info_arrived failed (non-fatal)',
      );
    }
  }

  // list_verification: crawl the real website discovered on the About page
  // (skips LinkedIn/Maps domains). The source URL from the uploaded list is
  // crawled separately at dispatch time.
  if (p.crawlWebsite && typeof c.website === 'string' && c.website.trim()) {
    await crawlAndStoreForCompany(task.tenantId, savedCompany.id, 'website', c.website.trim());
  }

  logger.info(
    { taskId: task.id, companyId: savedCompany.id, name: savedCompany.name },
    'fetch_company_info complete',
  );
  return { extracted: 1, saved: 1 };
}

async function handleCompanyTeamComplete(
  task: ExtensionTask,
  c: Record<string, unknown>,
): Promise<{ extracted: number; saved: number }> {
  const p = task.params as { linkedinUrl?: string; companyId?: string; keyword?: string };
  const scrapedPeople = (c.people ?? []) as Array<{ name: string; title: string; linkedinUrl: string }>;
  // Drop LinkedIn followers / "Pages similaires" sidebar leaks ("X suit cette
  // page", titles full of "N abonnés") BEFORE they reach rawData or contacts.
  const rawPeople = scrapedPeople.filter((person) => !isJunkPerson(person.name, person.title));
  if (rawPeople.length < scrapedPeople.length) {
    logger.info(
      { taskId: task.id, companyId: p.companyId, dropped: scrapedPeople.length - rawPeople.length, kept: rawPeople.length },
      'fetch_company_team: dropped followers/similar-page sidebar leaks',
    );
  }
  const taskKeyword = (typeof p.keyword === 'string' && p.keyword.trim()) ? p.keyword.trim() : null;
  // Defensive: also accept the extension echoing the keyword back on the
  // result payload — useful if dispatcher → extension param plumbing ever
  // drifts.
  const resultKeyword = (typeof c.keyword === 'string' && c.keyword.trim()) ? c.keyword.trim() : null;
  const keyword = taskKeyword ?? resultKeyword;
  const bucketKey = keyword ?? '__legacy__';

  // Find the target company row. Direct-merge into rawData; we deliberately
  // do NOT go through saveOrUpdateCompanyStatic because that helper requires
  // a name and would clobber the company name if the team handler arrives
  // without one.
  const savedCompany = await withTenant(task.tenantId, async (tx) => {
    let row: typeof companies.$inferSelect | undefined;
    if (p.companyId) {
      [row] = await tx.select().from(companies)
        .where(and(eq(companies.tenantId, task.tenantId), eq(companies.id, p.companyId)))
        .limit(1);
    }
    if (!row && p.linkedinUrl) {
      [row] = await tx.select().from(companies)
        .where(and(eq(companies.tenantId, task.tenantId), eq(companies.linkedinUrl, p.linkedinUrl)))
        .limit(1);
    }
    if (!row) return null;

    const existingRaw = (row.rawData ?? {}) as Record<string, unknown>;
    const existingByKeyword = (existingRaw.peopleByKeyword as Record<string, unknown> | undefined) ?? {};
    const mergedPeople = mergePeopleByKeyword(existingRaw.people, existingByKeyword, bucketKey, rawPeople);

    const [updated] = await tx.update(companies).set({
      rawData: {
        ...existingRaw,
        // Keep `people` populated with the deduped union for backwards
        // compatibility with anything reading the flat list.
        people: mergedPeople.flat,
        peopleByKeyword: mergedPeople.byKeyword,
        teamFetchedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    }).where(eq(companies.id, row.id)).returning();
    return updated;
  });

  if (!savedCompany) {
    logger.warn({ taskId: task.id, companyId: p.companyId, linkedinUrl: p.linkedinUrl, keyword }, 'fetch_company_team: no target company row found');
    return { extracted: rawPeople.length, saved: 0 };
  }

  // We only want the top few KEY people per company — not every employee.
  // A company can receive several `fetch_company_team` calls (one per
  // teamRoleKeyword), so the per-fetch cap alone would let a 3-keyword agent
  // save 3×N contacts. Enforce a COMPANY-WIDE cap instead: count the team
  // contacts already saved for this company and only top up to KEY_PEOPLE_CAP.
  const KEY_PEOPLE_CAP = 3;
  let alreadyForCompany = 0;
  try {
    const [countRow] = await withTenant(task.tenantId, async (tx) => {
      const conds = [
        eq(contacts.tenantId, task.tenantId),
        eq(contacts.companyId, savedCompany.id),
        sql`${contacts.sourceMetadata}->>'discoverySource' = 'linkedin_extension_people'`,
      ];
      if (task.masterAgentId) conds.push(eq(contacts.masterAgentId, task.masterAgentId));
      return tx.select({ n: sql<number>`count(*)::int` }).from(contacts).where(and(...conds));
    });
    alreadyForCompany = countRow?.n ?? 0;
  } catch (err) {
    logger.debug({ err, companyId: savedCompany.id }, 'team cap: existing-count query failed (non-fatal) — treating as 0');
  }
  const remainingSlots = Math.max(0, KEY_PEOPLE_CAP - alreadyForCompany);

  // With keyword-scoped fetches the candidate pool is already role-filtered,
  // so the title-score ranking is just a tiebreaker for which of the top hits
  // fills the remaining company slots.
  const rankedPeople = rankPeopleByTitle(rawPeople);
  let savedCount = 0;
  for (const person of rankedPeople) {
    if (savedCount >= remainingSlots) break;
    const cleanName = sanitizePersonName(person.name);
    if (!cleanName) {
      logger.debug({ raw: person.name, linkedinUrl: person.linkedinUrl }, 'Skipping person with corrupted/invalid name');
      continue;
    }
    const nameParts = cleanName.split(/\s+/);
    const pFirstName = nameParts[0] || '';
    const pLastName = nameParts.slice(1).join(' ');
    if (!pFirstName) continue;
    if (/^(view|profile)$/i.test(pFirstName) || (pLastName && /\b(view|profile)\b/i.test(pLastName))) {
      logger.debug({ pFirstName, pLastName }, 'Skipping person — name parts contain view/profile junk');
      continue;
    }

    try {
      if (person.linkedinUrl) {
        const [existing] = await withTenant(task.tenantId, async (tx) => {
          const conds = [
            eq(contacts.tenantId, task.tenantId),
            eq(contacts.linkedinUrl, person.linkedinUrl),
          ];
          if (task.masterAgentId) {
            conds.push(eq(contacts.masterAgentId, task.masterAgentId));
            conds.push(eq(contacts.companyId, savedCompany.id));
          }
          return tx.select({ id: contacts.id }).from(contacts)
            .where(and(...conds))
            .limit(1);
        });
        if (existing) {
          logger.info(
            {
              taskId: task.id,
              personLinkedinUrl: person.linkedinUrl,
              masterAgentId: task.masterAgentId,
              companyId: savedCompany.id,
              existingContactId: existing.id,
            },
            'fetch_company_team: contact dedup matched — skipping insert',
          );
          continue;
        }
      }

      const [inserted] = await withTenant(task.tenantId, async (tx) => {
        return tx.insert(contacts).values({
          tenantId: task.tenantId,
          masterAgentId: task.masterAgentId ?? undefined,
          firstName: pFirstName,
          lastName: pLastName,
          title: sanitizeTitle(person.title),
          linkedinUrl: person.linkedinUrl || undefined,
          companyId: savedCompany.id,
          companyName: savedCompany.name,
          source: 'linkedin_profile',
          // New Sales Operations source-type vocabulary, in parallel with the
          // legacy `source` enum above. New code reads source_type.
          sourceType: 'ai_discovery',
          sourceMetadata: { discoverySource: 'linkedin_extension_people' },
          rawData: { discoverySource: 'linkedin_extension_people', ...person },
        }).returning({ id: contacts.id });
      });

      if (inserted) {
        savedCount++;
        // Mirror the contact to prospect_stages so the Stage 2 detail page +
        // Stage 3 triage worker see a row. Best-effort; failure is non-fatal.
        try {
          await withTenant(task.tenantId, async (tx) => {
            await tx.insert(prospectStages).values({
              contactId: inserted.id,
              tenantId: task.tenantId,
              currentStage: 'new',
            }).onConflictDoNothing();
          });
        } catch (err) {
          logger.debug({ err, contactId: inserted.id }, 'Failed to seed prospect_stages for AI-discovered contact (non-fatal)');
        }
        // Append a timeline event so the contact's history shows where
        // they came from. Best-effort; failure must not abort the dispatch.
        try {
          await logEvent({
            tenantId: task.tenantId,
            contactId: inserted.id,
            type: 'contact_added',
            eventCategory: 'discovery',
            actorType: 'system',
            masterAgentId: task.masterAgentId ?? undefined,
            title: 'Discovered via LinkedIn team scan',
            metadata: {
              sourceType: 'ai_discovery',
              discoverySource: 'linkedin_extension_people',
              companyId: savedCompany.id,
              companyName: savedCompany.name,
              taskId: task.id,
            },
          });
        } catch (err) {
          logger.debug({ err, contactId: inserted.id }, 'Failed to log contact_added event (non-fatal)');
        }
        if (task.masterAgentId) {
          try {
            await dispatchJob(task.tenantId, 'enrichment', {
              contactId: inserted.id,
              masterAgentId: task.masterAgentId,
              source: 'linkedin_extension_people',
            });
          } catch (err) {
            logger.debug({ err, contactId: inserted.id }, 'Failed to dispatch per-contact enrichment (non-fatal)');
          }
        }
      }
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined,
          personName: person.name,
          personLinkedinUrl: person.linkedinUrl,
          taskId: task.id,
          masterAgentId: task.masterAgentId,
          companyId: savedCompany.id,
        },
        'fetch_company_team: contact insert FAILED',
      );
    }
  }

  // Trigger fit scorer asynchronously (debounced; see worker).
  if (task.masterAgentId) {
    try {
      await enqueueFitScore({
        tenantId: task.tenantId,
        companyId: savedCompany.id,
        reason: 'team_arrived',
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), companyId: savedCompany.id },
        'enqueueFitScore after team_arrived failed (non-fatal)',
      );
    }
  }

  if (rawPeople.length > 0 && savedCount === 0) {
    logger.warn(
      {
        taskId: task.id,
        companyId: savedCompany.id,
        peopleScraped: rawPeople.length,
        contactsSaved: savedCount,
        sampleNames: rawPeople.slice(0, 3).map((p) => p.name),
      },
      'fetch_company_team: scraped people but saved 0 contacts (silent drop — investigate sanitizer or dedup)',
    );
  } else {
    logger.info(
      { taskId: task.id, companyId: savedCompany.id, peopleScraped: rawPeople.length, contactsSaved: savedCount },
      'fetch_company_team complete',
    );
  }
  return { extracted: rawPeople.length, saved: savedCount };
}

