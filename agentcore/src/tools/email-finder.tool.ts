import { eq, and } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { domainPatterns } from '../db/schema/index.js';
import { queueRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

/**
 * Email-finder.
 *
 * Server-wide guarantees:
 *   - Reacher SMTP probes are SEQUENTIAL with a 1s gap between attempts.
 *     The user's Reacher instance is rate-limited to 300 checks/day across
 *     the entire server (all tenants combined).
 *   - The 300/day counter lives in Redis (`reacher:daily:checks`) so all
 *     worker processes share it.
 *   - Once a pattern is verified for a domain it is persisted both in-memory
 *     (process-local cache) and in `domain_patterns` (durable). Every other
 *     team member at that domain is built via `applyCachedPatternToTeam`
 *     with ZERO SMTP cost.
 */

const MAX_DAILY_EMAIL_CHECKS = 300;
const REACHER_DAILY_KEY = 'reacher:daily:checks';
const PATTERN_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h in-memory cache

// In-memory pattern cache: avoids a DB hit when the same worker process
// enriches multiple companies on the same domain.
const domainPatternCache = new Map<string, { templateId: string; verifiedAt: number }>();

// In-memory catch-all cache: domains where Reacher reported is_catch_all=true.
// Catch-all servers accept any local-part, so a "safe" reply is meaningless —
// we skip these domains entirely to stop emitting unverifiable false-positives.
const domainCatchAllCache = new Map<string, number>(); // domain → flaggedAt(ms)
const CATCH_ALL_CACHE_TTL = 24 * 60 * 60 * 1000;

// ── Pattern templates ────────────────────────────────────────────────────────
// Templates are identified by string id (persisted in `domain_patterns.pattern`).
// Adding new templates is safe — never rename existing ones.
//
// `_firsttoken` suffix denotes a variant for hyphenated/multi-word first names
// where only the first token of the first name is used (e.g. "Vlad-George
// Iacob" → "vlad.iacob"). These variants are emitted only when applicable.

const PATTERN_TEMPLATES: ReadonlyArray<{ id: string; build: (f: string, l: string, d: string) => string }> = [
  { id: 'first.last',  build: (f, l, d) => `${f}.${l}@${d}` },
  { id: 'flast',       build: (f, l, d) => `${f[0]}${l}@${d}` },
  { id: 'first',       build: (f, _l, d) => `${f}@${d}` },
  { id: 'f.last',      build: (f, l, d) => `${f[0]}.${l}@${d}` },
  { id: 'firstlast',   build: (f, l, d) => `${f}${l}@${d}` },
  { id: 'last.first',  build: (f, l, d) => `${l}.${f}@${d}` },
  { id: 'first_last',  build: (f, l, d) => `${f}_${l}@${d}` },
  { id: 'last',        build: (_f, l, d) => `${l}@${d}` },
  { id: 'f1l1',        build: (f, l, d) => `${f[0]}${l[0]}@${d}` },
];

// Subset re-emitted with first-token-only when the original first name has
// hyphen/space (e.g. "Vlad-George" → "vlad").
const FIRST_TOKEN_TEMPLATE_IDS = ['first.last', 'flast', 'f.last'] as const;

function normalizeForEmail(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * If the original first name contains "-" or whitespace, return the first
 * normalized token. Otherwise null.
 *   "Vlad-George" → "vlad"
 *   "Mary Jane"   → "mary"
 *   "Maria"       → null
 */
function firstTokenOnly(first: string): string | null {
  const tokens = first
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[-\s]+/)
    .map((t) => t.replace(/[^a-z]/g, ''))
    .filter(Boolean);
  if (tokens.length > 1 && tokens[0] && tokens[0] !== normalizeForEmail(first)) {
    return tokens[0];
  }
  return null;
}

interface PatternCandidate { templateId: string; email: string; isFirstToken: boolean }

function generatePatterns(first: string, last: string, domain: string): PatternCandidate[] {
  const f = normalizeForEmail(first);
  const l = normalizeForEmail(last);
  if (!f || !l || !domain) return [];
  const out: PatternCandidate[] = PATTERN_TEMPLATES.map((t) => ({
    templateId: t.id,
    email: t.build(f, l, domain),
    isFirstToken: false,
  }));
  const fAlt = firstTokenOnly(first);
  if (fAlt) {
    for (const id of FIRST_TOKEN_TEMPLATE_IDS) {
      const tpl = PATTERN_TEMPLATES.find((t) => t.id === id);
      if (!tpl) continue;
      out.push({
        templateId: `${id}_firsttoken`,
        email: tpl.build(fAlt, l, domain),
        isFirstToken: true,
      });
    }
  }
  return out;
}

function buildFromTemplate(templateId: string, first: string, last: string, domain: string): string | null {
  const isFirstToken = templateId.endsWith('_firsttoken');
  const baseId = isFirstToken ? templateId.slice(0, -'_firsttoken'.length) : templateId;
  const template = PATTERN_TEMPLATES.find((t) => t.id === baseId);
  if (!template) return null;
  let f: string;
  if (isFirstToken) {
    const fAlt = firstTokenOnly(first);
    if (!fAlt) return null;
    f = fAlt;
  } else {
    f = normalizeForEmail(first);
  }
  const l = normalizeForEmail(last);
  if (!f || !l || !domain) return null;
  return template.build(f, l, domain);
}

// ── Reacher daily counter (Redis, server-wide) ───────────────────────────────

function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return Math.max(60, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

/**
 * Atomically reserve one Reacher slot for today.
 * Returns false if today's 300/day server-wide cap has been reached.
 */
async function tryConsumeReacherSlot(): Promise<boolean> {
  const newCount = await queueRedis.incr(REACHER_DAILY_KEY);
  if (newCount === 1) {
    await queueRedis.expire(REACHER_DAILY_KEY, secondsUntilUtcMidnight());
  }
  if (newCount > MAX_DAILY_EMAIL_CHECKS) {
    // Roll back the increment so concurrent callers see the correct count.
    await queueRedis.decr(REACHER_DAILY_KEY);
    return false;
  }
  return true;
}

export async function getReacherDailyUsage(): Promise<{ used: number; limit: number }> {
  const v = await queueRedis.get(REACHER_DAILY_KEY);
  return { used: v ? Number(v) : 0, limit: MAX_DAILY_EMAIL_CHECKS };
}

// ── Pattern cache (memory + DB) ──────────────────────────────────────────────

/** True if we have a memory-cached pattern for this domain (does NOT check DB). */
export function hasCachedPattern(domain: string): boolean {
  const cached = domainPatternCache.get(domain);
  return !!cached && Date.now() - cached.verifiedAt < PATTERN_CACHE_TTL;
}

/**
 * Returns true if the domain is known to be catch-all (any local-part is
 * accepted by SMTP). Reads memory cache first, then falls back to
 * `domain_patterns.is_catch_all`.
 *
 * Catch-all domains are skipped entirely: a "safe" Reacher reply on a
 * catch-all proves nothing about whether the actual mailbox exists, so any
 * email we emit is a guess that frequently bounces in production.
 */
async function isDomainCatchAll(domain: string): Promise<boolean> {
  const flaggedAt = domainCatchAllCache.get(domain);
  if (flaggedAt && Date.now() - flaggedAt < CATCH_ALL_CACHE_TTL) return true;
  try {
    const [row] = await db.select({ isCatchAll: domainPatterns.isCatchAll })
      .from(domainPatterns)
      .where(and(eq(domainPatterns.domain, domain), eq(domainPatterns.isCatchAll, true)))
      .limit(1);
    if (row) {
      domainCatchAllCache.set(domain, Date.now());
      return true;
    }
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : String(err), domain }, 'isDomainCatchAll: DB lookup failed');
  }
  return false;
}

