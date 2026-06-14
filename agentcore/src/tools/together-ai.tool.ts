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

/** Strip model chain-of-thought (<think> DeepSeek, <reasoning> gpt-oss) from output */
function stripReasoning(text: string): string {
  return text
    .replace(/<(think|reasoning)>[\s\S]*?<\/\1>/gi, '') // closed blocks
    .replace(/<(?:think|reasoning)>[\s\S]*/gi, '')       // unclosed → strip to end
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
  const text = stripReasoning(raw);

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
  let emittedLen = 0;
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
            // Emit only reasoning-free text. Hold back an unfinished trailing
            // tag ("<reas..." with no closing ">") so a <reasoning>/<think>
            // tag split across chunks is never streamed to the client.
            const cleaned = stripReasoning(accumulated);
            const lastLt = cleaned.lastIndexOf('<');
            const lastGt = cleaned.lastIndexOf('>');
            const safeEnd = lastLt > lastGt ? lastLt : cleaned.length;
            if (safeEnd > emittedLen) {
              const toEmit = cleaned.slice(emittedLen, safeEnd);
              emittedLen = safeEnd;
              yield toEmit;
            }
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

  // Final flush: emit any held-back tail (e.g. content after the last '<').
  const finalClean = stripReasoning(accumulated);
  if (finalClean.length > emittedLen) {
    yield finalClean.slice(emittedLen);
  }
  return finalClean;
}

// ── Vision (multimodal) ─────────────────────────────────────────────────────
// Vision models (Amazon Nova etc.) are NOT served by the OpenAI-compatible
// /openai/v1 endpoint — only the native Bedrock Converse API accepts image
// content blocks. The bearer token authenticates Converse the same way. Images
// are passed as raw base64 bytes + a format, not URLs/data-URIs.

export type VisionImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';

export interface VisionImage {
  base64: string;
  format: VisionImageFormat;
}

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string }> } };
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

function normalizeImageFormat(fmt: string): VisionImageFormat {
  const f = fmt.toLowerCase().replace('image/', '').replace('jpg', 'jpeg');
  return (['jpeg', 'png', 'gif', 'webp'] as const).includes(f as VisionImageFormat)
    ? (f as VisionImageFormat)
    : 'jpeg';
}

async function callConverseAPI(
  systemPrompt: string,
  userText: string,
  images: VisionImage[],
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): Promise<ConverseResponse> {
  const token = env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) throw new Error('AWS_BEARER_TOKEN_BEDROCK not configured');

  const model = opts?.model ?? env.BEDROCK_VISION_MODEL;
  const url = `https://bedrock-runtime.${env.AWS_BEDROCK_REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;

  const content: Array<Record<string, unknown>> = [{ text: userText }];
  for (const img of images) {
    if (img?.base64) {
      content.push({ image: { format: normalizeImageFormat(img.format), source: { bytes: img.base64 } } });
    }
  }

  const body = JSON.stringify({
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content }],
    inferenceConfig: { maxTokens: opts?.max_tokens ?? 2048, temperature: opts?.temperature ?? 0.2 },
  });

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]!));
          continue;
        }
        throw new Error(`Bedrock converse returned ${response.status}`);
      }
      if (!response.ok) throw new Error(`Bedrock converse returned ${response.status}: ${await response.text()}`);
      return await response.json() as ConverseResponse;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]!));
    }
  }
  throw new Error('Bedrock converse: all retries exhausted');
}

/**
 * One-shot multimodal completion via Bedrock Converse: a system prompt + a user
 * turn carrying text and one or more images (base64 bytes). Returns the text.
 */
export async function completeVision(
  tenantId: string,
  systemPrompt: string,
  userText: string,
  images: VisionImage[],
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): Promise<string> {
  const data = await callConverseAPI(systemPrompt, userText, images, opts);
  const text = stripReasoning(
    (data.output?.message?.content ?? []).map((c) => c.text ?? '').join('').trim(),
  );

  const tokens = data.usage?.totalTokens
    ?? (data.usage?.inputTokens ?? 0) + (data.usage?.outputTokens ?? 0);
  if (tokens > 0) {
    await redis.incrby(`tenant:${tenantId}:usage:bedrock:tokens`, tokens);
  }
  return text;
}

/** Vision completion that parses a JSON object out of the model's reply. */
export async function extractVisionJSON<T>(
  tenantId: string,
  systemPrompt: string,
  userText: string,
  images: VisionImage[],
  opts?: { temperature?: number; max_tokens?: number; model?: string },
): Promise<T> {
  const { extractJSONFromText } = await import('../utils/json-extract.js');
  const text = await completeVision(tenantId, systemPrompt, userText, images, {
    ...opts,
    max_tokens: opts?.max_tokens ?? 2048,
  });
  return extractJSONFromText<T>(text);
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
