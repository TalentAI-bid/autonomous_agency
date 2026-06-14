import type { FastifyInstance } from 'fastify';
import { eq, and, gt, desc } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '../config/database.js';
import { tenants, contacts, crmActivities } from '../db/schema/index.js';
import type { MessagingConfig } from '../db/schema/tenants.js';
import { generateStudioMessage } from '../services/message-studio.service.js';
import { ensureMessagingConfig } from '../services/messaging-config.service.js';
import { logEvent } from '../services/timeline.service.js';
import { recordTouch } from '../services/prospect-stage.service.js';
import { ValidationError, UnauthorizedError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const generateSchema = z.object({
  channel: z.enum([
    'email_cold',
    'linkedin_dm',
    'linkedin_connection_request',
    'twitter_dm',
    'whatsapp',
    'telegram',
  ]),
  track: z.enum(['sales', 'partnership', 'collaboration']),
  messageType: z.enum([
    'first_message',
    'first_followup',
    'second_followup',
    'breakup',
    'reactivation',
    'post_meeting',
    'post_no_show',
  ]).default('first_message'),
  recipient: z.object({
    name: z.string().min(1, 'recipient.name is required'),
    company: z.string().optional(),
    title: z.string().optional(),
    location: z.string().optional(),
    linkedinUrl: z.string().optional(),
  }),
  customContext: z.string().max(2000).optional(),
});

const recordActionSchema = z.object({
  channel: z.enum(['linkedin_dm', 'linkedin_connection_request']),
  recipient: z.object({
    name: z.string().max(200).optional(),
    company: z.string().max(255).optional(),
    title: z.string().max(255).optional(),
    location: z.string().max(255).optional(),
    linkedinUrl: z.string().url().max(500),
  }),
  body: z.string().max(8000).optional(),
});

const configSchema = z.object({
  sender_name: z.string().max(200).optional(),
  sender_title: z.string().max(200).optional(),
  sender_location: z.string().max(200).optional(),
  sender_company: z.string().max(200).optional(),
  value_prop: z.string().max(2000).optional(),
  target_icp: z.string().max(2000).optional(),
  differentiator: z.string().max(2000).optional(),
  pricing_summary: z.string().max(500).optional(),
  brand_voice_notes: z.string().max(2000).optional(),
});

export default async function studioRoutes(fastify: FastifyInstance) {
  // Auth gate — without this the global JWT middleware never runs inside
  // the plugin's scope and request.userId is never populated, returning
  // 401 from every handler. Mirror what contactRoutes / copilotRoutes do.
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/studio/generate — generate a message
  fastify.post('/generate', async (request) => {
    if (!request.userId) throw new UnauthorizedError();
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const composition = await generateStudioMessage({
      tenantId: request.tenantId,
      userId: request.userId,
      channel: parsed.data.channel,
      track: parsed.data.track,
      messageType: parsed.data.messageType,
      recipient: parsed.data.recipient,
      customContext: parsed.data.customContext,
    });

    return { success: true, composition };
  });

  // POST /api/studio/record-action — record that the user SENT a LinkedIn DM
  // or a connection-request note from the extension. The extension detects the
  // Send click and reports it here; we resolve (or auto-create) the contact by
  // LinkedIn URL, log a CRM activity, and bump the prospect-stage touch.
  fastify.post('/record-action', async (request) => {
    if (!request.userId) throw new UnauthorizedError();
    const parsed = recordActionSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const { channel, recipient, body } = parsed.data;

    // Normalize the profile URL (drop query/hash) so matching is stable.
    const linkedinUrl = recipient.linkedinUrl.split('?')[0]!.split('#')[0]!;

    const activityType = channel === 'linkedin_dm' ? 'linkedin_message_sent' : 'linkedin_connection_sent';
    const touchChannel = channel === 'linkedin_dm' ? 'linkedin_dm' : 'linkedin_connect';

    // 1. Resolve contact by LinkedIn URL (most recent), else auto-create.
    const [existing] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, request.tenantId), eq(contacts.linkedinUrl, linkedinUrl)))
        .orderBy(desc(contacts.createdAt))
        .limit(1);
    });

    let contactId = existing?.id;
    let created = false;
    if (!contactId) {
      const parts = (recipient.name ?? '').trim().split(/\s+/).filter(Boolean);
      const firstName = parts[0] || 'Unknown';
      const lastName = parts.slice(1).join(' ') || undefined;
      const [inserted] = await withTenant(request.tenantId, async (tx) => {
        return tx.insert(contacts).values({
          tenantId: request.tenantId,
          firstName,
          lastName,
          title: recipient.title?.trim() || undefined,
          companyName: recipient.company?.trim() || undefined,
          location: recipient.location?.trim() || undefined,
          linkedinUrl,
          source: 'linkedin_profile',
          status: 'contacted',
          rawData: {
            discoverySource: 'linkedin_studio_extension',
            addedByUser: true,
            addedAt: new Date().toISOString(),
          },
        }).returning({ id: contacts.id });
      });
      contactId = inserted!.id;
      created = true;
      await logEvent({
        tenantId: request.tenantId,
        contactId,
        type: 'contact_added',
        eventCategory: 'discovery',
        actorType: 'user',
        actorUserId: request.userId,
        title: 'Contact added via extension',
        metadata: { via: 'extension', linkedinUrl, channel },
      });
    }

    // 2. Dedupe: auto-detected Send clicks can fire more than once. Skip if an
    // identical (contact, type) activity was logged in the last 60s.
    const recentCutoff = new Date(Date.now() - 60_000);
    const [recent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ id: crmActivities.id })
        .from(crmActivities)
        .where(and(
          eq(crmActivities.tenantId, request.tenantId),
          eq(crmActivities.contactId, contactId!),
          eq(crmActivities.type, activityType),
          gt(crmActivities.occurredAt, recentCutoff),
        ))
        .limit(1);
    });
    if (recent) {
      return { ok: true, contactId, created, deduped: true };
    }

    // 3. Log the outreach activity + bump the prospect-stage touch.
    await logEvent({
      tenantId: request.tenantId,
      contactId,
      type: activityType,
      eventCategory: 'outreach',
      actorType: 'user',
      actorUserId: request.userId,
      description: body,
      metadata: { via: 'extension', channel, linkedinUrl },
    });
    try {
      await recordTouch({ tenantId: request.tenantId, contactId, channel: touchChannel, actorUserId: request.userId });
    } catch (err) {
      logger.warn({ err, contactId }, 'record-action: recordTouch failed (non-fatal)');
    }

    return { ok: true, contactId, created, deduped: false };
  });

  // GET /api/studio/config — load messaging_config for the settings form.
  // When the user hasn't saved anything yet, ensureMessagingConfig
  // auto-derives from Company Profile + Products and persists the result,
  // so subsequent reads (and the Studio / Copilot generators) see the
  // same values.
  fastify.get('/config', async (request) => {
    const config = await ensureMessagingConfig(request.tenantId);
    return { data: config };
  });

  // PUT /api/studio/config — merge updates into messaging_config
  fastify.put('/config', async (request) => {
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const merged = await withTenant(request.tenantId, async (tx) => {
      const [existing] = await tx
        .select({ messagingConfig: tenants.messagingConfig })
        .from(tenants)
        .where(eq(tenants.id, request.tenantId))
        .limit(1);
      const current: MessagingConfig = (existing?.messagingConfig ?? {}) as MessagingConfig;
      const next: MessagingConfig = { ...current, ...parsed.data };
      await tx
        .update(tenants)
        .set({ messagingConfig: next, updatedAt: new Date() })
        .where(eq(tenants.id, request.tenantId));
      return next;
    });

    return { data: merged };
  });
}