interface CachedPattern { templateId: string }

function isKnownTemplateId(id: string): boolean {
  if (id.endsWith('_firsttoken')) {
    const base = id.slice(0, -'_firsttoken'.length);
    return PATTERN_TEMPLATES.some((t) => t.id === base);
  }
  return PATTERN_TEMPLATES.some((t) => t.id === id);
}

async function loadCachedPattern(domain: string): Promise<CachedPattern | null> {
  const mem = domainPatternCache.get(domain);
  if (mem && Date.now() - mem.verifiedAt < PATTERN_CACHE_TTL) {
    if (isKnownTemplateId(mem.templateId)) return { templateId: mem.templateId };
  }
  // Fall back to durable cache so workers don't re-burn SMTP checks per
  // known domain after a restart.
  try {
    const rows = await db.select().from(domainPatterns)
      .where(eq(domainPatterns.domain, domain))
      .limit(10);
    // Pick the highest-confidence row whose pattern id is recognised.
    let best: typeof rows[number] | null = null;
    for (const row of rows) {
      if (!isKnownTemplateId(row.pattern)) continue;
      // Skip _firsttoken patterns when caching across the team — they only
      // apply to the contact whose first name is hyphenated.
      if (row.pattern.endsWith('_firsttoken')) continue;
      if (!best || row.confidence > best.confidence) {
        best = row;
      }
    }
    if (best && best.confidence >= 50) {
      domainPatternCache.set(domain, { templateId: best.pattern, verifiedAt: Date.now() });
      return { templateId: best.pattern };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), domain }, 'loadCachedPattern: DB lookup failed');
  }
  return null;
}

