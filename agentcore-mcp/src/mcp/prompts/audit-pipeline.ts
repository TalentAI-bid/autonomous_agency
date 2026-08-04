import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerAuditPipelinePrompt(server: McpServer): void {
  server.registerPrompt(
    'audit_pipeline',
    {
      title: 'Audit pipeline',
      description: 'Guide an end-to-end audit of a workspace’s findings quality and agent health.',
      argsSchema: {
        threshold: z.string().optional().describe('Fit-score threshold to flag below (default 40)'),
      },
    },
    (args) => {
      const threshold = args.threshold ?? '40';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Audit this workspace's pipeline. Steps:\n` +
                `1. Call list_workspaces and confirm the right workspace is selected (use_workspace if not).\n` +
                `2. Call list_agents.\n` +
                `3. For each agent: call get_fit_stats(agentId) and review_findings(agentId, threshold=${threshold}).\n` +
                `4. Summarize, per agent: total companies, score-band distribution, and the flagged likely-incorrect companies with their reasons.\n` +
                `5. Recommend concrete cleanup (which companies to mark do-not-contact / reject), but DO NOT perform any writes until I approve.\n` +
                `Report findings as a concise table.`,
            },
          },
        ],
      };
    },
  );
}
