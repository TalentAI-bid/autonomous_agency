import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import type { SessionCtx } from '../session-store.js';

export function registerAgentResource(server: McpServer, ctx: SessionCtx): void {
  server.registerResource(
    'agent',
    new ResourceTemplate('agent://{id}', { list: undefined }),
    {
      title: 'Master agent',
      description: 'A master agent by id (agent://<uuid>). Requires a selected workspace.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const data = await agentcoreFetch(ctx, { method: 'GET', path: `/api/master-agents/${id}` });
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