async function persistDomainPattern(domain: string, templateId: string, opts: { isCatchAll?: boolean; mxProvider?: string } = {}): Promise<void> {
  if (!isKnownTemplateId(templateId)) return;
  // _firsttoken patterns only fit the specific hyphenated contact; don't
  // promote them to the team-wide cache. Persist with low confidence so a
  // future team member triggers a fresh probe.
  const isFirstToken = templateId.endsWith('_firsttoken');
  if (!isFirstToken) {
    domainPatternCache.set(domain, { templateId, verifiedAt: Date.now() });
  }
  try {
    const [existing] = await db.select().from(domainPatterns)
      .where(and(eq(domainPatterns.domain, domain), eq(domainPatterns.pattern, templateId)))
      .limit(1);
    if (existing) {
      await db.update(domainPatterns)
        .set({
          confirmedCount: existing.confirmedCount + 1,
          confidence: Math.min(100, existing.confidence + 25),
          isCatchAll: opts.isCatchAll ?? existing.isCatchAll,
          mxProvider: opts.mxProvider ?? existing.mxProvider,
          updatedAt: new Date(),
        })
        .where(eq(domainPatterns.id, existing.id));
    } else {
      await db.insert(domainPatterns).values({
        domain,
        pattern: templateId,
        confidence: isFirstToken ? 40 : 75,
        confirmedCount: 1,
        bouncedCount: 0,
        isCatchAll: opts.isCatchAll ?? false,
        mxProvider: opts.mxProvider,
      });
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), domain }, 'persistDomainPattern: upsert failed');
  }
}

// ── Reacher single-email probe ───────────────────────────────────────────────

interface ReacherResponse {
  is_reachable: 'safe' | 'invalid' | 'risky' | 'unknown';
  smtp: {
    can_connect_smtp?: boolean;
    is_catch_all?: boolean;
    is_deliverable?: boolean;
    error?: { type: string; message: string };
  };
  misc: { is_role_account?: boolean };
  mx?: { records?: string[] };
}

interface SingleProbeResult {
  status: 'safe' | 'invalid' | 'risky' | 'unknown' | 'catch_all' | 'error';
  raw?: ReacherResponse;
}

