import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection, pubRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

const redis: Redis = createRedisConnection();

const CACHE_TTL_SEC = 259200; // 3 days
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 15; // 30s total
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TTL = 300; // 5 minutes

// ─── Per-domain rate limiting ───────────────────────────────────────────────
const DOMAIN_MIN_DELAY: Record<string, number> = {
  'www.linkedin.com': 5000,
  'linkedin.com': 5000,
};
const DEFAULT_DOMAIN_DELAY_MS = 1000;

const CLOUDFLARE_SIGNATURES = [
  'error 1015', 'rate limit', 'cloudflare', 'attention required',
  'cf-error-details', 'enable javascript and cookies',
  'checking your browser', 'just a moment',
];

/** Track whether we've already warned about Crawl4AI being unreachable */
let crawl4aiDownWarned = false;

async function enforceDomainRateLimit(url: string): Promise<void> {
  try {
    const domain = new URL(url).hostname;
    const delayMs = DOMAIN_MIN_DELAY[domain] ?? DEFAULT_DOMAIN_DELAY_MS;
    const key = `ratelimit:crawl4ai:${domain}:last`;
    const last = await redis.get(key);
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10);
      if (elapsed < delayMs) {
        const waitMs = delayMs - elapsed;
        logger.debug({ domain, waitMs }, 'Crawl4AI domain rate limit — waiting');
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
    await redis.setex(key, 60, String(Date.now()));
  } catch { /* non-critical */ }
}

function isCloudflareBlock(markdown: string): boolean {
  const lower = markdown.toLowerCase();
  let matches = 0;
  for (const sig of CLOUDFLARE_SIGNATURES) {
    if (lower.includes(sig)) matches++;
    if (matches >= 2) return true;
  }
  return false;
}

async function isCrawl4aiCircuitOpen(): Promise<boolean> {
  try {
    return (await redis.get('circuit:crawl4ai:open')) === 'true';
  } catch { return false; }
}

async function recordCrawl4aiFailure(tenantId: string): Promise<void> {
  try {
    const failKey = 'circuit:crawl4ai:failures';
    const failures = await redis.incr(failKey);
    await redis.expire(failKey, CIRCUIT_BREAKER_TTL);
    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      await redis.setex('circuit:crawl4ai:open', CIRCUIT_BREAKER_TTL, 'true');
      logger.error({ tenantId, failures }, 'Circuit breaker OPEN for Crawl4AI — skipping all scraping for 5 minutes');
      pubRedis.publish(
        `agent-events:${tenantId}`,
        JSON.stringify({ event: 'pipeline:service_down', data: { service: 'crawl4ai' }, timestamp: new Date().toISOString() }),
      ).catch(() => {});
    }
  } catch { /* non-critical */ }
}

async function recordCrawl4aiSuccess(): Promise<void> {
  try {
    await redis.del('circuit:crawl4ai:failures');
  } catch { /* non-critical */ }
}

/**
 * Check if Crawl4AI is reachable. Used by health checks and startup diagnostics.
 */
export async function checkCrawl4aiHealth(): Promise<{ ok: boolean; url: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${env.CRAWL4AI_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, url: env.CRAWL4AI_URL };
  } catch (err) {
    return { ok: false, url: env.CRAWL4AI_URL, error: err instanceof Error ? err.message : String(err) };
  }
}

interface CrawlResult {
  status?: string;
  task_id?: string;
  results?: Array<{
    markdown?: string | {
      raw_markdown?: string;
      markdown_with_citations?: string;
      references_markdown?: string;
      fit_markdown?: string;
    };
    extracted_content?: string;
    content?: string;
    url?: string;
  }>;
}

