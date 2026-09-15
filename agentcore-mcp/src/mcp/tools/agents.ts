import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import { defineTool, text } from '../tool-helper.js';
import type { SessionCtx } from '../session-store.js';

export function registerAgentTools(server: McpServer, ctx: SessionCtx): void {
  defineTool(
    server,
    'list_agents',
    { title: 'List master agents', description: 'List the master agents in the selected workspace.' },
    async () => text(await agentcoreFetch(ctx, { method: 'GET', path: '/api/master-agents' })),
  );

  defineTool(
    server,
    'create_agent',
    {
      title: 'Create a new research agent',
      description:
        'Create a new master agent that researches and discovers companies, and (by default) start it immediately — no action-plan questions, no outreach (discovery + enrichment + scoring only). Choose the use case and discovery strategy.',
      inputSchema: {
        name: z.string().min(1).max(255),
        mission: z.string().min(1).describe('What to research, e.g. "Find AI-inference cloud providers in the US hiring ML infra engineers"'),
        useCase: z.enum(['sales', 'recruitment']).describe('sales = find target companies; recruitment = find hiring companies/candidates'),
        strategy: z
          .enum(['hiring_signal', 'industry_target', 'hybrid', 'web_search', 'local_business', 'local_hybrid'])
          .default('hybrid')
          .describe(
            'hiring_signal = companies actively hiring (LinkedIn Jobs); industry_target = companies by industry/ICP; hybrid = both; web_search = Google discovery (SERP dorks harvesting LinkedIn company/person URLs); local_business = Google Maps (local/brick-and-mortar); local_hybrid = Google Maps + LinkedIn-via-Google. Pick web_search/local_* only when the user explicitly wants that discovery source.',
          ),
        locations: z.array(z.string()).optional().describe('Target countries/cities, e.g. ["United States","Germany"]'),
        autoStart: z.boolean().default(true).describe('Start researching immediately after creation'),
      },
    },
    async (a) => {
      const config: Record<string, unknown> = {
        skipActionPlan: true, // research agent: begin immediately, no action-plan stop
        enableOutreach: false, // never sends outreach
        userExplicitBdStrategy: a.strategy ?? 'hybrid',
      };
      if (Array.isArray(a.locations) && a.locations.length) config.locations = a.locations;

      const agent = await agentcoreFetch<{ id: string; name: string; status: string }>(ctx, {
        method: 'POST',
        path: '/api/master-agents',
        body: { name: a.name, mission: a.mission, useCase: a.useCase, config },
      });

      if ((a.autoStart ?? true) === false) {
        return text({ created: agent, started: false, note: 'Created idle. Call start_agent to begin.' });
      }

      const started = await agentcoreFetch(ctx, {
        method: 'POST',
        path: `/api/master-agents/${agent.id}/start`,
        timeoutMs: 180_000, // start runs the strategist + initial dispatch inline
      });
      return text({ created: { id: agent.id, name: agent.name }, started: true, result: started });
    },
  );

  defineTool(
    server,
    'get_agent',
    {
      title: 'Get master agent',
      description: 'Full configuration and status for one master agent.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'GET', path: `/api/master-agents/${a.id}` })),
  );

  defineTool(
    server,
    'start_agent',
    {
      title: 'Start agent',
      description: 'Start (run) a master agent’s pipeline.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/master-agents/${a.id}/start` })),
  );

  defineTool(
    server,
    'stop_agent',
    {
      title: 'Stop agent',
      description: 'Stop (pause) a master agent and cancel its in-flight work.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/master-agents/${a.id}/stop` })),
  );

  defineTool(
    server,
    'regenerate_strategy',
    {
      title: 'Regenerate strategy',
      description: 'Force the strategist to recompute a master agent’s strategy from scratch.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) =>
      text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/master-agents/${a.id}/regenerate-strategy` })),
  );

  defineTool(
    server,
    'get_agent_stats',
    {
      title: 'Agent stats',
      description: 'Contact distribution by status and average score for a master agent.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'GET', path: `/api/master-agents/${a.id}/stats` })),
  );

  defineTool(
    server,
    'get_agent_errors',
    {
      title: 'Agent errors',
      description: 'Pipeline errors for a master agent (unresolved by default).',
      inputSchema: { id: z.string().uuid(), unresolved: z.boolean().optional() },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'GET',
          path: `/api/master-agents/${a.id}/errors`,
          query: { unresolved: a.unresolved },
        }),
      ),
  );

  defineTool(
    server,
    'get_quota',
    {
      title: 'Agent quota',
      description: 'Daily runtime budget snapshot for a master agent.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'GET', path: `/api/master-agents/${a.id}/quota` })),
  );

  defineTool(
    server,
    'analyze_pipeline',
    {
      title: 'Analyze pipeline',
      description: 'Run an AI analysis of the pipeline for a use case (sales or recruitment), with optional filters.',
      inputSchema: {
        useCase: z.enum(['sales', 'recruitment', 'custom']).optional(),
        targetRole: z.string().optional(),
        industry: z.string().optional(),
        companySize: z.string().optional(),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: '/api/master-agents/analyze-pipeline',
          body: {
            useCase: a.useCase,
            targetRole: a.targetRole,
            industry: a.industry,
            companySize: a.companySize,
          },
        }),
      ),
  );
}
