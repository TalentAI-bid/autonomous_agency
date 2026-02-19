import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';

async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    redis: undefined, // Will use in-memory by default; set Redis client for production
    keyGenerator: (request) => {
      // Per-tenant + per-user rate limiting
      const tenantId = (request as any).tenantId || 'anonymous';
      const userId = (request as any).userId || request.ip;
      return `${tenantId}:${userId}`;
    },
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
        details: {
          limit: context.max,
          remaining: 0,
          retryAfter: Math.ceil(context.ttl / 1000),
        },
      },
    }),
    // Skip rate limiting in test environment
    ...(env.NODE_ENV === 'test' ? { max: 10000 } : {}),
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
