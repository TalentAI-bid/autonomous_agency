import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import { defineTool, text } from '../tool-helper.js';
import { ToolError } from '../../util/errors.js';
import { hydrateSelectedFromDefault, type SessionCtx, type Workspace } from '../session-store.js';

export function registerWorkspaceTools(server: McpServer, ctx: SessionCtx): void {
  defineTool(
    server,
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        'List the workspaces (tenants) you can access. Call this first, then use_workspace to pick one. All other tools act on the selected workspace.',
    },
    async () => {
      const ws = await agentcoreFetch<Workspace[]>(ctx, {
        method: 'GET',
        path: '/api/workspaces',
        requireWorkspace: false,
      });
      // Recover the user's persisted selection so `selected` is accurate even on
      // a fresh session where nothing has called use_workspace yet.
      hydrateSelectedFromDefault(ctx, ws);
      const selected = ctx.tenantId;
      return text({
        selected: selected ? { id: selected, name: ctx.tenantName } : null,
        workspaces: ws.map((w) => ({ id: w.id, name: w.name, slug: w.slug, role: w.role })),
      });
    },
  );

  defineTool(
    server,
    'use_workspace',
    {
      title: 'Select a workspace',
      description:
        'Select which workspace subsequent tools operate on. Accepts a workspace id, exact name, or slug. Required before any findings/agent tool will run.',
      inputSchema: { workspace: z.string().min(1).describe('Workspace id, name, or slug') },
    },
    async (args) => {
      const wanted = String(args.workspace).trim();
      const ws = await agentcoreFetch<Workspace[]>(ctx, {
        method: 'GET',
        path: '/api/workspaces',
        requireWorkspace: false,
      });
      const lc = wanted.toLowerCase();
      const match =
        ws.find((w) => w.id === wanted) ??
        ws.find((w) => w.name.toLowerCase() === lc) ??
        ws.find((w) => w.slug.toLowerCase() === lc);
      if (!match) {
        throw new ToolError(
          `No workspace matches "${wanted}". Available: ${ws.map((w) => `${w.name} (${w.id})`).join(', ') || 'none'}.`,
        );
      }
      // Persist the choice as the user's default so it survives across MCP
      // requests (the in-memory ctx below is only a fast path for this session).
      await agentcoreFetch(ctx, {
        method: 'PUT',
        path: '/api/workspaces/default',
        body: { tenantId: match.id },
        requireWorkspace: false,
      });
      ctx.tenantId = match.id;
      ctx.tenantName = match.name;
      return text({ selected: { id: match.id, name: match.name, slug: match.slug, role: match.role } });
    },
  );
}
