import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import { defineTool, text } from '../tool-helper.js';
import { ToolError } from '../../util/errors.js';
import type { SessionCtx } from '../session-store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Company {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  description: string | null;
  linkedinUrl: string | null;
  dataCompleteness: number | null;
  rawData?: Record<string, any> | null;
}

function summarize(c: Company) {
  const raw = c.rawData ?? {};
  const people = Array.isArray(raw.people) ? raw.people : [];
  return {
    companyId: c.id,
    name: c.name,
    domain: c.domain,
    industry: c.industry,
    size: c.size,
    description: c.description,
    linkedinUrl: c.linkedinUrl,
    dataCompleteness: c.dataCompleteness,
    infoFetchedAt: raw.infoFetchedAt ?? null,
    teamFetchedAt: raw.teamFetchedAt ?? null,
    peopleCount: people.length,
    people: people.slice(0, 8).map((p: any) => ({ name: p.name, title: p.title, profileUrl: p.profileUrl ?? p.linkedinUrl })),
  };
}

export function registerExtensionTools(server: McpServer, ctx: SessionCtx): void {
  defineTool(
    server,
    'extension_status',
    {
      title: 'Extension status',
      description:
        'Whether the LinkedIn Chrome extension is connected for this user, plus how many fetch tasks are queued. Check this before asking the extension to fetch — fetches only run while the extension is connected and active.',
    },
    async () => text(await agentcoreFetch(ctx, { method: 'GET', path: '/api/extension/status' })),
  );

  defineTool(
    server,
    'fetch_company_data',
    {
      title: 'Ask the extension to fetch company data',
      description:
        'Tell the LinkedIn browser extension to (re)fetch a company’s info and/or team for a company already in the pipeline. The company must have a LinkedIn URL. Pass keyword to fetch only employees in a given role (e.g. "sales manager", "VP Sales") instead of the whole team. Dispatches the fetch, waits briefly, and returns the data if it arrives — otherwise reports "dispatched" and you can poll with check_fetch_status. Fetches require a connected, active extension.',
      inputSchema: {
        companyId: z.string().uuid(),
        parts: z.enum(['info', 'team', 'both']).default('both').describe('What to fetch: company info, team members, or both'),
        waitSeconds: z.number().int().min(0).max(60).default(25).describe('How long to wait for results before returning'),
        keyword: z
          .string()
          .max(100)
          .optional()
          .describe('(team fetch only) Role/keyword filter — fetch only employees whose title matches, e.g. "sales manager". Omit to fetch the whole team.'),
      },
    },
    async (a) => {
      const parts = (a.parts as 'info' | 'team' | 'both' | undefined) ?? 'both';
      const wantInfo = parts === 'info' || parts === 'both';
      const wantTeam = parts === 'team' || parts === 'both';
      const waitMs = ((a.waitSeconds as number | undefined) ?? 25) * 1000;

      const company = await agentcoreFetch<Company>(ctx, { method: 'GET', path: `/api/companies/${a.companyId}` });
      if (!company?.id) throw new ToolError('Company not found in this workspace.');
      if (!company.linkedinUrl) {
        throw new ToolError(
          `"${company.name}" has no LinkedIn URL, so the extension can’t fetch it. Find the company on LinkedIn first.`,
        );
      }

      const status = await agentcoreFetch<{ connected: boolean; hasKey: boolean }>(ctx, {
        method: 'GET',
        path: '/api/extension/status',
      });

      const baseInfo = company.rawData?.infoFetchedAt ?? null;
      const baseTeam = company.rawData?.teamFetchedAt ?? null;

      const keyword = (a.keyword as string | undefined)?.trim() || undefined;
      if (wantInfo) await agentcoreFetch(ctx, { method: 'POST', path: `/api/companies/${a.companyId}/refetch-info` });
      if (wantTeam)
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/companies/${a.companyId}/refetch-team`,
          body: keyword ? { keyword } : {},
        });

      if (!status?.connected) {
        return text({
          status: 'dispatched',
          extensionConnected: false,
          message:
            'Fetch queued, but the extension is not currently connected — it will run once the user opens/connects the LinkedIn extension. Poll later with check_fetch_status.',
          requested: parts,
          companyId: a.companyId,
        });
      }

      // Short poll: the fetch is done when the relevant *FetchedAt stamps advance.
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await sleep(3000);
        const cur = await agentcoreFetch<Company>(ctx, { method: 'GET', path: `/api/companies/${a.companyId}` });
        const infoDone = !wantInfo || (cur.rawData?.infoFetchedAt ?? null) !== baseInfo;
        const teamDone = !wantTeam || (cur.rawData?.teamFetchedAt ?? null) !== baseTeam;
        if (infoDone && teamDone) {
          return text({ status: 'completed', requested: parts, data: summarize(cur) });
        }
      }

      return text({
        status: 'dispatched',
        extensionConnected: true,
        message: 'Fetch is running in the extension but did not finish in time. Poll with check_fetch_status in a bit.',
        requested: parts,
        companyId: a.companyId,
      });
    },
  );

  defineTool(
    server,
    'search_people',
    {
      title: 'Search LinkedIn for people by role (imports as leads)',
      description:
        'Search ALL of LinkedIn for people by role/keyword (e.g. "sales manager", "VP Sales", "Head of Growth"), optionally narrowed to one or more regions, and import the matches as leads (contacts) in the current workspace. Unlike fetch_company_data (people of one company you already have), this finds people across many companies. Results land as contacts with no company attached; see them with list_contacts. Requires a connected, active extension and respects a conservative daily cap. Show the user what you will search and get a go-ahead first.',
      inputSchema: {
        keywords: z.string().min(1).max(200).describe('Role/keyword to search, e.g. "sales manager"'),
        regions: z
          .array(z.string().min(1).max(60))
          .max(10)
          .optional()
          .describe('Optional region filter, e.g. ["India"] or ["United States","Canada"]'),
        agentId: z.string().uuid().optional().describe('Optional master agent to attribute the imported leads to'),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: '/api/contacts/search-people',
          body: {
            keywords: a.keywords,
            regions: a.regions,
            masterAgentId: a.agentId,
          },
        }),
      ),
  );

  defineTool(
    server,
    'check_fetch_status',
    {
      title: 'Check a company fetch',
      description:
        'Check whether a previously requested company fetch has landed: returns the company’s current info/team data plus the status of recent extension tasks for it.',
      inputSchema: { companyId: z.string().uuid() },
    },
    async (a) => {
      const company = await agentcoreFetch<Company>(ctx, { method: 'GET', path: `/api/companies/${a.companyId}` });
      if (!company?.id) throw new ToolError('Company not found in this workspace.');

      const recent = await agentcoreFetch<{ tasks?: any[] } | any[]>(ctx, {
        method: 'GET',
        path: '/api/extension/tasks/recent',
        query: { limit: 50 },
      });
      const tasks = Array.isArray(recent) ? recent : (recent?.tasks ?? []);
      const mine = tasks
        .filter((t: any) => t?.params?.companyId === a.companyId)
        .map((t: any) => ({ type: t.type, status: t.status, error: t.error ?? null, completedAt: t.completedAt ?? null }));

      return text({ company: summarize(company), recentTasks: mine });
    },
  );

  defineTool(
    server,
    'linkedin_message',
    {
      title: 'Stage a LinkedIn DM (review-then-send)',
      description:
        'Open a contact’s LinkedIn profile in the user’s browser extension and TYPE a direct message into the ' +
        'compose box — then STOP for the user to review and click Send. This does NOT send by itself (protects ' +
        'the LinkedIn account). The contact must have a LinkedIn URL and the extension must be connected. Best ' +
        'for people the user is already connected to; for others use linkedin_connect_note. Write the message ' +
        'yourself and show it to the user first.',
      inputSchema: {
        contactId: z.string().uuid(),
        message: z.string().min(1).max(8000).describe('The DM text to stage in LinkedIn for the user to send'),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/contacts/${a.contactId}/linkedin-message`,
          body: { message: a.message },
        }),
      ),
  );

  defineTool(
    server,
    'linkedin_connect_note',
    {
      title: 'Stage a LinkedIn connection request note (review-then-send)',
      description:
        'Open a contact’s LinkedIn profile and start a connection request with a personalized note typed into the ' +
        '“Add a note” box — then STOP for the user to review and click Send. Does NOT send by itself. Use this for ' +
        'people the user is NOT yet connected to. The contact needs a LinkedIn URL and a connected extension. Keep ' +
        'the note within LinkedIn’s ~300-character invite limit. Write it yourself and show the user first.',
      inputSchema: {
        contactId: z.string().uuid(),
        note: z.string().min(1).max(300).describe('The connection-request note (LinkedIn caps invites at ~300 chars)'),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/contacts/${a.contactId}/linkedin-connect`,
          body: { note: a.note },
        }),
      ),
  );
}
