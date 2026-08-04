import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import type { SessionCtx } from '../session-store.js';

export function registerCompanyResource(server: McpServer, ctx: SessionCtx): void {
  server.registerResource(
    'company',
    new ResourceTemplate('company://{id}', { list: undefined }),
    {
      title: 'Company',
      description: 'A discovered company by id (company://<uuid>). Requires a selected workspace.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const id = String(variables.id);
      const data = await agentcoreFetch(ctx, { method: 'GET', path: `/api/companies/${id}` });
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
      };
    },
  );
}
