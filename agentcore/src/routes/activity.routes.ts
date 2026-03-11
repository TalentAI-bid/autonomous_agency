import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, sql, count } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { agentActivityLog } from '../db/schema/index.js';
import { AGENT_TYPES, type AgentType } from '../queues/queues.js';
import { ValidationError } from '../utils/errors.js';

export default async function activityRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/activity/feed — Paginated activity log (cursor-based)
  fastify.get<{
    Querystring: { masterAgentId?: string; agentType?: string; status?: string; limit?: string; cursor?: string };
  }>('/feed', async (request) => {
    const { masterAgentId, agentType, status, cursor } = request.query;
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);

    const rows = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(agentActivityLog.tenantId, request.tenantId)];
      if (masterAgentId) conditions.push(eq(agentActivityLog.masterAgentId, masterAgentId));
      if (agentType && AGENT_TYPES.includes(agentType as AgentType)) {
        conditions.push(eq(agentActivityLog.agentType, agentType as any));
      }
      if (status) conditions.push(eq(agentActivityLog.status, status));

      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(agentActivityLog.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor format');
        }
      }

      return tx.select().from(agentActivityLog)
        .where(and(...conditions))
        .orderBy(desc(agentActivityLog.createdAt))
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

  // GET /api/activity/stats — Aggregate stats for time window
  fastify.get<{
    Querystring: { masterAgentId?: string; hours?: string };
  }>('/stats', async (request) => {
    const { masterAgentId } = request.query;
    const hours = Math.min(parseInt(request.query.hours || '24', 10), 168);
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const stats = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(agentActivityLog.tenantId, request.tenantId),
        sql`${agentActivityLog.createdAt} >= ${since}`,
      ];
      if (masterAgentId) conditions.push(eq(agentActivityLog.masterAgentId, masterAgentId));

      const rows = await tx
        .select({
          agentType: agentActivityLog.agentType,
          total: count(),
          failed: sql<number>`COUNT(*) FILTER (WHERE ${agentActivityLog.status} = 'failed')`,
          avgDuration: sql<number>`ROUND(AVG(${agentActivityLog.durationMs}))`,
        })
        .from(agentActivityLog)
        .where(and(...conditions))
        .groupBy(agentActivityLog.agentType);

      return rows;
    });

    const recentErrors = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(agentActivityLog.tenantId, request.tenantId),
        eq(agentActivityLog.status, 'failed'),
      ];
      if (masterAgentId) conditions.push(eq(agentActivityLog.masterAgentId, masterAgentId));

      return tx.select().from(agentActivityLog)
        .where(and(...conditions))
        .orderBy(desc(agentActivityLog.createdAt))
        .limit(10);
    });

    return {
      data: {
        byAgentType: stats,
        totalActions: stats.reduce((sum, s) => sum + Number(s.total), 0),
        recentErrors,
      },
    };
  });

  // GET /api/activity/dashboard — Dashboard summary
  fastify.get<{
    Querystring: { masterAgentId?: string };
  }>('/dashboard', async (request) => {
    const { masterAgentId } = request.query;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const summary = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(agentActivityLog.tenantId, request.tenantId),
        sql`${agentActivityLog.createdAt} >= ${today}`,
      ];
      if (masterAgentId) conditions.push(eq(agentActivityLog.masterAgentId, masterAgentId));

      const todayStats = await tx
        .select({
          agentType: agentActivityLog.agentType,
          total: count(),
        })
        .from(agentActivityLog)
        .where(and(...conditions))
        .groupBy(agentActivityLog.agentType);

      return todayStats;
    });

    return { data: { todayByAgent: summary } };
  });
}
