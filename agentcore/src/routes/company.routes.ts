import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt, lte, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies } from '../db/schema/index.js';
import { dispatchJob } from '../services/queue.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const createCompanySchema = z.object({
  name: z.string().min(1).max(255),
  domain: z.string().max(255).optional(),
  industry: z.string().max(255).optional(),
  size: z.string().max(100).optional(),
  techStack: z.array(z.string()).optional(),
  funding: z.string().max(255).optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  description: z.string().optional(),
  // Required: companies are always owned by an agent. UI is now scoped under
  // /agents/[agentId]/companies/* — orphans would be unreachable from the dashboard.
  masterAgentId: z.string().uuid(),
});

const updateCompanySchema = createCompanySchema.partial();

export default async function companyRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/companies
  fastify.get<{
    Querystring: { cursor?: string; limit?: string; search?: string; industry?: string; masterAgentId?: string; includeIncomplete?: string };
  }>('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '100', 10), 100);
    const { cursor, search, industry, masterAgentId, includeIncomplete } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(companies.tenantId, request.tenantId)];
      if (includeIncomplete !== 'true') {
        conditions.push(sql`COALESCE(${companies.dataCompleteness}, 0) >= 10`);
      }
      if (industry) conditions.push(eq(companies.industry, industry));
      if (masterAgentId) conditions.push(eq(companies.masterAgentId, masterAgentId));
      if (search) {
        conditions.push(sql`(
          ${companies.name} ILIKE ${'%' + search + '%'} OR
          ${companies.domain} ILIKE ${'%' + search + '%'}
        )`);
      }
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(companies.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor');
        }
      }
      return tx.select().from(companies)
        .where(and(...conditions))
        .orderBy(desc(companies.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = (hasMore ? results.slice(0, limit) : results).map(company => ({
      ...company,
      enrichmentStatus: (company.dataCompleteness ?? 0) >= 70 ? 'complete' as const :
                        (company.dataCompleteness ?? 0) >= 10 ? 'partial' as const : 'minimal' as const,
    }));
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({
          createdAt: data[data.length - 1]!.createdAt.toISOString(),
          id: data[data.length - 1]!.id,
        })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // GET /api/companies/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [company] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(companies)
        .where(and(eq(companies.id, id), eq(companies.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!company) throw new NotFoundError('Company', id);
    return { data: company };
  });

  // POST /api/companies
  fastify.post('/', async (request, reply) => {
    const parsed = createCompanySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [company] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(companies).values({
        tenantId: request.tenantId,
        ...parsed.data,
      }).returning();
    });

    return reply.status(201).send({ data: company });
  });

  // PATCH /api/companies/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateCompanySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [company] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(companies)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(companies.id, id), eq(companies.tenantId, request.tenantId)))
        .returning();
    });
    if (!company) throw new NotFoundError('Company', id);
    return { data: company };
  });

  // DELETE /api/companies/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(companies)
        .where(and(eq(companies.id, id), eq(companies.tenantId, request.tenantId)))
        .returning({ id: companies.id });
    });
    if (result.length === 0) throw new NotFoundError('Company', id);
    return { success: true };
  });

  // POST /api/companies/admin/retry-stuck-enrichment
  fastify.post('/admin/retry-stuck-enrichment', async (request) => {
    const stuckCompanies = await withTenant(request.tenantId, async (tx) => {
      return tx.select({
        id: companies.id,
        name: companies.name,
        masterAgentId: companies.masterAgentId,
      })
      .from(companies)
      .where(and(
        eq(companies.tenantId, request.tenantId),
        lte(companies.dataCompleteness, 15),
      ));
    });

    let dispatched = 0;
    for (const company of stuckCompanies) {
      if (!company.masterAgentId) continue;
      try {
        await dispatchJob(request.tenantId, 'enrichment', {
          companyId: company.id,
          masterAgentId: company.masterAgentId,
        });
        dispatched++;
      } catch {
        // skip individual failures, continue with rest
      }
    }

    return { total: stuckCompanies.length, dispatched };
  });
}
