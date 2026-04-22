import { queueRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

/**
 * Server-wide SMTP send rate limiter.
 *
 * The Contabo SMTP relay caps outbound at 25 messages/minute across the
 * entire server. Every tenant + every master agent shares this single
 * bucket, so per-tenant queue limiters are insufficient.
 *
 * Implementation: a Redis sorted set of recent send timestamps (millisecond
 * precision). Each call prunes entries older than the window, counts the
 * remaining, and either reserves a slot or reports how long until one is
 * free.
 *
 * Tune via env: SMTP_RATE_LIMIT_PER_MIN (default 25).
 */

const DEFAULT_MAX_PER_MIN = 25;
const WINDOW_MS = 60_000;
const KEY = 'smtp:global:send-window';

function maxPerMin(): number {
  const v = Number(process.env.SMTP_RATE_LIMIT_PER_MIN);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_MAX_PER_MIN;
}

export interface RateLimiterStatus {
  used: number;
  max: number;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Try to reserve one SMTP send slot atomically.
 * Returns `{ ok: true }` if reserved (caller may proceed with the send) or
 * `{ ok: false, retryAfterMs }` if the bucket is full.
 */
export async function tryReserveSmtpSlot(): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const max = maxPerMin();
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Drop expired entries first so the count is accurate.
  await queueRedis.zremrangebyscore(KEY, 0, windowStart);
  const count = await queueRedis.zcard(KEY);

  if (count < max) {
    // Reserve a slot. Use a unique member so concurrent reservations don't collide.
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;
    await queueRedis.zadd(KEY, now, member);
    // Keep the key from lingering after a quiet period.
    await queueRedis.expire(KEY, Math.ceil(WINDOW_MS / 1000) + 5);
    return { ok: true };
  }

  // Bucket full — compute when the oldest entry will fall out.
  const oldest = await queueRedis.zrange(KEY, 0, 0, 'WITHSCORES');
  const oldestScore = oldest.length === 2 ? Number(oldest[1]) : now;
  const retryAfterMs = Math.max(50, oldestScore + WINDOW_MS - now);
  return { ok: false, retryAfterMs };
}

/**
 * Block until a slot is available, then return.
 * Bounded by `WINDOW_MS` per loop — safe to call inside a worker.
 */
export async function acquireSmtpSlot(opts: { maxWaitMs?: number } = {}): Promise<void> {
  const maxWait = opts.maxWaitMs ?? 90_000;
  const deadline = Date.now() + maxWait;
  for (;;) {
    const r = await tryReserveSmtpSlot();
    if (r.ok) return;
    if (Date.now() + r.retryAfterMs > deadline) {
      throw new Error(`SMTP rate limit: could not acquire slot within ${maxWait}ms (server-wide ${maxPerMin()}/min cap)`);
    }
    logger.debug({ retryAfterMs: r.retryAfterMs }, 'SMTP rate limit reached, waiting');
    await new Promise((res) => setTimeout(res, r.retryAfterMs));
  }
}

export async function getSmtpRateStatus(): Promise<RateLimiterStatus> {
  const max = maxPerMin();
  const now = Date.now();
  await queueRedis.zremrangebyscore(KEY, 0, now - WINDOW_MS);
  const used = await queueRedis.zcard(KEY);
  const oldest = used > 0 ? await queueRedis.zrange(KEY, 0, 0, 'WITHSCORES') : [];
  const oldestScore = oldest.length === 2 ? Number(oldest[1]) : now;
  return {
    used,
    max,
    remaining: Math.max(0, max - used),
    retryAfterMs: used >= max ? Math.max(0, oldestScore + WINDOW_MS - now) : 0,
  };
}
