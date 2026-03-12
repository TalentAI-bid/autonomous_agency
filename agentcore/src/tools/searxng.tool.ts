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

const RATE_LIMIT_MAX = 500;
const DISCOVERY_RATE_LIMIT_MAX = 500;
const RATE_LIMIT_WINDOW_SEC = 3600; // 1 hour
const CACHE_TTL_SEC = 86400; // 24 hours

/** Track whether we've already warned about SearXNG being unreachable */
let searxngDownWarned = false;

/**
 * Check if SearXNG is reachable. Used by health checks and startup diagnostics.
 */
export async function checkSearxngHealth(): Promise<{ ok: boolean; url: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${env.SEARXNG_URL}/search?q=test&format=json`, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, url: env.SEARXNG_URL };
  } catch (err) {
    return { ok: false, url: env.SEARXNG_URL, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function search(
  tenantId: string,
  query: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  // Rate limit check
  const rateLimitKey = `tenant:${tenantId}:ratelimit:search`;
  const currentCount = await redis.get(rateLimitKey);
  if (currentCount && parseInt(currentCount, 10) > RATE_LIMIT_MAX) {
    logger.warn({ tenantId, count: parseInt(currentCount, 10) }, 'SearXNG rate limit exceeded');
    return [];
  }
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
    const timeout = setTimeout(() => controller.abort(), 15000);

    const url = `${env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo&categories=general`;
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
    if (!searxngDownWarned) {
      searxngDownWarned = true;
      logger.error(
        { err, searxngUrl: env.SEARXNG_URL, tenantId },
        'SearXNG is UNREACHABLE — all web search will return empty results. Ensure SearXNG is running at %s (pm2 start ecosystem.config.cjs or docker run searxng/searxng:latest -p 8888:8080)',
        env.SEARXNG_URL,
      );
    } else {
      logger.debug({ err, query, tenantId }, 'SearXNG search error (already warned)');
    }
    return [];
  }
}

/**
 * Discovery-specific search with a separate, higher rate limit bucket (200/hr).
 * Shares the same cache keys as search() so duplicate queries benefit both.
 */
export async function searchDiscovery(
  tenantId: string,
  query: string,
  maxResults = 10,
): Promise<SearchResult[]> {
  // Rate limit check — separate bucket for discovery
  const rateLimitKey = `tenant:${tenantId}:ratelimit:discovery`;
  const currentCount = await redis.get(rateLimitKey);
  if (currentCount && parseInt(currentCount, 10) > DISCOVERY_RATE_LIMIT_MAX) {
    logger.warn({ tenantId, count: parseInt(currentCount, 10) }, 'SearXNG discovery rate limit exceeded');
    return [];
  }
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SEC);
  }
  if (count > DISCOVERY_RATE_LIMIT_MAX) {
    logger.warn({ tenantId, count }, 'SearXNG discovery rate limit exceeded');
    return [];
  }

  // Shared cache — same key as search() so both benefit
  const cacheKey = `tenant:${tenantId}:cache:search:${createHash('md5').update(query).digest('hex')}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached) as SearchResult[];
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const url = `${env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo&categories=general`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.error({ status: response.status, query }, 'SearXNG discovery search failed');
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
    if (!searxngDownWarned) {
      searxngDownWarned = true;
      logger.error(
        { err, searxngUrl: env.SEARXNG_URL, tenantId },
        'SearXNG is UNREACHABLE — all web search will return empty results. Ensure SearXNG is running at %s (pm2 start ecosystem.config.cjs or docker run searxng/searxng:latest -p 8888:8080)',
        env.SEARXNG_URL,
      );
    } else {
      logger.debug({ err, query, tenantId }, 'SearXNG discovery search error (already warned)');
    }
    return [];
  }
}
