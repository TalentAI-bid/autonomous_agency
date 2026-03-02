import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';
import { complete as togetherComplete } from './together-ai.tool.js';

const redis: Redis = createRedisConnection();

let client: Anthropic | null = null;

const FALLBACK_MODEL = 'Qwen/Qwen3.5-397B-A17B';

function getClient(): Anthropic {
  if (!client) {
    const apiKey = env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error('CLAUDE_API_KEY not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

async function callClaude(
  tenantId: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: { max_tokens?: number },
): Promise<string> {
  const anthropic = getClient();

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: opts?.max_tokens ?? 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  // Track token usage
  const tokens = (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
  if (tokens > 0) {
    await redis.incrby(`tenant:${tenantId}:usage:claude:tokens`, tokens);
  }

  return text;
}

async function callTogetherFallback(
  tenantId: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: { max_tokens?: number },
): Promise<string> {
  logger.info({ tenantId }, 'CLAUDE_API_KEY not set, falling back to Together AI (%s)', FALLBACK_MODEL);

  const text = await togetherComplete(
    tenantId,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    { max_tokens: opts?.max_tokens ?? 2048, model: FALLBACK_MODEL },
  );

  // Track under claude bucket so billing stays accurate
  // (together-ai.tool already tracks under together bucket — this is intentional double-count
  //  so the tenant sees usage attributed to the "claude" capability they consumed)
  const estimatedTokens = Math.ceil((systemPrompt.length + userPrompt.length + text.length) / 4);
  if (estimatedTokens > 0) {
    await redis.incrby(`tenant:${tenantId}:usage:claude:tokens`, estimatedTokens);
  }

  return text;
}

export async function complete(
  tenantId: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: { max_tokens?: number },
): Promise<string> {
  if (env.CLAUDE_API_KEY) {
    try {
      return await callClaude(tenantId, systemPrompt, userPrompt, opts);
    } catch (err) {
      logger.error({ err, tenantId }, 'Claude API error');
      throw err;
    }
  }

  return callTogetherFallback(tenantId, systemPrompt, userPrompt, opts);
}
