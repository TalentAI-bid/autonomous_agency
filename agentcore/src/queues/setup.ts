import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * Shared Redis connection for BullMQ.
 * BullMQ requires maxRetriesPerRequest: null for blocking commands.
 */
export function createRedisConnection(): Redis {
  const conn = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, 30000);
      return delay;
    },
    reconnectOnError(err: Error) {
      const msg = err.message || '';
      return msg.includes('READONLY') || msg.includes('ECONNRESET');
    },
    keepAlive: 30000,
    enableOfflineQueue: true,
    connectTimeout: 10000,
    lazyConnect: false,
  });

  conn.on('error', (err: Error) => {
    const code = (err as any).code;
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED') return;
    console.error('[Redis] error:', err.message);
  });

  conn.on('reconnecting', () => {
    console.info('[Redis] reconnecting...');
  });

  conn.on('ready', () => {
    console.info('[Redis] connection ready');
  });

  return conn;
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
