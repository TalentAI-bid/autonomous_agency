import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, masterAgents } from '../db/schema/index.js';
import { triageCompany, batchTriageCompanies } from '../services/company-triage.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const triageOneBodySchema = z.object({ force: z.boolean().optional() });
const batchBodySchema = z.object({
  force: z.boolean().optional(),
  companyIds: z.array(z.string().uuid()).optional(),
});

export default async function triageRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/triage/companies/:id  — re-triage a single company
  fastify.post<{ Params: { id: string } }>('/companies/:id', async (request) => {
    const { id } = request.params;
    const parsed = triageOneBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const force = parsed.data.force ?? false;

    const target = await withTenant(request.tenantId, async (tx) => {
      const [row] = await tx
        .select({ id: companies.id, masterAgentId: companies.masterAgentId })
        .from(companies)
        .where(and(eq(companies.tenantId, request.tenantId), eq(companies.id, id)))
        .limit(1);
      return row ?? null;
    });

    if (!target) throw new NotFoundError('Company', id);
    if (!target.masterAgentId) {
      throw new ValidationError('Company has no master agent — cannot derive seller profile');
    }

    const verdict = await triageCompany({
      tenantId: request.tenantId,
      companyId: id,
      masterAgentId: target.masterAgentId,
      force,
    });

    return { data: { verdict } };
  });

  // POST /api/triage/agents/:masterAgentId/batch  — triage all (or selected) companies for an agent
  // (Fastify default request timeout is 0/none; this endpoint can run long.)
  fastify.post<{ Params: { masterAgentId: string } }>(
    '/agents/:masterAgentId/batch',
    async (request) => {
      const { masterAgentId } = request.params;
      const parsed = batchBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const { force, companyIds } = parsed.data;

      const [agent] = await withTenant(request.tenantId, async (tx) => {
        return tx.select({ id: masterAgents.id })
          .from(masterAgents)
          .where(and(eq(masterAgents.tenantId, request.tenantId), eq(masterAgents.id, masterAgentId)))
          .limit(1);
      });
      if (!agent) throw new NotFoundError('Master agent', masterAgentId);

      const counts = await batchTriageCompanies({
        tenantId: request.tenantId,
        masterAgentId,
        companyIds,
        force,
      });

      return { data: counts };
    },
  );

  // GET /api/triage/agents/:masterAgentId/stats  — verdict counts + rejection-reason breakdown
  fastify.get<{ Params: { masterAgentId: string } }>('/agents/:masterAgentId/stats', async (request) => {
    const { masterAgentId } = request.params;

    const [agent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ id: masterAgents.id })
        .from(masterAgents)
        .where(and(eq(masterAgents.tenantId, request.tenantId), eq(masterAgents.id, masterAgentId)))
        .limit(1);
    });
    if (!agent) throw new NotFoundError('Master agent', masterAgentId);

    const stats = await withTenant(request.tenantId, async (tx) => {
      const totalsResult = await tx.execute<{
        total: string;
        triaged: string;
        accepted: string;
        rejected: string;
        reviewed: string;
      }>(sql`
        SELECT
          COUNT(*)::text AS total,
          COUNT(${companies.rawData} -> 'triage')::text AS triaged,
          COUNT(*) FILTER (WHERE ${companies.rawData} -> 'triage' ->> 'verdict' = 'accept')::text AS accepted,
          COUNT(*) FILTER (WHERE ${companies.rawData} -> 'triage' ->> 'verdict' = 'reject')::text AS rejected,
          COUNT(*) FILTER (WHERE ${companies.rawData} -> 'triage' ->> 'verdict' = 'review')::text AS reviewed
        FROM ${companies}
        WHERE ${companies.tenantId} = ${request.tenantId}
          AND ${companies.masterAgentId} = ${masterAgentId}
      `);

      const reasonsResult = await tx.execute<{ rejection_reason: string | null; n: string }>(sql`
        SELECT
          ${companies.rawData} -> 'triage' ->> 'rejection_reason' AS rejection_reason,
          COUNT(*)::text AS n
        FROM ${companies}
        WHERE ${companies.tenantId} = ${request.tenantId}
          AND ${companies.masterAgentId} = ${masterAgentId}
          AND ${companies.rawData} -> 'triage' ->> 'verdict' = 'reject'
        GROUP BY 1
      `);

      return {
        totals: totalsResult.rows?.[0],
        reasons: reasonsResult.rows ?? [],
      };
    });

    const t = stats.totals ?? { total: '0', triaged: '0', accepted: '0', rejected: '0', reviewed: '0' };
    const total = Number(t.total ?? 0);
    const triaged = Number(t.triaged ?? 0);
    const by_rejection_reason: Record<string, number> = {};
    for (const r of stats.reasons) {
      const key = r.rejection_reason ?? 'unspecified';
      by_rejection_reason[key] = Number(r.n ?? 0);
    }

    return {
      data: {
        total,
        triaged,
        untriaged: Math.max(0, total - triaged),
        accepted: Number(t.accepted ?? 0),
        rejected: Number(t.rejected ?? 0),
        reviewed: Number(t.reviewed ?? 0),
        by_rejection_reason,
      },
    };
  });
}
