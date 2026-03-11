import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, sql, count, avg } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { opportunities, companies, contacts } from '../db/schema/index.js';
import { ValidationError } from '../utils/errors.js';

export default async function opportunityRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/opportunities/:masterAgentId/list — Paginated opportunity list
  fastify.get<{
    Params: { masterAgentId: string };
    Querystring: { type?: string; status?: string; urgency?: string; minScore?: string; limit?: string; cursor?: string };
  }>('/:masterAgentId/list', async (request) => {
    const { masterAgentId } = request.params;
    const { type, status, urgency, minScore, cursor } = request.query;
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);

    const rows = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(opportunities.tenantId, request.tenantId),
        eq(opportunities.masterAgentId, masterAgentId),
      ];
      if (type) conditions.push(eq(opportunities.opportunityType, type as any));
      if (status) conditions.push(eq(opportunities.status, status as any));
      if (urgency) conditions.push(eq(opportunities.urgency, urgency as any));
      if (minScore) conditions.push(sql`${opportunities.buyingIntentScore} >= ${parseInt(minScore, 10)}`);

      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(opportunities.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor format');
        }
      }

      return tx.select().from(opportunities)
        .where(and(...conditions))
        .orderBy(desc(opportunities.buyingIntentScore), desc(opportunities.createdAt))
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

  // GET /api/opportunities/:masterAgentId/detail/:id — Single opportunity with joined data
  fastify.get<{
    Params: { masterAgentId: string; id: string };
  }>('/:masterAgentId/detail/:id', async (request) => {
    const { masterAgentId, id: opportunityId } = request.params;

    const [opp] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(opportunities)
        .where(and(
          eq(opportunities.id, opportunityId),
          eq(opportunities.tenantId, request.tenantId),
          eq(opportunities.masterAgentId, masterAgentId),
        ))
        .limit(1);
    });

    if (!opp) return { data: null };

    let company = null;
    let contact = null;

    if (opp.companyId) {
      const [c] = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(companies).where(eq(companies.id, opp.companyId!)).limit(1);
      });
      company = c ?? null;
    }

    if (opp.contactId) {
      const [c] = await withTenant(request.tenantId, async (tx) => {
        return tx.select().from(contacts).where(eq(contacts.id, opp.contactId!)).limit(1);
      });
      contact = c ?? null;
    }

    return { data: { ...opp, company, contact } };
  });

  // PATCH /api/opportunities/:masterAgentId/detail/:id — Update opportunity status
  fastify.patch<{
    Params: { masterAgentId: string; id: string };
    Body: { status: string };
  }>('/:masterAgentId/detail/:id', async (request) => {
    const { masterAgentId, id: opportunityId } = request.params;
    const { status: newStatus } = request.body;

    const validStatuses = ['new', 'researching', 'qualified', 'contacted', 'converted', 'skipped'];
    if (!validStatuses.includes(newStatus)) {
      throw new ValidationError(`Invalid status: ${newStatus}`);
    }

    const [updated] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(opportunities)
        .set({ status: newStatus as any, updatedAt: new Date() })
        .where(and(
          eq(opportunities.id, opportunityId),
          eq(opportunities.tenantId, request.tenantId),
          eq(opportunities.masterAgentId, masterAgentId),
        ))
        .returning();
    });

    return { data: updated ?? null };
  });

  // GET /api/opportunities/:masterAgentId/stats — Aggregate stats
  fastify.get<{
    Params: { masterAgentId: string };
  }>('/:masterAgentId/stats', async (request) => {
    const { masterAgentId } = request.params;

    const baseConditions = [
      eq(opportunities.tenantId, request.tenantId),
      eq(opportunities.masterAgentId, masterAgentId),
    ];

    const [byType, byStatus, byUrgency, totals] = await Promise.all([
      withTenant(request.tenantId, async (tx) => {
        return tx.select({ type: opportunities.opportunityType, total: count() })
          .from(opportunities)
          .where(and(...baseConditions))
          .groupBy(opportunities.opportunityType);
      }),
      withTenant(request.tenantId, async (tx) => {
        return tx.select({ status: opportunities.status, total: count() })
          .from(opportunities)
          .where(and(...baseConditions))
          .groupBy(opportunities.status);
      }),
      withTenant(request.tenantId, async (tx) => {
        return tx.select({ urgency: opportunities.urgency, total: count() })
          .from(opportunities)
          .where(and(...baseConditions))
          .groupBy(opportunities.urgency);
      }),
      withTenant(request.tenantId, async (tx) => {
        return tx.select({
          total: count(),
          avgScore: avg(opportunities.buyingIntentScore),
        })
          .from(opportunities)
          .where(and(...baseConditions));
      }),
    ]);

    return {
      data: {
        byType,
        byStatus,
        byUrgency,
        total: Number(totals[0]?.total ?? 0),
        avgBuyingIntentScore: Math.round(Number(totals[0]?.avgScore ?? 0)),
      },
    };
  });
}
