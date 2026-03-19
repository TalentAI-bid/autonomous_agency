import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface BedrockResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const redis: Redis = createRedisConnection();

const MODEL = 'openai.gpt-oss-120b-1:0';
export const SMART_MODEL = 'deepseek.v3.2';
const BACKOFF_MS = [1000, 2000, 4000];

/** Strip DeepSeek <think>...</think> reasoning blocks from LLM output */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // closed <think>...</think>
    .replace(/<think>[\s\S]*/gi, '')              // unclosed <think> (strip to end)
    .trim();
}

function getBedrockUrl(): string {
  return `https://bedrock-runtime.${env.AWS_BEDROCK_REGION}.amazonaws.com/openai/v1/chat/completions`;
}

async function callAPI(messages: ChatMessage[], opts?: { temperature?: number; max_tokens?: number; model?: string }): Promise<BedrockResponse> {
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) throw new Error('AWS_BEARER_TOKEN_BEDROCK not configured');

  const url = getBedrockUrl();

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: opts?.model ?? MODEL,
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
        throw new Error(`Bedrock returned ${response.status}`);
      }

      if (!response.ok) throw new Error(`Bedrock returned ${response.status}: ${await response.text()}`);

      return await response.json() as BedrockResponse;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]!));
    }
  }
  throw new Error('Bedrock: all retries exhausted');
}

export async function complete(
  tenantId: string,
  messages: ChatMessage[],
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): Promise<string> {
  const data = await callAPI(messages, opts);
  const raw = (data.choices?.[0]?.message?.content ?? '').trim();
  const text = stripThinkTags(raw);

  // Track token usage
  const tokens = (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
  if (tokens > 0) {
    await redis.incrby(`tenant:${tenantId}:usage:bedrock:tokens`, tokens);
  }

  return text;
}

export async function* completeStream(
  tenantId: string,
  messages: ChatMessage[],
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): AsyncGenerator<string, string, unknown> {
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) throw new Error('AWS_BEARER_TOKEN_BEDROCK not configured');

  const url = getBedrockUrl();

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: opts?.model ?? MODEL,
      messages,
      temperature: opts?.temperature ?? 0.7,
      max_tokens: opts?.max_tokens ?? 4096,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Bedrock streaming returned ${response.status}`);
  }

  const body = response.body;
  if (!body) throw new Error('Bedrock: no response body for stream');

  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
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
            accumulated += content;
            yield content;
          }
          if (json.usage) {
            const tokens = (json.usage.prompt_tokens ?? 0) + (json.usage.completion_tokens ?? 0);
            if (tokens > 0) {
              await redis.incrby(`tenant:${tenantId}:usage:bedrock:tokens`, tokens);
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

  return stripThinkTags(accumulated);
}

export async function extractJSON<T>(
  tenantId: string,
  messages: ChatMessage[],
  maxRetries = 3,
  opts?: { temperature?: number; model?: string; max_tokens?: number },
): Promise<T> {
  const { extractJSONFromText } = await import('../utils/json-extract.js');
  const msgs = [...messages];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const text = await complete(tenantId, msgs, { ...opts, max_tokens: opts?.max_tokens ?? 16384 });

    try {
      return extractJSONFromText<T>(text);
    } catch (err) {
      logger.warn({ attempt, tenantId, errMsg: err instanceof Error ? err.message : String(err) }, 'Bedrock JSON parse failed, retrying');
      if (attempt < maxRetries - 1) {
        msgs.push({ role: 'assistant', content: text });
        msgs.push({ role: 'user', content: 'Output must be valid JSON only. No markdown, no explanation, just the raw JSON object.' });
      }
    }
  }
  throw new Error('Bedrock: failed to extract valid JSON after retries');
}
