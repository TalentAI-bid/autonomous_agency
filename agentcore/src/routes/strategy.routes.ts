import type { FastifyInstance } from 'fastify';
import { eq, and, desc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { agentDailyStrategy } from '../db/schema/index.js';
import { dispatchJob } from '../services/queue.service.js';
import { ValidationError } from '../utils/errors.js';

export default async function strategyRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/strategy/:masterAgentId/history — Paginated strategy history
  fastify.get<{
    Params: { masterAgentId: string };
    Querystring: { limit?: string; cursor?: string };
  }>('/:masterAgentId/history', async (request) => {
    const { masterAgentId } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
    const cursor = request.query.cursor;

    const rows = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(agentDailyStrategy.tenantId, request.tenantId),
        eq(agentDailyStrategy.masterAgentId, masterAgentId),
      ];

      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          const { lt } = await import('drizzle-orm');
          conditions.push(lt(agentDailyStrategy.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor format');
        }
      }

      return tx.select().from(agentDailyStrategy)
        .where(and(...conditions))
        .orderBy(desc(agentDailyStrategy.strategyDate))
        .limit(limit + 1);
    });

    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({
          createdAt: data[data.length - 1]!.createdAt.toISOString(),
          id: data[data.length - 1]!.id,
        })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // GET /api/strategy/:masterAgentId/latest — Most recent strategy record
  fastify.get<{
    Params: { masterAgentId: string };
  }>('/:masterAgentId/latest', async (request) => {
    const { masterAgentId } = request.params;

    const [latest] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(agentDailyStrategy)
        .where(and(
          eq(agentDailyStrategy.tenantId, request.tenantId),
          eq(agentDailyStrategy.masterAgentId, masterAgentId),
        ))
        .orderBy(desc(agentDailyStrategy.strategyDate))
        .limit(1);
    });

    return { data: latest ?? null };
  });

  // POST /api/strategy/:masterAgentId/trigger — Manually trigger a strategy run
  fastify.post<{
    Params: { masterAgentId: string };
  }>('/:masterAgentId/trigger', async (request) => {
    const { masterAgentId } = request.params;

    const jobId = await dispatchJob(request.tenantId, 'strategy', {
      masterAgentId,
      tenantId: request.tenantId,
      manual: true,
    });

    return { data: { jobId, message: 'Strategy run triggered' } };
  });
}
