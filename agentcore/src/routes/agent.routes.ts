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
}
