import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection, pubRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const redis: Redis = createRedisConnection();

const RATE_LIMIT_MAX = 2000;
const DISCOVERY_RATE_LIMIT_MAX = 2000;
const RATE_LIMIT_WINDOW_SEC = 3600; // 1 hour
const CACHE_TTL_SEC = 43200; // 12 hours
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TTL = 300; // 5 minutes

/** Track whether we've already warned about SearXNG being unreachable */
let searxngDownWarned = false;

/** Circuit breaker: check if SearXNG circuit is open */
async function isCircuitOpen(): Promise<boolean> {
  try {
    return (await redis.get('circuit:searxng:open')) === 'true';
  } catch { return false; }
}

/** Circuit breaker: record a failure and potentially open the circuit */
async function recordCircuitFailure(tenantId: string): Promise<void> {
  try {
    const failKey = 'circuit:searxng:failures';
    const failures = await redis.incr(failKey);
    await redis.expire(failKey, CIRCUIT_BREAKER_TTL);
    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      await redis.setex('circuit:searxng:open', CIRCUIT_BREAKER_TTL, 'true');
      logger.error({ tenantId, failures }, 'Circuit breaker OPEN for SearXNG — skipping all searches for 5 minutes');
      pubRedis.publish(
        `agent-events:${tenantId}`,
        JSON.stringify({ event: 'pipeline:service_down', data: { service: 'searxng' }, timestamp: new Date().toISOString() }),
      ).catch(() => {});
    }
  } catch { /* non-critical */ }
}

/** Circuit breaker: record a success and reset failure counter */
async function recordCircuitSuccess(): Promise<void> {
  try {
    await redis.del('circuit:searxng:failures');
  } catch { /* non-critical */ }
}

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
  // Circuit breaker check
  if (await isCircuitOpen()) {
    logger.warn({ tenantId, query }, 'SearXNG circuit breaker OPEN — returning empty results');
    return [];
  }

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
    pubRedis.publish(`agent-events:${tenantId}`, JSON.stringify({
      event: 'pipeline:rate_limit_hit', data: { bucket: 'search', used: count, limit: RATE_LIMIT_MAX }, timestamp: new Date().toISOString(),
    })).catch(() => {});
    return [];
  }
  // Warning at 80%
  if (count === Math.floor(RATE_LIMIT_MAX * 0.8)) {
    logger.warn({ tenantId, count, limit: RATE_LIMIT_MAX }, 'SearXNG search budget at 80%');
    pubRedis.publish(`agent-events:${tenantId}`, JSON.stringify({
      event: 'pipeline:rate_limit_warning', data: { bucket: 'search', used: count, limit: RATE_LIMIT_MAX }, timestamp: new Date().toISOString(),
    })).catch(() => {});
  }

  // Cache check
  const cacheKey = `tenant:${tenantId}:cache:search:${createHash('md5').update(query).digest('hex')}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached) as SearchResult[];
    logger.debug({ tenantId, query, cachedResultCount: parsed.length }, 'SearXNG cache hit');
    return parsed;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const url = `${env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo,brave,startpage&categories=general`;
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

    if (results.length === 0) {
      logger.warn({ tenantId, query, rawResultCount: data.results?.length ?? 0 }, 'SearXNG returned 0 usable results');
    } else {
      logger.info({ tenantId, query, resultCount: results.length }, 'SearXNG search returned results');
    }

    if (results.length > 0) {
      await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(results));
    }
    await recordCircuitSuccess();
    return results;
  } catch (err) {
    await recordCircuitFailure(tenantId);
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
  // Circuit breaker check
  if (await isCircuitOpen()) {
    logger.warn({ tenantId, query }, 'SearXNG circuit breaker OPEN — returning empty results (discovery)');
    return [];
  }

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
    const parsed = JSON.parse(cached) as SearchResult[];
    logger.debug({ tenantId, query, cachedResultCount: parsed.length }, 'SearXNG cache hit (discovery)');
    return parsed;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const url = `${env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=google,bing,duckduckgo,brave,startpage&categories=general`;
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

    if (results.length === 0) {
      logger.warn({ tenantId, query, rawResultCount: data.results?.length ?? 0 }, 'SearXNG returned 0 usable results (discovery)');
    } else {
      logger.info({ tenantId, query, resultCount: results.length }, 'SearXNG discovery search returned results');
    }

    if (results.length > 0) {
      await redis.setex(cacheKey, CACHE_TTL_SEC, JSON.stringify(results));
    }
    await recordCircuitSuccess();
    return results;
  } catch (err) {
    await recordCircuitFailure(tenantId);
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

/**
 * Reset all SearXNG rate limits and circuit breaker state for a tenant.
 * Call this when starting a new pipeline so it gets a fresh search budget.
 */
export async function resetSearchRateLimits(tenantId: string): Promise<void> {
  try {
    await redis.del(`tenant:${tenantId}:ratelimit:search`);
    await redis.del(`tenant:${tenantId}:ratelimit:discovery`);
    await redis.del('circuit:searxng:open');
    await redis.del('circuit:searxng:failures');
    searxngDownWarned = false;
    logger.info({ tenantId }, 'SearXNG rate limits and circuit breaker reset');
  } catch (err) {
    logger.warn({ err, tenantId }, 'Failed to reset SearXNG rate limits');
  }
}
