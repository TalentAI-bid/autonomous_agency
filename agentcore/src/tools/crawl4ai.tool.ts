import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

const redis: Redis = createRedisConnection();

const CACHE_TTL_SEC = 604800; // 7 days
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 15; // 30s total

interface CrawlResult {
  status?: string;
  task_id?: string;
  results?: Array<{ markdown?: string; content?: string; url?: string }>;
}

export async function scrape(tenantId: string, url: string, _instruction?: string): Promise<string> {
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
        word_count_threshold: 10,
        extraction_strategy: 'NoExtractionStrategy',
        chunking_strategy: 'RegexChunking',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.error({ status: response.status, url }, 'Crawl4AI request failed');
      return '';
    }

    const data = await response.json() as CrawlResult;

    // If synchronous result
    if (data.results?.length) {
      const text = data.results[0]?.markdown ?? data.results[0]?.content ?? '';
      if (text) await redis.setex(cacheKey, CACHE_TTL_SEC, text);
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
          const text = pollData.results[0]?.markdown ?? pollData.results[0]?.content ?? '';
          if (text) await redis.setex(cacheKey, CACHE_TTL_SEC, text);
          return text;
        }
      } catch {
        // continue polling
      }
    }

    return '';
  } catch (err) {
    logger.error({ err, url, tenantId }, 'Crawl4AI scrape error');
    return '';
  }
}