async function reacherCheck(candidate: string): Promise<SingleProbeResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    const response = await fetch(`${env.REACHER_URL}/v0/check_email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_email: candidate }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      logger.warn({ candidate, status: response.status }, 'Reacher API error');
      return { status: 'error' };
    }
    const result = await response.json() as ReacherResponse;
    if (result.smtp?.is_catch_all) return { status: 'catch_all', raw: result };
    return { status: result.is_reachable ?? 'unknown', raw: result };
  } catch (err) {
    logger.warn({ candidate, err: err instanceof Error ? err.message : String(err) }, 'Reacher check failed');
    return { status: 'error' };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface ProbeResult {
  email: string | null;
  method: 'cached_pattern' | 'smtp_verified' | 'catch_all' | 'cached_pattern_invalidated' | 'exhausted' | 'no_patterns' | 'daily_limit';
  attempts: number;
  templateId?: string;
}

/**
 * Sequentially probe up to ~12 patterns against Reacher to discover the
 * working email pattern for a domain we don't yet know. Each probe consumes
 * one slot from the server-wide 300/day cap. On success, the winning pattern
 * is persisted to `domain_patterns`. Future team members at this domain
 * still re-verify per-person (see `applyCachedPatternToTeam`).
 *
 * Catch-all domains are flagged and skipped — a "safe" Reacher reply on a
 * catch-all means nothing because the SMTP server accepts any local-part.
 *
 * Cache hits also re-verify per person: a pattern that worked for one
 * teammate doesn't guarantee the new person actually has a mailbox.
 */
export async function probePatternForDomain(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<ProbeResult> {
  const candidates = generatePatterns(firstName, lastName, domain);
  if (candidates.length === 0) {
    logger.warn({ firstName, lastName, domain }, 'probePatternForDomain: no patterns generated');
    return { email: null, method: 'no_patterns', attempts: 0 };
  }

  // 0. Catch-all short-circuit — never enrich
  if (await isDomainCatchAll(domain)) {
    logger.info({ domain }, 'probe: skipped (domain known catch-all)');
    return { email: null, method: 'catch_all', attempts: 0 };
  }

  // 1. Cache hit: build candidate from cached pattern, then verify per-person
  // (the cached pattern was right for someone — but the new person may not
  // have a mailbox yet at this domain).
  const cached = await loadCachedPattern(domain);
  if (cached) {
    const candidate = buildFromTemplate(cached.templateId, firstName, lastName, domain);
    if (candidate) {
      const slotOk = await tryConsumeReacherSlot();
      if (!slotOk) {
        logger.info({ domain }, 'probe: cache hit but Reacher daily cap reached');
        return { email: null, method: 'daily_limit', attempts: 0 };
      }
      const r = await reacherCheck(candidate);
      if (r.status === 'safe') {
        logger.info({ candidate, domain, templateId: cached.templateId }, 'probe: cache hit verified per-person');
        return { email: candidate, method: 'cached_pattern', attempts: 1, templateId: cached.templateId };
      }
      if (r.status === 'catch_all') {
        domainCatchAllCache.set(domain, Date.now());
        await persistDomainPattern(domain, cached.templateId, { isCatchAll: true, mxProvider: r.raw?.mx?.records?.[0] });
        logger.info({ domain, candidate }, 'probe: cache hit revealed catch-all, flagging and skipping');
        return { email: null, method: 'catch_all', attempts: 1 };
      }
      // Cached pattern didn't verify for this person — fall through to full
      // probe. The pattern stays cached (it worked for someone before).
      logger.info({ candidate, domain, status: r.status }, 'probe: cache hit failed per-person verify, running full probe');
    }
  }

  // 2. Sequential probe — 1s gap between attempts to respect Reacher rate limits
  let attempts = 0;
  for (let i = 0; i < candidates.length; i++) {
    const { templateId, email: candidate } = candidates[i]!;
    const slotOk = await tryConsumeReacherSlot();
    if (!slotOk) {
      logger.info({ domain, attempts }, 'probe: server-wide Reacher daily cap reached');
      return { email: null, method: 'daily_limit', attempts };
    }
    attempts++;

    const result = await reacherCheck(candidate);

    if (result.status === 'catch_all') {
      const mxProvider = result.raw?.mx?.records?.[0];
      domainCatchAllCache.set(domain, Date.now());
      await persistDomainPattern(domain, templateId, { isCatchAll: true, mxProvider });
      logger.info({ domain, candidate }, 'probe: catch-all domain detected, flagging and returning null');
      return { email: null, method: 'catch_all', attempts };
    }

    if (result.status === 'safe') {
      const mxProvider = result.raw?.mx?.records?.[0];
      await persistDomainPattern(domain, templateId, { mxProvider });
      logger.info({ candidate, attempts, domain, templateId }, 'probe: pattern verified safe (persisted)');
      return { email: candidate, method: 'smtp_verified', attempts, templateId };
    }

    // 1-second gap between attempts to respect SMTP server soft limits
    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { email: null, method: 'exhausted', attempts };
}

export interface TeamMember {
  firstName?: string | null;
  lastName?: string | null;
  [k: string]: unknown;
}

export interface TeamMemberWithEmail<T extends TeamMember> {
  member: T;
  email: string | null;
  method: 'cached_pattern' | 'no_pattern' | 'no_name' | 'catch_all' | 'cached_pattern_failed' | 'daily_limit';
}

/**
 * Build emails for an entire team using the cached pattern for the domain,
 * verifying each candidate against Reacher per-person.
 *
 * Why per-person verify (not zero-cost as before): a pattern that worked for
 * one teammate just proves the pattern; it doesn't prove that this specific
 * new person has a mailbox. Reusing the pattern blindly produces syntactically
 * valid but undeliverable emails (false positives → bounces). Each member now
 * costs one Reacher slot, but every email returned is SMTP-verified.
 *
 * Catch-all domains are skipped wholesale — no Reacher calls are made.
 */
export async function applyCachedPatternToTeam<T extends TeamMember>(
  members: T[],
  domain: string,
): Promise<TeamMemberWithEmail<T>[]> {
  // Catch-all → return null for every member, no Reacher cost
  if (await isDomainCatchAll(domain)) {
    return members.map((member) => ({ member, email: null, method: 'catch_all' as const }));
  }

  const cached = await loadCachedPattern(domain);
  if (!cached) {
    return members.map((member) => ({ member, email: null, method: 'no_pattern' as const }));
  }

  const out: TeamMemberWithEmail<T>[] = [];
  for (const member of members) {
    const first = (member.firstName ?? '').toString();
    const last = (member.lastName ?? '').toString();
    if (!first || !last) {
      out.push({ member, email: null, method: 'no_name' as const });
      continue;
    }
    const candidate = buildFromTemplate(cached.templateId, first, last, domain);
    if (!candidate) {
      out.push({ member, email: null, method: 'no_pattern' as const });
      continue;
    }
    const slotOk = await tryConsumeReacherSlot();
    if (!slotOk) {
      out.push({ member, email: null, method: 'daily_limit' as const });
      continue;
    }
    const r = await reacherCheck(candidate);
    if (r.status === 'safe') {
      out.push({ member, email: candidate, method: 'cached_pattern' as const });
    } else if (r.status === 'catch_all') {
      // Domain became catch-all — flag and bail; remaining members get null
      domainCatchAllCache.set(domain, Date.now());
      await persistDomainPattern(domain, cached.templateId, { isCatchAll: true, mxProvider: r.raw?.mx?.records?.[0] });
      out.push({ member, email: null, method: 'catch_all' as const });
      // Mark every remaining member as catch_all without Reacher cost
      const idx = out.length;
      for (let i = idx; i < members.length; i++) {
        out.push({ member: members[i]!, email: null, method: 'catch_all' as const });
      }
      return out;
    } else {
      out.push({ member, email: null, method: 'cached_pattern_failed' as const });
    }
    // 1-second gap between Reacher checks to respect SMTP soft limits
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
}

/**
 * Legacy entry point kept for compatibility with existing callers.
 * New code should call `probePatternForDomain` for the first member of an
 * unknown domain and `applyCachedPatternToTeam` for the rest.
 */
export async function findEmailByPattern(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<{ email: string | null; method: string; attempts: number }> {
  const r = await probePatternForDomain(firstName, lastName, domain);
  return { email: r.email, method: r.method, attempts: r.attempts };
}

// ── Manual single-email verification ─────────────────────────────────────────

export type ManualVerifyStatus =
  | 'safe'
  | 'risky'
  | 'invalid'
  | 'catch_all'
  | 'unknown'
  | 'error'
  | 'daily_limit';

export interface ManualVerifyResult {
  status: ManualVerifyStatus;
  /** True when the user-entered email should be saved on the contact. */
  shouldSave: boolean;
  /** True when the saved email can be marked emailVerified=true. */
  verified: boolean;
}

/**
 * Verify a single user-typed email against Reacher. Burns one slot from the
 * server-wide daily cap. Used by the dashboard's manual email entry path.
 * Maps Reacher's verdict to a save/verify decision so the caller doesn't need
 * to reimplement the policy.
 */
export async function verifyEmailManual(email: string): Promise<ManualVerifyResult> {
  const slotOk = await tryConsumeReacherSlot();
  if (!slotOk) {
    return { status: 'daily_limit', shouldSave: true, verified: false };
  }
  const result = await reacherCheck(email);
  switch (result.status) {
    case 'safe':
      return { status: 'safe', shouldSave: true, verified: true };
    case 'catch_all':
      return { status: 'catch_all', shouldSave: true, verified: false };
    case 'risky':
      return { status: 'risky', shouldSave: true, verified: false };
    case 'invalid':
      return { status: 'invalid', shouldSave: false, verified: false };
    case 'unknown':
      return { status: 'unknown', shouldSave: true, verified: false };
    default:
      return { status: 'error', shouldSave: true, verified: false };
  }
}
