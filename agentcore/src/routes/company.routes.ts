import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt, lte, sql, inArray } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, masterAgents } from '../db/schema/index.js';
import { dispatchJob } from '../services/queue.service.js';
import { enqueueExtensionTask, enqueueCompanyEnrichmentFanout } from '../services/extension-dispatcher.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { buildLinkedInCompanySearchURL } from '../services/linkedin-url.service.js';
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
    Querystring: { cursor?: string; limit?: string; search?: string; industry?: string; masterAgentId?: string; includeIncomplete?: string; sortBy?: string };
  }>('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '100', 10), 100);
    const { cursor, search, industry, masterAgentId, includeIncomplete, sortBy } = request.query;
    const sortByFitScore = sortBy === 'fit_score';

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(companies.tenantId, request.tenantId)];
      if (includeIncomplete !== 'true') {
        conditions.push(sql`COALESCE(${companies.dataCompleteness}, 0) >= 10`);
      }
      // No more reject-filter — every company is shown, sorted by score.
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
      // Sort by the new fitScore.buyer_fit_score; the legacy triage.fit_score
      // is COALESCE-d in as a fallback so migrated rows still rank correctly
      // until they're re-scored.
      const orderBy = sortByFitScore
        ? [sql`COALESCE(
              (${companies.rawData} -> 'fitScore' ->> 'buyer_fit_score')::int,
              (${companies.rawData} -> 'triage' ->> 'fit_score')::int
            ) DESC NULLS LAST`, desc(companies.createdAt)]
        : [desc(companies.createdAt)];
      return tx.select().from(companies)
        .where(and(...conditions))
        .orderBy(...orderBy)
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

  // ─── Manual refetch endpoints (parallel-fetch refactor) ─────────────────
  // POST /api/companies/:id/refetch-info  — re-enqueue fetch_company_info
  // POST /api/companies/:id/refetch-team  — re-enqueue fetch_company_team
  // The dashboard surfaces these on the company detail panel so the user
  // can manually retry one half of the parallel fetch without re-running
  // the whole discovery.

  async function loadCompanyForRefetch(tenantId: string, id: string) {
    const [company] = await withTenant(tenantId, async (tx) => {
      return tx.select({
        id: companies.id,
        masterAgentId: companies.masterAgentId,
        linkedinUrl: companies.linkedinUrl,
      })
        .from(companies)
        .where(and(eq(companies.tenantId, tenantId), eq(companies.id, id)))
        .limit(1);
    });
    if (!company) throw new NotFoundError('Company', id);
    if (!company.linkedinUrl) {
      throw new ValidationError('Company has no linkedinUrl — cannot refetch from LinkedIn.');
    }
    return company;
  }

  fastify.post<{ Params: { id: string } }>('/:id/refetch-info', async (request) => {
    const { id } = request.params;
    const company = await loadCompanyForRefetch(request.tenantId, id);
    await enqueueExtensionTask({
      tenantId: request.tenantId,
      masterAgentId: company.masterAgentId ?? undefined,
      site: 'linkedin',
      type: 'fetch_company_info',
      // userInitiated: a button click runs now + jumps the queue, even if the
      // owning agent is paused/quota'd and has a big automated backlog.
      params: { linkedinUrl: company.linkedinUrl, companyId: company.id, userInitiated: true },
      priority: 10,
    });
    return { data: { enqueued: true, companyId: company.id, type: 'fetch_company_info' } };
  });

  // Optional role/keyword filter — fetch only employees whose LinkedIn
  // title/headline matches (e.g. "sales manager"). The whole chain already
  // honors it: the SW appends ?keywords=, the team adapter scrapes that
  // filtered list, and ingest buckets the result into rawData.peopleByKeyword.
  const refetchTeamSchema = z.object({ keyword: z.string().max(100).optional() });

  fastify.post<{ Params: { id: string } }>('/:id/refetch-team', async (request) => {
    const { id } = request.params;
    const parsed = refetchTeamSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const keyword = parsed.data.keyword?.trim() || undefined;

    const company = await loadCompanyForRefetch(request.tenantId, id);
    await enqueueExtensionTask({
      tenantId: request.tenantId,
      masterAgentId: company.masterAgentId ?? undefined,
      site: 'linkedin',
      type: 'fetch_company_team',
      // userInitiated: a button click runs now + jumps the queue, even if the
      // owning agent is paused/quota'd and has a big automated backlog.
      params: {
        linkedinUrl: company.linkedinUrl,
        companyId: company.id,
        userInitiated: true,
        ...(keyword ? { keyword } : {}),
      },
      priority: 10,
    });
    return { data: { enqueued: true, companyId: company.id, type: 'fetch_company_team', keyword: keyword ?? null } };
  });

  // PATCH /api/companies/:id/fit-score — manual fit-score override (no LLM).
  // Sets companies.score AND rawData.fitScore.buyer_fit_score (what the
  // dashboard sorts on) and records the reason in scoreDetails.
  fastify.patch<{ Params: { id: string } }>('/:id/fit-score', async (request) => {
    const { id } = request.params;
    const parsed = z
      .object({ score: z.number().int().min(0).max(100), reason: z.string().max(500).optional() })
      .safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const { score, reason } = parsed.data;

    const [updated] = await withTenant(request.tenantId, async (tx) => {
      const [cur] = await tx
        .select({ rawData: companies.rawData, scoreDetails: companies.scoreDetails })
        .from(companies)
        .where(and(eq(companies.tenantId, request.tenantId), eq(companies.id, id)))
        .limit(1);
      if (!cur) throw new NotFoundError('Company', id);

      const rawData = { ...((cur.rawData as Record<string, unknown>) ?? {}) };
      rawData.fitScore = {
        ...((rawData.fitScore as Record<string, unknown>) ?? {}),
        buyer_fit_score: score,
        manualOverride: true,
      };
      const scoreDetails = {
        ...((cur.scoreDetails as Record<string, unknown>) ?? {}),
        manualOverride: true,
        manualReason: reason ?? null,
        manualAt: new Date().toISOString(),
      };

      return tx
        .update(companies)
        .set({ score, scoreDetails, rawData, updatedAt: new Date() })
        .where(and(eq(companies.tenantId, request.tenantId), eq(companies.id, id)))
        .returning({ id: companies.id, score: companies.score });
    });
    return { data: updated };
  });

  // POST /api/companies/batch/enrich — kick off LinkedIn enrichment (company
  // info + team, optional website crawl) for a LIST of companies. Skips any
  // without a linkedinUrl. Groups by owning agent so team-role keywords resolve.
  fastify.post('/batch/enrich', async (request) => {
    const parsed = z
      .object({ companyIds: z.array(z.string().uuid()).min(1).max(200), crawlWebsite: z.boolean().optional() })
      .safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const { companyIds, crawlWebsite } = parsed.data;

    const rows = await withTenant(request.tenantId, async (tx) => {
      return tx
        .select({ id: companies.id, masterAgentId: companies.masterAgentId, linkedinUrl: companies.linkedinUrl })
        .from(companies)
        .where(and(eq(companies.tenantId, request.tenantId), inArray(companies.id, companyIds)));
    });

    const withLi = rows.filter((r) => r.linkedinUrl);
    const skippedNoLinkedin = rows.filter((r) => !r.linkedinUrl).map((r) => r.id);
    const notFound = companyIds.filter((cid) => !rows.some((r) => r.id === cid));

    const groups = new Map<string | undefined, Array<{ linkedinUrl: string; companyId: string }>>();
    for (const r of withLi) {
      const key = r.masterAgentId ?? undefined;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ linkedinUrl: r.linkedinUrl!, companyId: r.id });
    }
    for (const [masterAgentId, comps] of groups) {
      await enqueueCompanyEnrichmentFanout(request.tenantId, masterAgentId, comps, {
        crawlWebsite: crawlWebsite ?? false,
      });
    }

    return { data: { enqueued: withLi.length, skippedNoLinkedin, notFound } };
  });

  // POST /api/companies/ingest — add one or many companies by NAME and/or
  // LinkedIn URL under a chosen agent, then auto-enrich (company info + team).
  //   • URL given   → create the row + enqueue the enrichment fanout directly.
  //   • name only   → create the row + enqueue a name-scoped LinkedIn company
  //                   search (strictMatch); its ingest attaches the best match
  //                   and then auto-fans-out info + team — no second call needed.
  // This is the MCP `add_companies` path: the one way to hand the system a raw
  // company (vs. the existing /batch/enrich which needs an existing row+URL).
  const ingestSchema = z.object({
    masterAgentId: z.string().uuid(),
    companies: z
      .array(z.object({ name: z.string().max(255).optional(), linkedinUrl: z.string().url().max(500).optional() }))
      .min(1)
      .max(50),
    crawlWebsite: z.boolean().optional(),
  });

  /** Derive a placeholder name from a LinkedIn company slug, e.g. .../company/acme-inc/ → "acme-inc". */
  function nameFromLinkedInSlug(url: string): string | null {
    const m = url.match(/\/company\/([^/?#]+)/i);
    if (!m?.[1]) return null;
    const slug = decodeURIComponent(m[1]).replace(/-/g, ' ').trim();
    return slug.length >= 2 ? slug : null;
  }

  fastify.post('/ingest', async (request) => {
    const parsed = ingestSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const { masterAgentId, companies: entries, crawlWebsite } = parsed.data;

    // The agent must belong to this tenant — companies are always agent-owned.
    const [agent] = await withTenant(request.tenantId, async (tx) =>
      tx.select({ id: masterAgents.id }).from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, request.tenantId)))
        .limit(1),
    );
    if (!agent) throw new NotFoundError('MasterAgent', masterAgentId);

    const items: Array<{ companyId: string; name: string; mode: 'enrich' | 'resolve' }> = [];
    const skipped: Array<{ input: { name?: string; linkedinUrl?: string }; reason: string }> = [];
    const toEnrich: Array<{ linkedinUrl: string; companyId: string }> = [];

    for (const entry of entries) {
      const linkedinUrl = entry.linkedinUrl?.trim() || undefined;
      const name = (entry.name?.trim() || (linkedinUrl ? nameFromLinkedInSlug(linkedinUrl) : null)) ?? undefined;
      if (!name) {
        skipped.push({ input: entry, reason: 'Each company needs a name or a LinkedIn company URL' });
        continue;
      }

      let companyId: string;
      try {
        const company = await saveOrUpdateCompanyStatic(
          request.tenantId,
          { name, ...(linkedinUrl ? { linkedinUrl } : {}), rawData: { source: 'mcp_ingest', listEntry: true } },
          masterAgentId,
        );
        companyId = company.id;
      } catch (err) {
        skipped.push({ input: entry, reason: err instanceof Error ? err.message : 'Failed to create company' });
        continue;
      }

      if (linkedinUrl) {
        toEnrich.push({ linkedinUrl, companyId });
        items.push({ companyId, name, mode: 'enrich' });
      } else {
        // Name only: resolve the LinkedIn URL first. The strictMatch ingest
        // attaches the best name-match and auto-fans-out info + team.
        await enqueueExtensionTask({
          tenantId: request.tenantId,
          masterAgentId,
          site: 'linkedin',
          type: 'search_companies',
          params: {
            searchUrl: buildLinkedInCompanySearchURL({ searchKeywords: [name] }),
            limit: 5,
            strictMatch: { companyId, name },
            userInitiated: true,
          },
          priority: 10,
        });
        items.push({ companyId, name, mode: 'resolve' });
      }
    }

    if (toEnrich.length > 0) {
      await enqueueCompanyEnrichmentFanout(request.tenantId, masterAgentId, toEnrich, {
        crawlWebsite: crawlWebsite ?? false,
      });
    }

    return {
      data: {
        items,
        enrichDispatched: toEnrich.length,
        resolveDispatched: items.filter((i) => i.mode === 'resolve').length,
        skipped,
      },
    };
  });
}
