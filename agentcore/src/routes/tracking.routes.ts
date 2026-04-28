import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { db } from '../config/database.js';
import { emailsSent, contacts, campaignContacts } from '../db/schema/index.js';
import { logActivity } from '../services/crm-activity.service.js';
import logger from '../utils/logger.js';

// 1x1 transparent GIF (43 bytes)
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export default async function trackingRoutes(fastify: FastifyInstance) {
  // GET /track/open/:trackingId — No auth required (email clients hit this)
  fastify.get('/open/:trackingId', async (request, reply) => {
    const { trackingId } = request.params as { trackingId: string };

    // Fire-and-forget the DB update — don't block the pixel response
    setImmediate(async () => {
      try {
        // Only set openedAt if currently null (first-open tracking)
        await db.update(emailsSent)
          .set({ openedAt: new Date() })
          .where(
            and(
              eq(emailsSent.trackingId, trackingId),
              isNull(emailsSent.openedAt),
            ),
          );
      } catch (err) {
        logger.warn({ err, trackingId }, 'Failed to record email open');
      }
    });

    return reply
      .header('Content-Type', 'image/gif')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(TRANSPARENT_GIF);
  });

  // GET/POST /track/unsubscribe/:trackingId — Single-click unsubscribe.
  // Mailbox providers' "Unsubscribe" buttons follow the List-Unsubscribe-Post
  // header (POST), but a recipient clicking the inline unsubscribe link in
  // the email body sends a GET. We accept both. No auth required.
  async function handleUnsubscribe(request: any, reply: any) {
    const { trackingId } = request.params as { trackingId: string };

    try {
      // Find the contact via emails_sent (the auto-outreach pipeline keys
      // tracking pixel + unsubscribe by trackingId). Manual 1:1 sends from
      // /api/contacts/:id/send-email don't include an unsubscribe link, so
      // they never reach this endpoint.
      const [sentRow] = await db
        .select({
          campaignContactId: emailsSent.campaignContactId,
        })
        .from(emailsSent)
        .where(eq(emailsSent.trackingId, trackingId))
        .limit(1);

      let tenantId: string | null = null;
      let contactId: string | null = null;
      if (sentRow?.campaignContactId) {
        const [cc] = await db.select({ contactId: campaignContacts.contactId })
          .from(campaignContacts)
          .where(eq(campaignContacts.id, sentRow.campaignContactId))
          .limit(1);
        if (cc) {
          contactId = cc.contactId;
          const [c] = await db.select({ tenantId: contacts.tenantId })
            .from(contacts)
            .where(eq(contacts.id, cc.contactId))
            .limit(1);
          if (c) tenantId = c.tenantId;
        }
      }

      if (tenantId && contactId) {

        // Stash on contact (rawData) so the auto-pipeline can skip them.
        const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
        const existingRaw = (contact?.rawData ?? {}) as Record<string, unknown>;
        await db.update(contacts)
          .set({
            rawData: {
              ...existingRaw,
              unsubscribed: true,
              unsubscribedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(contacts.id, contactId));

        // Mark all active campaign memberships as unsubscribed so future steps don't fire.
        await db.update(campaignContacts)
          .set({ status: 'unsubscribed', lastActionAt: new Date() })
          .where(eq(campaignContacts.contactId, contactId));

        await logActivity({
          tenantId,
          contactId,
          type: 'status_change',
          title: 'Recipient unsubscribed',
          description: 'Clicked the unsubscribe link / used webmail unsubscribe.',
          metadata: { trackingId, source: 'list_unsubscribe' },
        });

        logger.info({ tenantId, contactId, trackingId }, 'Contact unsubscribed via tracking link');
      } else {
        logger.warn({ trackingId }, 'Unsubscribe: no outreach_emails row for trackingId');
      }
    } catch (err) {
      logger.warn({ err, trackingId }, 'Failed to record unsubscribe');
    }

    if (request.method === 'POST') {
      // List-Unsubscribe-Post: the receiving server expects an empty 200.
      return reply.code(200).send();
    }

    // GET — show a friendly confirmation page so the user knows it worked.
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(`<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#222}h1{font-size:18px;margin:0 0 8px}p{font-size:14px;line-height:1.6;color:#555}</style>
</head><body><h1>You've been unsubscribed.</h1><p>You will not receive any more emails from us. If this was a mistake, just reply to one of our previous messages.</p></body></html>`);
  }

  fastify.get('/unsubscribe/:trackingId', handleUnsubscribe);
  fastify.post('/unsubscribe/:trackingId', handleUnsubscribe);
}
