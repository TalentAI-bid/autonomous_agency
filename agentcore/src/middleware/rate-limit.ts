import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { env } from '../config/env.js';

async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    // Dashboard + workers open many parallel queries per page (agents, contacts,
    // companies, analytics, refetch intervals, WS invalidations). 100/min is
    // way too low and starves a legitimate logged-in user in seconds.
    max: 5000,
    timeWindow: '1 minute',
    redis: undefined, // In-memory is fine for a single node; Redis-backed is per-instance only.
    keyGenerator: (request) => {
      // Per-tenant + per-user. Falls back to ip when the request hasn't hit
      // the authenticate hook yet (login, register, health).
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
    ...(env.NODE_ENV === 'test' ? { max: 100000 } : {}),
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit' });
