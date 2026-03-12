import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { agentTasks } from '../db/schema/index.js';
import { getQueueStatus, getAllQueuesStatus } from '../services/queue.service.js';
import { AGENT_TYPES, type AgentType } from '../queues/queues.js';
import { ValidationError } from '../utils/errors.js';
import { createRedisConnection } from '../queues/setup.js';

export default async function agentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/agents/status — Get all queue statuses
  fastify.get('/status', async (request) => {
    const statuses = await getAllQueuesStatus(request.tenantId);
    return { data: statuses };
  });

  // GET /api/agents/:type/status — Get specific agent queue status
  fastify.get<{ Params: { type: string } }>('/:type/status', async (request) => {
    const { type } = request.params;
    if (!AGENT_TYPES.includes(type as AgentType)) {
      throw new ValidationError(`Invalid agent type: ${type}. Must be one of: ${AGENT_TYPES.join(', ')}`);
    }
    const status = await getQueueStatus(request.tenantId, type as AgentType);
    return { data: status };
  });

  // GET /api/agents/live-status — Get live action status for all agents
  fastify.get<{
    Querystring: { masterAgentId?: string };
  }>('/live-status', async (request) => {
    const { masterAgentId } = request.query;
    if (!masterAgentId) return { data: {} };

    const redis = createRedisConnection();
    try {
      const keys = await redis.keys(`agent-status:${masterAgentId}:*`);
      if (keys.length === 0) return { data: {} };

      const values = await redis.mget(...keys);
      const result: Record<string, unknown> = {};
      keys.forEach((key, i) => {
        const agentType = key.split(':').pop()!;
        try {
          result[agentType] = JSON.parse(values[i]!);
        } catch { /* ignore */ }
      });
      return { data: result };
    } finally {
      await redis.quit();
    }
  });

  // GET /api/agents/:type/tasks — Paginated task history
  fastify.get<{ Params: { type: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/:type/tasks',
    async (request) => {
      const { type } = request.params;
      const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
      const cursor = request.query.cursor;

      if (!AGENT_TYPES.includes(type as AgentType)) {
        throw new ValidationError(`Invalid agent type: ${type}`);
      }

      const tasks = await withTenant(request.tenantId, async (tx) => {
        let query = tx.select().from(agentTasks)
          .where(and(
            eq(agentTasks.tenantId, request.tenantId),
            eq(agentTasks.agentType, type as any),
          ))
          .orderBy(desc(agentTasks.createdAt))
          .limit(limit + 1);

        if (cursor) {
          try {
            const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
            query = tx.select().from(agentTasks)
              .where(and(
                eq(agentTasks.tenantId, request.tenantId),
                eq(agentTasks.agentType, type as any),
                lt(agentTasks.createdAt, new Date(decoded.createdAt)),
              ))
              .orderBy(desc(agentTasks.createdAt))
              .limit(limit + 1);
          } catch {
            throw new ValidationError('Invalid cursor format');
          }
        }

        return query;
      });

      const hasMore = tasks.length > limit;
      const data = hasMore ? tasks.slice(0, limit) : tasks;
      const nextCursor = hasMore && data.length > 0
        ? Buffer.from(JSON.stringify({
            createdAt: data[data.length - 1]!.createdAt.toISOString(),
            id: data[data.length - 1]!.id,
          })).toString('base64')
        : null;

      return { data, pagination: { hasMore, nextCursor } };
    },
  );

  // DELETE /api/agents/cache/flush — Flush cached data by type
  fastify.delete<{
    Querystring: { type?: string };
  }>('/cache/flush', async (request) => {
    const flushType = request.query.type ?? 'all';
    const validTypes = ['discovery', 'search', 'pages', 'domain', 'all'];
    if (!validTypes.includes(flushType)) {
      throw new ValidationError(`Invalid flush type: ${flushType}. Must be one of: ${validTypes.join(', ')}`);
    }

    const redis = createRedisConnection();
    try {
      const patterns: string[] = [];
      if (flushType === 'discovery' || flushType === 'all') {
        patterns.push('discovery:plan:*', 'discovery:company:*');
      }
      if (flushType === 'search' || flushType === 'all') {
        patterns.push(`tenant:${request.tenantId}:cache:search:*`);
      }
      if (flushType === 'pages' || flushType === 'all') {
        patterns.push(`tenant:${request.tenantId}:cache:page:*`);
      }
      if (flushType === 'domain' || flushType === 'all') {
        patterns.push('domain-resolve:*');
      }

      let totalDeleted = 0;
      for (const pattern of patterns) {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(parseInt(cursor, 10), 'MATCH', pattern, 'COUNT', 100);
          cursor = String(nextCursor);
          if (keys.length > 0) {
            await redis.del(...keys);
            totalDeleted += keys.length;
          }
        } while (cursor !== '0');
      }

      return { deleted: totalDeleted, type: flushType };
    } finally {
      await redis.quit();
    }
  });

  // GET /api/agents/:masterAgentId/rate-limits — View current rate limit usage
  fastify.get<{
    Params: { masterAgentId: string };
  }>('/:masterAgentId/rate-limits', async (request) => {
    const redis = createRedisConnection();
    try {
      const buckets = ['search', 'discovery', 'reddit'];
      const limits: Record<string, number> = { search: 500, discovery: 500, reddit: 200 };
      const result: Record<string, { used: number; limit: number; resetsIn: number }> = {};

      for (const bucket of buckets) {
        const key = `tenant:${request.tenantId}:ratelimit:${bucket}`;
        const [usedStr, ttl] = await Promise.all([
          redis.get(key),
          redis.ttl(key),
        ]);
        result[bucket] = {
          used: usedStr ? parseInt(usedStr, 10) : 0,
          limit: limits[bucket]!,
          resetsIn: ttl > 0 ? ttl : 0,
        };
      }

      return { data: result };
    } finally {
      await redis.quit();
    }
  });
}
