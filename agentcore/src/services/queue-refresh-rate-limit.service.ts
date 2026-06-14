import { queueRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

const DAILY_LIMIT = 3;
const KEY_TTL_SECONDS = 25 * 60 * 60;

function todayKey(userId: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `queue:refresh:${userId}:${yyyy}-${mm}-${dd}`;
}

function nextUtcMidnightIso(): string {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

export interface QueueRefreshVerdict {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: string;
}

export async function checkAndIncrementQueueRefresh(userId: string): Promise<QueueRefreshVerdict> {
  const key = todayKey(userId);
  const resetAt = nextUtcMidnightIso();
  try {
    const next = await queueRedis.incr(key);
    if (next === 1) {
      await queueRedis.expire(key, KEY_TTL_SECONDS);
    }
    if (next > DAILY_LIMIT) {
      await queueRedis.decr(key);
      return { allowed: false, remaining: 0, limit: DAILY_LIMIT, resetAt };
    }
    return { allowed: true, remaining: Math.max(0, DAILY_LIMIT - next), limit: DAILY_LIMIT, resetAt };
  } catch (err) {
    logger.warn({ err, userId }, 'queue-refresh-rate-limit: redis error, failing open');
    return { allowed: true, remaining: DAILY_LIMIT, limit: DAILY_LIMIT, resetAt };
  }
}

export async function getQueueRefreshStatus(userId: string): Promise<QueueRefreshVerdict> {
  const key = todayKey(userId);
  const resetAt = nextUtcMidnightIso();
  try {
    const raw = await queueRedis.get(key);
    const used = raw ? parseInt(raw, 10) : 0;
    return {
      allowed: used < DAILY_LIMIT,
      remaining: Math.max(0, DAILY_LIMIT - used),
      limit: DAILY_LIMIT,
      resetAt,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'queue-refresh-rate-limit: status read failed');
    return { allowed: true, remaining: DAILY_LIMIT, limit: DAILY_LIMIT, resetAt };
  }
}
