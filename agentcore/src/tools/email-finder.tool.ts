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
const domainPatternCache = new Map<string, { patternIndex: number; verifiedAt: number }>();

// ── Pattern templates (index-aligned) ────────────────────────────────────────
// Templates are addressed by index. The same array is used everywhere a
// pattern is selected, persisted, or rebuilt. NEVER reorder this array
// without a migration of `domain_patterns.pattern` strings.

const PATTERN_TEMPLATES: ReadonlyArray<{ id: string; build: (f: string, l: string, d: string) => string }> = [
  { id: 'first.last',  build: (f, l, d) => `${f}.${l}@${d}` },
  { id: 'flast',       build: (f, l, d) => `${f[0]}${l}@${d}` },
  { id: 'first',       build: (f, _l, d) => `${f}@${d}` },
  { id: 'f.last',      build: (f, l, d) => `${f[0]}.${l}@${d}` },
  { id: 'firstlast',   build: (f, l, d) => `${f}${l}@${d}` },
  { id: 'last.first',  build: (f, l, d) => `${l}.${f}@${d}` },
  { id: 'first_last',  build: (f, l, d) => `${f}_${l}@${d}` },
  { id: 'last',        build: (_f, l, d) => `${l}@${d}` },
];

function normalizeForEmail(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

function generatePatterns(first: string, last: string, domain: string): string[] {
  const f = normalizeForEmail(first);
  const l = normalizeForEmail(last);
  if (!f || !l || !domain) return [];
  return PATTERN_TEMPLATES.map((t) => t.build(f, l, domain));
}

function buildFromTemplate(templateId: string, first: string, last: string, domain: string): string | null {
  const f = normalizeForEmail(first);
  const l = normalizeForEmail(last);
  if (!f || !l || !domain) return null;
  const template = PATTERN_TEMPLATES.find((t) => t.id === templateId);
  if (!template) return null;
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

interface CachedPattern { patternIndex: number; templateId: string }

async function loadCachedPattern(domain: string): Promise<CachedPattern | null> {
  const mem = domainPatternCache.get(domain);
  if (mem && Date.now() - mem.verifiedAt < PATTERN_CACHE_TTL) {
    const tpl = PATTERN_TEMPLATES[mem.patternIndex];
    if (tpl) return { patternIndex: mem.patternIndex, templateId: tpl.id };
  }
  // Fall back to durable cache so workers don't re-burn 8 SMTP checks per
  // known domain after a restart.
  try {
    const rows = await db.select().from(domainPatterns)
      .where(eq(domainPatterns.domain, domain))
      .limit(10);
    // Pick the highest-confidence row whose pattern id matches a known template.
    let best: { row: typeof rows[number]; index: number } | null = null;
    for (const row of rows) {
      const idx = PATTERN_TEMPLATES.findIndex((t) => t.id === row.pattern);
      if (idx === -1) continue;
      if (!best || row.confidence > best.row.confidence) {
        best = { row, index: idx };
      }
    }
    if (best && best.row.confidence >= 50) {
      domainPatternCache.set(domain, { patternIndex: best.index, verifiedAt: Date.now() });
      return { patternIndex: best.index, templateId: best.row.pattern };
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), domain }, 'loadCachedPattern: DB lookup failed');
  }
  return null;
}

