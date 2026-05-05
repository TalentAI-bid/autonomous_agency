import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, masterAgents } from '../db/schema/index.js';
import { scoreCompany, batchScoreCompanies } from '../services/buyer-fit-score.service.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const scoreOneBodySchema = z.object({ force: z.boolean().optional() });
const batchBodySchema = z.object({
  force: z.boolean().optional(),
  companyIds: z.array(z.string().uuid()).optional(),
});

export default async function fitScoreRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/fit-score/companies/:id — re-score a single company
  fastify.post<{ Params: { id: string } }>('/companies/:id', async (request) => {
    const { id } = request.params;
    const parsed = scoreOneBodySchema.safeParse(request.body ?? {});
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

    const verdict = await scoreCompany({
      tenantId: request.tenantId,
      companyId: id,
      masterAgentId: target.masterAgentId,
      force,
    });

    return { data: { verdict } };
  });

  // POST /api/fit-score/agents/:masterAgentId/batch — score all (or selected) companies for an agent
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

      const counts = await batchScoreCompanies({
        tenantId: request.tenantId,
        masterAgentId,
        companyIds,
        force,
      });

      return { data: counts };
    },
  );

  // GET /api/fit-score/agents/:masterAgentId/stats — score-band distribution + averages
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
        scored: string;
        unscored: string;
        full: string;
        partial: string;
        avg_score: string;
        band_80_100: string;
        band_60_79: string;
        band_40_59: string;
        band_20_39: string;
        band_0_19: string;
      }>(sql`
        SELECT
          COUNT(*)::text AS total,
          COUNT(${companies.rawData} -> 'fitScore')::text AS scored,
          (COUNT(*) - COUNT(${companies.rawData} -> 'fitScore'))::text AS unscored,
          COUNT(*) FILTER (WHERE ${companies.rawData} -> 'fitScore' ->> 'data_completeness' = 'full')::text AS full,
          COUNT(*) FILTER (WHERE ${companies.rawData} -> 'fitScore' ->> 'data_completeness' = 'partial')::text AS partial,
          COALESCE(ROUND(AVG((${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int)), 0)::text AS avg_score,
          COUNT(*) FILTER (WHERE (${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int >= 80)::text AS band_80_100,
          COUNT(*) FILTER (WHERE (${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int BETWEEN 60 AND 79)::text AS band_60_79,
          COUNT(*) FILTER (WHERE (${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int BETWEEN 40 AND 59)::text AS band_40_59,
          COUNT(*) FILTER (WHERE (${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int BETWEEN 20 AND 39)::text AS band_20_39,
          COUNT(*) FILTER (WHERE (${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int BETWEEN 0 AND 19)::text AS band_0_19
        FROM ${companies}
        WHERE ${companies.tenantId} = ${request.tenantId}
          AND ${companies.masterAgentId} = ${masterAgentId}
      `);

      return totalsResult.rows?.[0] ?? null;
    });

    const t = stats ?? {
      total: '0', scored: '0', unscored: '0', full: '0', partial: '0', avg_score: '0',
      band_80_100: '0', band_60_79: '0', band_40_59: '0', band_20_39: '0', band_0_19: '0',
    };

    return {
      data: {
        total: Number(t.total ?? 0),
        scored: Number(t.scored ?? 0),
        unscored: Number(t.unscored ?? 0),
        avgScore: Number(t.avg_score ?? 0),
        fullDataCount: Number(t.full ?? 0),
        partialDataCount: Number(t.partial ?? 0),
        distribution: {
          '80-100': Number(t.band_80_100 ?? 0),
          '60-79': Number(t.band_60_79 ?? 0),
          '40-59': Number(t.band_40_59 ?? 0),
          '20-39': Number(t.band_20_39 ?? 0),
          '0-19': Number(t.band_0_19 ?? 0),
        },
      },
    };
  });
}
