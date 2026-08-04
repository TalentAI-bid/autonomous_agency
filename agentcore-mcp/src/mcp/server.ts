import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionCtx } from './session-store.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerCompanyTools } from './tools/companies.js';
import { registerContactTools } from './tools/contacts.js';
import { registerFitScoreTools } from './tools/fit-score.js';
import { registerAgentTools } from './tools/agents.js';
import { registerExtensionTools } from './tools/extension.js';
import { registerCompanyResource } from './resources/company.js';
import { registerAgentResource } from './resources/agent.js';
import { registerAuditPipelinePrompt } from './prompts/audit-pipeline.js';

/**
 * One McpServer per MCP session, closing over that session's mutable context
 * (bearer + selected workspace). Tools read ctx at call time, so updates from
 * use_workspace and per-request token refresh are picked up automatically.
 */
export function createMcpServer(ctx: SessionCtx): McpServer {
  const server = new McpServer(
    { name: 'talentai', version: '1.0.0' },
    {
      instructions:
        'Drive the TalentAI platform: list/verify/filter findings, control agents, and do outreach. ' +
        'ALWAYS call list_workspaces then use_workspace before any other tool. ' +
        'Outreach: send_email SENDS an email immediately via the user\'s SMTP — always show the draft and get ' +
        'the user\'s explicit go-ahead in chat before calling it (draft_email only drafts, sends nothing). ' +
        'linkedin_message / linkedin_connect_note do NOT send by themselves — they open the profile and type the ' +
        'text into LinkedIn for the user to review and click Send. Use capture_lead to add a brand-new lead first. ' +
        'Reporting / next-step: get_contact_outreach shows one contact’s sent emails (with date/time), LinkedIn ' +
        'touches, pipeline stage and whether they replied — read it before deciding to send a first LinkedIn ' +
        'message or a follow-up; list_sent_emails lists recent sends across the workspace. send_email is used for ' +
        'both first emails and follow-ups; it lands in the real mailbox Sent folder, advances the pipeline, and ' +
        'auto-enrolls the contact into the follow-up sequence (later touches are sent automatically). ' +
        'Discovery: fetch_company_data(parts:"team", keyword) fetches only one role at a company you already have; ' +
        'search_people(keywords, regions?) searches all of LinkedIn for a role and imports the matches as new leads.',
    },
  );

  registerWorkspaceTools(server, ctx);
  registerCompanyTools(server, ctx);
  registerContactTools(server, ctx);
  registerFitScoreTools(server, ctx);
  registerAgentTools(server, ctx);
  registerExtensionTools(server, ctx);
  registerCompanyResource(server, ctx);
  registerAgentResource(server, ctx);
  registerAuditPipelinePrompt(server);

  return server;
}
