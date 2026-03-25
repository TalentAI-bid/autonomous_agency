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

// Prevent unhandled error events from crashing the process
// The retryStrategy in createRedisConnection() handles reconnection automatically
for (const [name, conn] of [['queue', queueRedis], ['pub', pubRedis], ['sub', subRedis]] as const) {
  (conn as Redis).on('error', (err: Error) => {
    const code = (err as any).code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED') return; // suppressed — retryStrategy handles reconnect
    console.error(`[Redis:${name}] error:`, err.message);
  });
}

export async function closeRedisConnections(): Promise<void> {
  await Promise.all([
    queueRedis.quit(),
    pubRedis.quit(),
    subRedis.quit(),
  ]);
}
