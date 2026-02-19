import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface TogetherResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const redis: Redis = createRedisConnection();

const MODEL = 'deepseek-ai/DeepSeek-V3';
const BACKOFF_MS = [1000, 2000, 4000];

async function callAPI(messages: ChatMessage[], opts?: { temperature?: number; max_tokens?: number }): Promise<TogetherResponse> {
  const apiKey = env.TOGETHER_API_KEY;
  if (!apiKey) throw new Error('TOGETHER_API_KEY not configured');

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${env.TOGETHER_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: opts?.temperature ?? 0.7,
          max_tokens: opts?.max_tokens ?? 4096,
        }),
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]!));
          continue;
        }
        throw new Error(`Together AI returned ${response.status}`);
      }

      if (!response.ok) throw new Error(`Together AI returned ${response.status}`);

      return await response.json() as TogetherResponse;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]!));
    }
  }
  throw new Error('Together AI: all retries exhausted');
}

export async function complete(
  tenantId: string,
  messages: ChatMessage[],
  opts?: { temperature?: number; max_tokens?: number },
): Promise<string> {
  const data = await callAPI(messages, opts);
  const text = data.choices?.[0]?.message?.content ?? '';

  // Track token usage
  const tokens = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
  if (tokens > 0) {
    await redis.incrby(`tenant:${tenantId}:usage:together:tokens`, tokens);
  }

  return text;
}

export async function extractJSON<T>(
  tenantId: string,
  messages: ChatMessage[],
  maxRetries = 3,
): Promise<T> {
  const msgs = [...messages];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const text = await complete(tenantId, msgs);

    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return JSON.parse(cleaned) as T;
    } catch (err) {
      logger.warn({ attempt, tenantId }, 'Together AI JSON parse failed, retrying');
      if (attempt < maxRetries - 1) {
        msgs.push({ role: 'assistant', content: text });
        msgs.push({ role: 'user', content: 'Output must be valid JSON only. No markdown, no explanation, just the raw JSON object.' });
      }
    }
  }
  throw new Error('Together AI: failed to extract valid JSON after retries');
}