async function persistDomainPattern(domain: string, patternIndex: number, opts: { isCatchAll?: boolean; mxProvider?: string } = {}): Promise<void> {
  const template = PATTERN_TEMPLATES[patternIndex];
  if (!template) return;
  domainPatternCache.set(domain, { patternIndex, verifiedAt: Date.now() });
  try {
    const [existing] = await db.select().from(domainPatterns)
      .where(and(eq(domainPatterns.domain, domain), eq(domainPatterns.pattern, template.id)))
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
        pattern: template.id,
        confidence: 75,
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
  method: 'cached_pattern' | 'smtp_verified' | 'catch_all_guess' | 'catch_all_none' | 'exhausted' | 'no_patterns' | 'daily_limit';
  attempts: number;
  patternIndex?: number;
}

/**
 * Sequentially probe up to 8 patterns against Reacher to discover the working
 * email pattern for a domain we don't yet know. Each probe consumes one slot
 * from the server-wide 300/day cap. On success, the winning pattern is
 * persisted to `domain_patterns` so future team members at this domain skip
 * SMTP entirely (see `applyCachedPatternToTeam`).
 *
 * If a pattern is already cached (memory or DB) for this domain, returns it
 * immediately with zero SMTP cost.
 */
export async function probePatternForDomain(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<ProbeResult> {
  const patterns = generatePatterns(firstName, lastName, domain);
  if (patterns.length === 0) {
    logger.warn({ firstName, lastName, domain }, 'probePatternForDomain: no patterns generated');
    return { email: null, method: 'no_patterns', attempts: 0 };
  }

  // 1. Cache hit (memory or DB) — skip Reacher entirely
  const cached = await loadCachedPattern(domain);
  if (cached) {
    const email = patterns[cached.patternIndex];
    if (email) {
      logger.info({ email, domain, templateId: cached.templateId }, 'probe: cache hit, no SMTP');
      return { email, method: 'cached_pattern', attempts: 0, patternIndex: cached.patternIndex };
    }
  }

  // 2. Sequential probe — 1s gap between attempts to respect Reacher rate limits
  let attempts = 0;
  let catchAllDetected = false;
  for (let i = 0; i < patterns.length; i++) {
    const candidate = patterns[i]!;
    const slotOk = await tryConsumeReacherSlot();
    if (!slotOk) {
      logger.info({ domain, attempts }, 'probe: server-wide Reacher daily cap reached');
      return { email: null, method: 'daily_limit', attempts };
    }
    attempts++;

    const result = await reacherCheck(candidate);

    if (result.status === 'catch_all') {
      catchAllDetected = true;
      const mxProvider = result.raw?.mx?.records?.[0];
      await persistDomainPattern(domain, 0, { isCatchAll: true, mxProvider });
      logger.info({ domain, candidate }, 'probe: catch-all domain, returning first pattern (cached)');
      return { email: patterns[0]!, method: 'catch_all_guess', attempts, patternIndex: 0 };
    }

    if (result.status === 'safe') {
      const mxProvider = result.raw?.mx?.records?.[0];
      await persistDomainPattern(domain, i, { mxProvider });
      logger.info({ candidate, attempts, domain, patternIndex: i }, 'probe: pattern verified safe (persisted)');
      return { email: candidate, method: 'smtp_verified', attempts, patternIndex: i };
    }

    // 1-second gap between attempts to respect SMTP server soft limits
    if (i < patterns.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { email: null, method: catchAllDetected ? 'catch_all_none' : 'exhausted', attempts };
}

export interface TeamMember {
  firstName?: string | null;
  lastName?: string | null;
  [k: string]: unknown;
}

export interface TeamMemberWithEmail<T extends TeamMember> {
  member: T;
  email: string | null;
  method: 'cached_pattern' | 'no_pattern' | 'no_name';
}

/**
 * Build emails for an entire team using the cached pattern for the domain.
 * ZERO SMTP cost — assumes `probePatternForDomain` has already confirmed the
 * pattern (or that one was previously persisted to `domain_patterns`).
 *
 * If no cached pattern exists, every member's email returns `null` with
 * method `no_pattern` so the caller can fall back to per-member probing.
 */
export async function applyCachedPatternToTeam<T extends TeamMember>(
  members: T[],
  domain: string,
): Promise<TeamMemberWithEmail<T>[]> {
  const cached = await loadCachedPattern(domain);
  if (!cached) {
    return members.map((member) => ({ member, email: null, method: 'no_pattern' as const }));
  }

  return members.map((member) => {
    const first = (member.firstName ?? '').toString();
    const last = (member.lastName ?? '').toString();
    if (!first || !last) {
      return { member, email: null, method: 'no_name' as const };
    }
    const email = buildFromTemplate(cached.templateId, first, last, domain);
    return { member, email, method: 'cached_pattern' as const };
  });
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
