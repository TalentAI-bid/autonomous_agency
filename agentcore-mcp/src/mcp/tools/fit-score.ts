import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import { defineTool, text } from '../tool-helper.js';
import type { SessionCtx } from '../session-store.js';

/** Normalize agentcore list responses (array, {companies}, or {items}) to an array. */
function asArray(v: unknown): Record<string, any>[] {
  if (Array.isArray(v)) return v as Record<string, any>[];
  if (v && typeof v === 'object') {
    const o = v as Record<string, any>;
    if (Array.isArray(o.companies)) return o.companies;
    if (Array.isArray(o.items)) return o.items;
    if (Array.isArray(o.data)) return o.data;
  }
  return [];
}

/** A scoreDetails component "fails" if it's boolean false or a number below 50. */
function failing(v: unknown): boolean {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return v < 50;
  return false;
}

export function registerFitScoreTools(server: McpServer, ctx: SessionCtx): void {
  defineTool(
    server,
    'verify_company',
    {
      title: 'Verify / score a company',
      description:
        'Run the buyer-fit scorer on one company and return the verdict (is_real_business, icp_match, buyer_signal_strength, decision_maker_reachable + aggregate score). Use force to bypass cache.',
      inputSchema: { id: z.string().uuid(), force: z.boolean().optional() },
    },
    async (a) =>
      text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/fit-score/companies/${a.id}`, body: { force: a.force } })),
  );

  defineTool(
    server,
    'batch_score',
    {
      title: 'Batch-score companies',
      description: 'Re-score all (or specific) companies for a master agent.',
      inputSchema: {
        agentId: z.string().uuid(),
        companyIds: z.array(z.string().uuid()).optional(),
        force: z.boolean().optional(),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/fit-score/agents/${a.agentId}/batch`,
          body: { companyIds: a.companyIds, force: a.force },
        }),
      ),
  );

  defineTool(
    server,
    'set_fit_score',
    {
      title: 'Manually set a company fit score',
      description:
        'Override a company’s fit score (0-100) with a manual value and a reason — no AI recompute. Use when you’ve judged the company yourself. To re-run the AI scorer instead, use verify_company.',
      inputSchema: {
        companyId: z.string().uuid(),
        score: z.number().int().min(0).max(100),
        reason: z.string().max(500).describe('Why this score (recorded on the company)'),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'PATCH',
          path: `/api/companies/${a.companyId}/fit-score`,
          body: { score: a.score, reason: a.reason },
        }),
      ),
  );

  defineTool(
    server,
    'get_fit_stats',
    {
      title: 'Fit-score stats',
      description: 'Score-band distribution and averages for a master agent.',
      inputSchema: { agentId: z.string().uuid() },
    },
    async (a) =>
      text(await agentcoreFetch(ctx, { method: 'GET', path: `/api/fit-score/agents/${a.agentId}/stats` })),
  );

  defineTool(
    server,
    'review_findings',
    {
      title: 'Review findings (flag likely-wrong companies)',
      description:
        'Audit a master agent’s companies: returns those below the fit threshold and flags the likely-incorrect ones (failing is_real_business or icp_match) with a suggested cleanup action. This is the "filter findings + check companies are correct" tool. It does not modify anything — pair it with mark_do_not_contact / set_contact_status / delete to act.',
      inputSchema: {
        agentId: z.string().uuid(),
        threshold: z.number().int().min(0).max(100).default(40).describe('Flag companies scoring below this (default 40)'),
      },
    },
    async (a) => {
      const threshold = (a.threshold as number | undefined) ?? 40;
      const raw = await agentcoreFetch(ctx, {
        method: 'GET',
        path: '/api/companies',
        query: { masterAgentId: a.agentId, includeIncomplete: true, sortBy: 'fit_score', limit: 100 },
      });
      const companies = asArray(raw);

      const flagged = companies
        .map((c) => {
          const score = typeof c.score === 'number' ? c.score : null;
          const d = (c.scoreDetails ?? c.score_details ?? {}) as Record<string, unknown>;
          const reasons: string[] = [];
          if (failing(d.is_real_business)) reasons.push('not a real business');
          if (failing(d.icp_match)) reasons.push('does not match ICP');
          if (failing(d.buyer_signal_strength)) reasons.push('weak buyer signal');
          const belowThreshold = score !== null && score < threshold;
          return { c, score, reasons, belowThreshold };
        })
        .filter((x) => x.belowThreshold || x.reasons.length > 0)
        .map((x) => ({
          companyId: x.c.id,
          name: x.c.name,
          domain: x.c.domain ?? null,
          score: x.score,
          dataCompleteness: x.c.dataCompleteness ?? x.c.data_completeness ?? null,
          reasons: x.reasons,
          suggestedAction:
            x.reasons.includes('not a real business') || x.reasons.includes('does not match ICP')
              ? 'reject (mark contacts do_not_contact or delete the company)'
              : x.score !== null && x.score < threshold
                ? 'review — low fit score'
                : 'review',
        }));

      return text({
        agentId: a.agentId,
        threshold,
        totalCompanies: companies.length,
        flaggedCount: flagged.length,
        flagged,
      });
    },
  );
}
