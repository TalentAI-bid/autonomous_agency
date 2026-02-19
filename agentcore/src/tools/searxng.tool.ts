import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const redis: Redis = createRedisConnection();

const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW_SEC = 3600; // 1 hour
const CACHE_TTL_SEC = 86400; // 24 hours

export async function search(
  tenantId: string,
  query: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  // Rate limit check
  const rateLimitKey = `tenant:${tenantId}:ratelimit:search`;
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SEC);
  }
  if (count > RATE_LIMIT_MAX) {
    logger.warn({ tenantId, count }, 'SearXNG rate limit exceeded');
    return [];
  }

  // Cache check
  const cacheKey = `tenant:${tenantId}:cache:search:${createHash('md5').update(query).digest('hex')}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as SearchResult[];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const url = `${env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.error({ status: response.status, query }, 'SearXNG search failed');
      return [];
    }

    const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results: SearchResult[] = (data.results ?? [])
      .slice(0, maxResults)
      .map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
      }));

    await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(results));
    return results;
  } catch (err) {
    logger.error({ err, query, tenantId }, 'SearXNG search error');
    return [];
  }
}
