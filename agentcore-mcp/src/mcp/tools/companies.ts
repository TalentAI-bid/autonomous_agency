import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import { defineTool, text } from '../tool-helper.js';
import { ToolError } from '../../util/errors.js';
import type { SessionCtx } from '../session-store.js';

export function registerCompanyTools(server: McpServer, ctx: SessionCtx): void {
  defineTool(
    server,
    'list_companies',
    {
      title: 'List companies',
      description: 'List discovered companies (findings) in the selected workspace, with optional filters.',
      inputSchema: {
        agentId: z.string().uuid().optional().describe('Filter to a single master agent'),
        industry: z.string().optional(),
        search: z.string().optional().describe('Match name or domain'),
        includeIncomplete: z.boolean().optional().describe('Include low-completeness companies (default hides them)'),
        sortBy: z.enum(['fit_score', 'created']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'GET',
          path: '/api/companies',
          query: {
            masterAgentId: a.agentId,
            industry: a.industry,
            search: a.search,
            includeIncomplete: a.includeIncomplete,
            sortBy: a.sortBy,
            limit: a.limit,
          },
        }),
      ),
  );

  defineTool(
    server,
    'get_company',
    {
      title: 'Get company',
      description: 'Full detail for one company, including fit score and raw enrichment data.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'GET', path: `/api/companies/${a.id}` })),
  );

  defineTool(
    server,
    'refetch_company_info',
    {
      title: 'Re-fetch company info',
      description: 'Re-enqueue a LinkedIn company-info scrape for one company (requires a connected extension).',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/companies/${a.id}/refetch-info` })),
  );

  defineTool(
    server,
    'refetch_team',
    {
      title: 'Re-fetch company team',
      description: 'Re-enqueue a LinkedIn team-member scrape for one company (requires a connected extension).',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/companies/${a.id}/refetch-team` })),
  );

  defineTool(
    server,
    'retry_stuck_enrichment',
    {
      title: 'Retry stuck enrichment',
      description: 'Re-enqueue enrichment for companies stuck at very low data completeness across the workspace.',
    },
    async () =>
      text(await agentcoreFetch(ctx, { method: 'POST', path: '/api/companies/admin/retry-stuck-enrichment' })),
  );

  defineTool(
    server,
    'enrich_companies',
    {
      title: 'Enrich a list of companies via the extension',
      description:
        'Kick off LinkedIn enrichment (company info + team members, optional website crawl) for a LIST of companies. Each must have a LinkedIn URL (others are skipped). Requires a connected extension; tasks queue and run as it processes. Use check_fetch_status per company to see results land.',
      inputSchema: {
        companyIds: z.array(z.string().uuid()).min(1).max(200),
        crawlWebsite: z.boolean().optional().describe('Also scrape each company website (default false)'),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: '/api/companies/batch/enrich',
          body: { companyIds: a.companyIds, crawlWebsite: a.crawlWebsite ?? false },
        }),
      ),
  );

  defineTool(
    server,
    'add_companies',
    {
      title: 'Add companies (by name or LinkedIn URL) and auto-enrich',
      description:
        'Add one or many NEW companies to an agent by name and/or LinkedIn company URL, then auto-enrich each (company info + team members). '
        + 'Entries with a LinkedIn URL start enriching immediately. Name-only entries first run a LinkedIn company search to resolve the URL, '
        + 'then enrich — these depend on a connected LinkedIn extension, resolve asynchronously (minutes), and may report no match. '
        + 'So results are QUEUED, not done: use get_company / list_companies afterwards to see info + team land. '
        + 'Pass agentId (from list_agents); omit it only if the workspace has exactly one agent. '
        + 'Re-adding the same company is safe (it dedups, no duplicate row). Use this to add brand-new companies; '
        + 'use enrich_companies to (re)enrich companies that already exist with a LinkedIn URL.',
      inputSchema: {
        agentId: z
          .string()
          .uuid()
          .optional()
          .describe('Master agent to own these companies. Omit only if the workspace has exactly one agent.'),
        companies: z
          .array(
            z.object({
              name: z.string().max(255).optional(),
              linkedinUrl: z.string().url().max(500).optional(),
            }),
          )
          .min(1)
          .max(50)
          .describe('Each entry needs a name OR a LinkedIn company URL (or both).'),
        crawlWebsite: z.boolean().optional().describe('Also scrape each company website (default false)'),
      },
    },
    async (a) => {
      let masterAgentId = a.agentId as string | undefined;
      if (!masterAgentId) {
        const agents = (await agentcoreFetch<Array<{ id: string; name?: string }>>(ctx, {
          method: 'GET',
          path: '/api/master-agents',
        })) ?? [];
        if (agents.length === 1) {
          masterAgentId = agents[0]!.id;
        } else if (agents.length === 0) {
          throw new ToolError('This workspace has no agents — create one with create_agent first.');
        } else {
          const list = agents.map((ag) => `- ${ag.name ?? '(unnamed)'} (${ag.id})`).join('\n');
          throw new ToolError(`This workspace has multiple agents — pass agentId. Available:\n${list}`);
        }
      }
      return text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: '/api/companies/ingest',
          body: { masterAgentId, companies: a.companies, crawlWebsite: a.crawlWebsite ?? false },
        }),
      );
    },
  );

  defineTool(
    server,
    'delete_companies',
    {
      title: 'Delete garbage companies',
      description:
        'Permanently delete one or more companies (e.g. junk/incorrect findings). DESTRUCTIVE and irreversible — confirm the list with the user before calling. Linked contacts are kept but unlinked.',
      inputSchema: { companyIds: z.array(z.string().uuid()).min(1).max(100) },
    },
    async (a) => {
      const ids = a.companyIds as string[];
      const deleted: string[] = [];
      const failed: { id: string; error: string }[] = [];
      for (const id of ids) {
        try {
          await agentcoreFetch(ctx, { method: 'DELETE', path: `/api/companies/${id}` });
          deleted.push(id);
        } catch (err) {
          failed.push({ id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return text({ deletedCount: deleted.length, deleted, failed });
    },
  );
}
