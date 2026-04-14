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

/** Track whether we've already warned about Crawl4AI being unreachable */
let crawl4aiDownWarned = false;

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

    // If synchronous result
    if (data.results?.length) {
      const md = data.results[0]?.markdown;
      const text = typeof md === 'string' ? md : (md?.raw_markdown || md?.fit_markdown || data.results[0]?.extracted_content || '');
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
    await recordCrawl4aiFailure(tenantId);
    if (!crawl4aiDownWarned) {
      crawl4aiDownWarned = true;
      logger.error(
        { err, crawl4aiUrl: env.CRAWL4AI_URL, tenantId },
        'Crawl4AI is UNREACHABLE — all page scraping will return empty. Ensure Crawl4AI is running at %s (pm2 start ecosystem.config.cjs or docker run unclecode/crawl4ai:latest -p 11235:11235)',
        env.CRAWL4AI_URL,
      );
    } else {
      logger.debug({ err, url, tenantId }, 'Crawl4AI scrape error (already warned)');
    }
    return '';
  }
}
