import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * Shared Redis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null for blocking commands.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 5000);
      return delay;
    },
  });
}

/** Shared connection instance for queues */
export const queueRedis = createRedisConnection();

/** Separate connection for pub/sub (Redis requires dedicated connections for subscribers) */
export const pubRedis = createRedisConnection();
export const subRedis = createRedisConnection();

export async function closeRedisConnections(): Promise<void> {
  await Promise.all([
    queueRedis.quit(),
    pubRedis.quit(),
    subRedis.quit(),
  ]);
}
