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

const MODEL = 'deepseek-ai/DeepSeek-R1';
const BACKOFF_MS = [1000, 2000, 4000];

async function callAPI(messages: ChatMessage[], opts?: { temperature?: number; max_tokens?: number; model?: string }): Promise<TogetherResponse> {
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
          model: opts?.model ?? MODEL,
          messages,
          temperature: opts?.temperature ?? 0.7,
          max_tokens: opts?.max_tokens ?? 16384,
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
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): Promise<string> {
  const data = await callAPI(messages, opts);
  const rawText = data.choices?.[0]?.message?.content ?? '';
  // Strip DeepSeek R1 <think> blocks before returning
  const text = rawText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Track token usage
  const tokens = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
  if (tokens > 0) {
    await redis.incrby(`tenant:${tenantId}:usage:together:tokens`, tokens);
  }

  return text;
}

export async function* completeStream(
  tenantId: string,
  messages: ChatMessage[],
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): AsyncGenerator<string, string, unknown> {
  const apiKey = env.TOGETHER_API_KEY;
  if (!apiKey) throw new Error('TOGETHER_API_KEY not configured');

  const response = await fetch(`${env.TOGETHER_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts?.model ?? MODEL,
      messages,
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.max_tokens ?? 16384,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Together AI streaming returned ${response.status}`);
  }

  const body = response.body;
  if (!body) throw new Error('Together AI: no response body for stream');

  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';
  // Track <think> blocks in streaming to suppress them
  let insideThink = false;
  let thinkBuffer = '';

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{ delta?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            // Suppress <think>...</think> blocks from streaming output
            if (insideThink) {
              thinkBuffer += content;
              if (thinkBuffer.includes('</think>')) {
                // End of think block — emit anything after </think>
                const afterThink = thinkBuffer.split('</think>').slice(1).join('</think>');
                insideThink = false;
                thinkBuffer = '';
                if (afterThink) {
                  accumulated += afterThink;
                  yield afterThink;
                }
              }
            } else if (content.includes('<think>')) {
              // Start of think block
              const beforeThink = content.split('<think>')[0] ?? '';
              if (beforeThink) {
                accumulated += beforeThink;
                yield beforeThink;
              }
              insideThink = true;
              thinkBuffer = content.slice(content.indexOf('<think>') + 7);
              // Check if think block ends in the same chunk
              if (thinkBuffer.includes('</think>')) {
                const afterThink = thinkBuffer.split('</think>').slice(1).join('</think>');
                insideThink = false;
                thinkBuffer = '';
                if (afterThink) {
                  accumulated += afterThink;
                  yield afterThink;
                }
              }
            } else {
              accumulated += content;
              yield content;
            }
          }
          // Track usage from the final chunk if available
          if (json.usage) {
            const tokens = (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0);
            if (tokens > 0) {
              await redis.incrby(`tenant:${tenantId}:usage:together:tokens`, tokens);
            }
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Track usage if we didn't get it from the stream
  // (some providers only send usage in the final event)
  return accumulated;
}

export async function extractJSON<T>(
  tenantId: string,
  messages: ChatMessage[],
  maxRetries = 3,
  opts?: { temperature?: number; model?: string },
): Promise<T> {
  const { extractJSONFromText } = await import('../utils/json-extract.js');
  const msgs = [...messages];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const text = await complete(tenantId, msgs, opts);

    try {
      return extractJSONFromText<T>(text);
    } catch (err) {
      logger.warn({ attempt, tenantId, errMsg: err instanceof Error ? err.message : String(err) }, 'Together AI JSON parse failed, retrying');
      if (attempt < maxRetries - 1) {
        msgs.push({ role: 'assistant', content: text });
        msgs.push({ role: 'user', content: 'Output must be valid JSON only. No markdown, no explanation, just the raw JSON object.' });
      }
    }
  }
  throw new Error('Together AI: failed to extract valid JSON after retries');
}
