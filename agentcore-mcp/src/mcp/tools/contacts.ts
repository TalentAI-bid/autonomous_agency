import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { agentcoreFetch } from '../proxy.js';
import { defineTool, text } from '../tool-helper.js';
import type { SessionCtx } from '../session-store.js';

const CONTACT_STATUS = [
  'discovered',
  'enriched',
  'scored',
  'contacted',
  'replied',
  'qualified',
  'interview_scheduled',
  'rejected',
  'archived',
] as const;

export function registerContactTools(server: McpServer, ctx: SessionCtx): void {
  defineTool(
    server,
    'list_contacts',
    {
      title: 'List contacts',
      description: 'List contacts (decision-maker leads) in the selected workspace, with optional filters.',
      inputSchema: {
        status: z.enum(CONTACT_STATUS).optional(),
        stage: z.string().optional().describe('Prospect pipeline stage'),
        tag: z.string().optional(),
        minScore: z.number().int().min(0).max(100).optional(),
        maxScore: z.number().int().min(0).max(100).optional(),
        agentId: z.string().uuid().optional(),
        companyId: z.string().uuid().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'GET',
          path: '/api/contacts',
          query: {
            status: a.status,
            stage: a.stage,
            tag: a.tag,
            minScore: a.minScore,
            maxScore: a.maxScore,
            masterAgentId: a.agentId,
            companyId: a.companyId,
            search: a.search,
            limit: a.limit,
          },
        }),
      ),
  );

  defineTool(
    server,
    'get_contact',
    {
      title: 'Get contact',
      description: 'Full detail for one contact, including prospect stage and recent timeline.',
      inputSchema: { id: z.string().uuid() },
    },
    async (a) => text(await agentcoreFetch(ctx, { method: 'GET', path: `/api/contacts/${a.id}` })),
  );

  defineTool(
    server,
    'mark_do_not_contact',
    {
      title: 'Mark do-not-contact',
      description: 'Flag a contact as do-not-contact (with an optional reason). Reversible quality action.',
      inputSchema: { id: z.string().uuid(), reason: z.string().optional() },
    },
    async (a) =>
      text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/contacts/${a.id}/dnc`, body: { reason: a.reason } })),
  );

  defineTool(
    server,
    'set_contact_status',
    {
      title: 'Set contact status',
      description: 'Update a contact’s status (e.g. mark a bad finding rejected or archived).',
      inputSchema: { id: z.string().uuid(), status: z.enum(CONTACT_STATUS) },
    },
    async (a) =>
      text(await agentcoreFetch(ctx, { method: 'PATCH', path: `/api/contacts/${a.id}`, body: { status: a.status } })),
  );

  defineTool(
    server,
    'update_contact',
    {
      title: 'Correct a contact’s name / role',
      description:
        'Fix a contact’s first name, last name, title/role, or LinkedIn URL — for cases where the extension scraped a wrong or garbled value. Provide at least one field; omitted fields are left unchanged. Does not send anything. To pull fresh values from LinkedIn instead of typing them, use rescrape_contact.',
      inputSchema: {
        contactId: z.string().uuid(),
        firstName: z.string().max(255).optional(),
        lastName: z.string().max(255).optional(),
        title: z.string().max(255).optional().describe('Job title / role'),
        linkedinUrl: z.string().url().max(500).optional(),
      },
    },
    async (a) => {
      const body: Record<string, unknown> = {};
      if (a.firstName !== undefined) body.firstName = a.firstName;
      if (a.lastName !== undefined) body.lastName = a.lastName;
      if (a.title !== undefined) body.title = a.title;
      if (a.linkedinUrl !== undefined) body.linkedinUrl = a.linkedinUrl;
      if (Object.keys(body).length === 0) {
        throw new Error('Provide at least one field to update (firstName, lastName, title, or linkedinUrl).');
      }
      return text(await agentcoreFetch(ctx, { method: 'PATCH', path: `/api/contacts/${a.contactId}`, body }));
    },
  );

  defineTool(
    server,
    'rescrape_contact',
    {
      title: 'Re-scrape a contact from LinkedIn',
      description:
        'Ask the browser extension to re-open this contact’s LinkedIn profile and read the correct name + role. The result lands as a SUGGESTION on the contact (rawData.linkedinRescrape) — it does NOT overwrite the live fields. Poll with get_contact, then apply the suggestion with update_contact. Requires a connected extension and a LinkedIn URL on the contact.',
      inputSchema: { contactId: z.string().uuid() },
    },
    async (a) =>
      text(await agentcoreFetch(ctx, { method: 'POST', path: `/api/contacts/${a.contactId}/rescrape-linkedin` })),
  );

  defineTool(
    server,
    'add_tags',
    {
      title: 'Add / remove tags',
      description: 'Add and/or remove custom tags on a contact for segmentation.',
      inputSchema: {
        id: z.string().uuid(),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/contacts/${a.id}/tags`,
          body: { add: a.add ?? [], remove: a.remove ?? [] },
        }),
      ),
  );

  defineTool(
    server,
    'draft_email',
    {
      title: 'Draft a cold email (no send)',
      description:
        'Generate an AI cold-email draft for a contact and RETURN it. This never sends anything — it is for review only.',
      inputSchema: { id: z.string().uuid(), hint: z.string().optional().describe('Optional steering hint') },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/contacts/${a.id}/draft-email`,
          body: { hint: a.hint },
        }),
      ),
  );

  defineTool(
    server,
    'capture_lead',
    {
      title: 'Add a new lead',
      description:
        'Create (or find, if it already exists) a lead in the workspace from details the user gives you — e.g. ' +
        '“add Jane Doe, Head of Eng at Acme, jane@acme.com”. Returns the contactId (use it for send_email / ' +
        'linkedin_message). De-duplicates by email or LinkedIn URL, so calling it again is safe. At least a name ' +
        'is required; include email to be able to send email, and linkedinUrl to be able to do LinkedIn outreach.',
      inputSchema: {
        name: z.string().max(255).optional().describe('Full name (split automatically if first/last not given)'),
        firstName: z.string().max(255).optional(),
        lastName: z.string().max(255).optional(),
        email: z.string().email().max(320).optional(),
        linkedinUrl: z.string().url().max(500).optional(),
        company: z.string().max(255).optional(),
        title: z.string().max(255).optional(),
        location: z.string().max(255).optional(),
      },
    },
    async (a) => {
      if (!a.name && !a.firstName && !a.lastName) {
        throw new Error('Provide at least a name (name, or firstName/lastName).');
      }
      return text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: '/api/contacts/capture',
          body: {
            name: a.name,
            firstName: a.firstName,
            lastName: a.lastName,
            email: a.email,
            linkedinUrl: a.linkedinUrl,
            company: a.company,
            title: a.title,
            location: a.location,
            sourceType: 'manual_other',
          },
        }),
      );
    },
  );

  defineTool(
    server,
    'send_email',
    {
      title: 'Send an email to a contact (SENDS immediately)',
      description:
        'Send an email to a contact via the user’s configured SMTP account — use this for BOTH the first email ' +
        'and any follow-up. This SENDS immediately and cannot be unsent — ALWAYS show the user the subject + body ' +
        'and get their explicit go-ahead in chat before calling this. The contact must have an email (use ' +
        'capture_lead with an email, or update_contact, first). On send it: lands in the user’s real mailbox Sent ' +
        'folder (IMAP append), advances the pipeline stage and bumps the touch count, logs the contact timeline, ' +
        'and enrolls the contact into the automatic follow-up sequence (later touches are auto-sent over the next ' +
        '~10 days and also land in Sent). Call get_contact_outreach first to see what’s already been sent and ' +
        'decide the next step. Use draft_email if you want an AI-written draft to show the user first.',
      inputSchema: {
        contactId: z.string().uuid(),
        subject: z.string().min(1).max(255),
        body: z.string().min(1).describe('Plain-text email body (converted to HTML on send)'),
        track: z
          .enum(['NORMAL_OUTREACH', 'PARTNERSHIP_OUTREACH', 'COLLABORATION_OUTREACH', 'SKIP'])
          .optional()
          .describe('Optional outreach classification (from draft_email)'),
        classification: z
          .enum(['POTENTIAL_BUYER', 'DIRECT_COMPETITOR', 'ADJACENT_PARTNER', 'WRONG_FIT'])
          .optional(),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'POST',
          path: `/api/contacts/${a.contactId}/send-email`,
          body: { subject: a.subject, body: a.body, track: a.track, classification: a.classification },
          timeoutMs: 90_000, // SMTP send + Sent-folder IMAP append can take a few seconds
        }),
      ),
  );

  defineTool(
    server,
    'get_contact_outreach',
    {
      title: 'See a contact’s outreach history + pipeline stage',
      description:
        'Everything that has happened with one contact, in a single call: every email sent to them (subject, ' +
        'date/time sent, status, opened/replied), their LinkedIn touches (DMs / connection requests sent), their ' +
        'current pipeline stage, total touches, last-touched and last-reply timestamps, and the recent activity ' +
        'timeline. Use this to report what was sent and when, and to decide the next best action — e.g. whether to ' +
        'send a first LinkedIn message / connection note, or a follow-up email (and whether one is even due). ' +
        'Read this before send_email / linkedin_message / linkedin_connect_note.',
      inputSchema: {
        contactId: z.string().uuid(),
        timelineLimit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('How many recent timeline events to include (default 30)'),
      },
    },
    async (a) => {
      const contactId = a.contactId as string;
      const timelineLimit = (a.timelineLimit as number | undefined) ?? 30;
      // Compose from existing REST endpoints — no single endpoint returns all of
      // this, so fan out three reads and merge. Each is tenant-scoped server-side.
      const [detail, emails, timeline] = await Promise.all([
        agentcoreFetch<Record<string, unknown>>(ctx, { method: 'GET', path: `/api/contacts/${contactId}` }),
        agentcoreFetch<unknown[]>(ctx, { method: 'GET', path: `/api/contacts/${contactId}/outreach-emails` }),
        agentcoreFetch<unknown[]>(ctx, {
          method: 'GET',
          path: `/api/contacts/${contactId}/timeline`,
          query: { limit: timelineLimit },
        }),
      ]);
      const d = (detail ?? {}) as Record<string, unknown>;
      return text({
        contact: {
          id: d.id,
          firstName: d.firstName,
          lastName: d.lastName,
          title: d.title,
          email: d.email,
          linkedinUrl: d.linkedinUrl,
          companyId: d.companyId,
          status: d.status,
          doNotContact: d.doNotContact,
        },
        pipelineStage: d.prospectStage ?? null,
        emailsSent: emails ?? [],
        timeline: timeline ?? [],
      });
    },
  );

  defineTool(
    server,
    'list_sent_emails',
    {
      title: 'List recently sent emails (with date/time)',
      description:
        'List emails sent from this workspace’s mailbox — most recent first — including who they went to, the ' +
        'subject, the date/time sent, the status, and whether they were opened. Covers both manual sends and ' +
        'automatic follow-ups. Use it to answer "what emails did we send to clients and when". For one contact’s ' +
        'full history plus pipeline stage, use get_contact_outreach instead.',
      inputSchema: {
        search: z.string().optional().describe('Filter by recipient email or subject substring'),
        limit: z.number().int().min(1).max(100).optional().describe('Max emails to return (default 25)'),
      },
    },
    async (a) =>
      text(
        await agentcoreFetch(ctx, {
          method: 'GET',
          path: '/api/mailbox/sent',
          query: { search: a.search as string | undefined, limit: (a.limit as number | undefined) ?? 25 },
        }),
      ),
  );
}
