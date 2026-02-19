import Anthropic from '@anthropic-ai/sdk';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

const redis: Redis = createRedisConnection();

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = env.CLAUDE_API_KEY;
    if (!apiKey) throw new Error('CLAUDE_API_KEY not configured');
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function complete(
  tenantId: string,
  systemPrompt: string,
  userPrompt: string,
  opts?: { max_tokens?: number },
): Promise<string> {
  const anthropic = getClient();

  try {
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
  } catch (err) {
    logger.error({ err, tenantId }, 'Claude API error');
    throw err;
  }
}
