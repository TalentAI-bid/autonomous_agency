import { queueRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

/**
 * Per-user daily cap on POST /api/contacts/capture. Defends against runaway
 * scripts hitting the manual capture endpoint and against an unwitting
 * extension user creating thousands of contacts via the LinkedIn button.
 *
 * Implementation: Redis INCR + EXPIRE keyed by (userId, UTC date). First
 * call sets a 25-hour TTL (slightly longer than the day so the counter
 * doesn't reset early near midnight). Subsequent calls only INCR — the
 * existing TTL stays.
 *
 * Configure via env CAPTURE_DAILY_LIMIT_PER_USER (default 100). Reset is
 * automatic at UTC midnight; we deliberately keep this UTC-based for
 * simplicity even though the dashboard renders local times — a few hours'
 * skew on the reset boundary is acceptable for a low-traffic anti-abuse
 * counter.
 */

const DEFAULT_DAILY_LIMIT = 100;
const KEY_TTL_SECONDS = 25 * 60 * 60;

function dailyLimit(): number {
  const v = Number(process.env.CAPTURE_DAILY_LIMIT_PER_USER);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_DAILY_LIMIT;
}

function todayKey(userId: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `contact:capture:${userId}:${yyyy}-${mm}-${dd}`;
}

export interface CaptureRateLimitVerdict {
  allowed: boolean;
  /** How many captures this user has remaining today after this call. */
  remaining: number;
  /** The configured daily cap. */
  limit: number;
}

/**
 * Atomically check-and-increment the per-user daily counter.
 * Returns allowed=false WITHOUT having incremented when the cap is reached.
 */
export async function checkAndIncrementCapture(userId: string): Promise<CaptureRateLimitVerdict> {
  const limit = dailyLimit();
  const key = todayKey(userId);

  try {
    const next = await queueRedis.incr(key);
    if (next === 1) {
      // First hit of the day — set TTL. Don't await race: if EXPIRE fails
      // the key still self-cleans on Redis maxmemory eviction.
      await queueRedis.expire(key, KEY_TTL_SECONDS);
    }
    if (next > limit) {
      // Undo the increment so a flood of denied requests doesn't keep
      // pushing the counter further out (only matters if the cap were
      // ever lowered mid-day, but it's the right invariant).
      await queueRedis.decr(key);
      return { allowed: false, remaining: 0, limit };
    }
    return { allowed: true, remaining: Math.max(0, limit - next), limit };
  } catch (err) {
    // Fail open. The dashboard form is single-user clicks; the extension
    // already has its own per-task rate limiter. If Redis is down we
    // don't want manual captures to break — they'll still hit the
    // contacts unique indexes for race protection.
    logger.warn({ err, userId }, 'capture-rate-limit: redis error, failing open');
    return { allowed: true, remaining: limit, limit };
  }
}

/** Inspect-only — does not increment. Used by the dashboard for UI display. */
export async function getCaptureRateLimitStatus(userId: string): Promise<CaptureRateLimitVerdict> {
  const limit = dailyLimit();
  const key = todayKey(userId);
  try {
    const raw = await queueRedis.get(key);
    const used = raw ? parseInt(raw, 10) : 0;
    return {
      allowed: used < limit,
      remaining: Math.max(0, limit - used),
      limit,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'capture-rate-limit: status read failed');
    return { allowed: true, remaining: limit, limit };
  }
}