export async function scrape(tenantId: string, url: string, _instruction?: string): Promise<string> {
  // Circuit breaker check
  if (await isCrawl4aiCircuitOpen()) return '';

  const cacheKey = `tenant:${tenantId}:cache:page:${createHash('sha256').update(url).digest('hex')}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  // Per-domain rate limiting (prevents Cloudflare 1015)
  await enforceDomainRateLimit(url);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(`${env.CRAWL4AI_URL}/crawl`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls: [url],
        browser_config: {
          headless: true,
          java_script_enabled: true,
          user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        },
        crawler_config: {
          page_timeout: 30000,
          remove_overlay_elements: true,
          word_count_threshold: 50,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.error({ status: response.status, url }, 'Crawl4AI request failed');
      if (response.status >= 500) {
        await recordCrawl4aiFailure(tenantId);
      }
      return '';
    }

    const data = await response.json() as CrawlResult;

    // Check for client-side errors returned in 200 response (e.g. DNS failures)
    const detail = (data as Record<string, unknown>).detail ?? (data as Record<string, unknown>).error;
    if (detail && /ERR_NAME_NOT_RESOLVED|ENOTFOUND|net::ERR_/i.test(String(detail))) {
      logger.debug({ url, detail }, 'Crawl4AI: domain error in response — skipping');
      return '';
    }

    // If synchronous result
    if (data.results?.length) {
      const md = data.results[0]?.markdown;
      const text = typeof md === 'string' ? md : (md?.raw_markdown || md?.fit_markdown || data.results[0]?.extracted_content || '');
      if (text && isCloudflareBlock(text)) {
        logger.warn({ url, tenantId }, 'Cloudflare block detected in CRAWL4AI response');
        try {
          const domain = new URL(url).hostname;
          await redis.setex(`ratelimit:crawl4ai:${domain}:last`, 120, String(Date.now() + 55000));
        } catch { /* non-critical */ }
        await recordCrawl4aiFailure(tenantId);
        return '';
      }
      if (text && text.trim().length >= 100) await redis.setex(cacheKey, CACHE_TTL_SEC, text);
      await recordCrawl4aiSuccess();
      return text;
    }

    // If async task, poll for result
    const taskId = data.task_id;
    if (!taskId) return '';

    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const pollRes = await fetch(`${env.CRAWL4AI_URL}/task/${taskId}`);
        if (!pollRes.ok) continue;
        const pollData = await pollRes.json() as CrawlResult;
        if (pollData.status === 'completed' && pollData.results?.length) {
          const md = pollData.results[0]?.markdown;
          const text = typeof md === 'string' ? md : (md?.raw_markdown || md?.fit_markdown || pollData.results[0]?.extracted_content || '');
          if (text && isCloudflareBlock(text)) {
            logger.warn({ url, tenantId }, 'Cloudflare block detected in CRAWL4AI async response');
            try {
              const domain = new URL(url).hostname;
              await redis.setex(`ratelimit:crawl4ai:${domain}:last`, 120, String(Date.now() + 55000));
            } catch { /* non-critical */ }
            await recordCrawl4aiFailure(tenantId);
            return '';
          }
          if (text && text.trim().length >= 100) await redis.setex(cacheKey, CACHE_TTL_SEC, text);
          await recordCrawl4aiSuccess();
          return text;
        }
      } catch {
        // continue polling
      }
    }

    return '';
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isDnsError = /ERR_NAME_NOT_RESOLVED|ENOTFOUND|domain.*not.*found/i.test(errMsg);
    const isTimeout = /timeout|ETIMEDOUT/i.test(errMsg);

    // Only record as service failure if it's a real Crawl4AI issue
    if (!isDnsError && !isTimeout) {
      await recordCrawl4aiFailure(tenantId);
    }

    if (isDnsError) {
      logger.debug({ url, err: errMsg }, 'Crawl4AI: domain does not resolve — skipping');
    } else if (!crawl4aiDownWarned) {
      crawl4aiDownWarned = true;
      logger.error({ err, crawl4aiUrl: env.CRAWL4AI_URL, tenantId }, 'Crawl4AI is UNREACHABLE — all page scraping will return empty.');
    } else {
      logger.debug({ err, url, tenantId }, 'Crawl4AI scrape error (already warned)');
    }
    return '';
  }
}
