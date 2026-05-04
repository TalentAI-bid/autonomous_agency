import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, asc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import {
  campaignContacts,
  campaignSteps,
  campaigns,
  contacts,
  emailsSent,
  agentActivityLog,
} from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { getFollowupSendQueue } from '../queues/followup-queues.js';
import logger from '../utils/logger.js';

const stopBodySchema = z.object({ reason: z.string().max(255).optional() });

/**
 * Cancel any pending BullMQ send jobs for this campaign_contact. Searches
 * delayed + waiting + prioritized states for jobs whose jobId starts with
 * `followup-send:<ccId>:` and removes them.
 */
async function cancelPendingFollowupJobs(campaignContactId: string): Promise<number> {
  const queue = getFollowupSendQueue();
  let cancelled = 0;
  for (const state of ['delayed', 'waiting', 'prioritized', 'paused'] as const) {
    try {
      const jobs = await queue.getJobs([state], 0, 5000);
      for (const job of jobs) {
        if (job.id && job.id.startsWith(`followup-send:${campaignContactId}:`)) {
          try {
            await job.remove();
            cancelled++;
          } catch (err) {
            logger.debug({ err, jobId: job.id }, 'cancelPendingFollowupJobs: remove failed');
          }
        }
      }
    } catch (err) {
      logger.debug({ err, state }, 'cancelPendingFollowupJobs: getJobs failed');
    }
  }
  return cancelled;
}

export default async function followupRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // ─── POST /api/followup/contacts/:contactId/stop ──────────────────────
  fastify.post<{ Params: { contactId: string } }>('/contacts/:contactId/stop', async (request) => {
    const { contactId } = request.params;
    const parsed = stopBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const reason = parsed.data.reason ?? 'manual';

    const stoppedAt = new Date();
    const stoppedRows = await withTenant(request.tenantId, async (tx) => {
      const rows = await tx.select({ id: campaignContacts.id })
        .from(campaignContacts)
        .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
        .where(and(
          eq(campaignContacts.contactId, contactId),
          eq(campaigns.tenantId, request.tenantId),
          eq(campaignContacts.status, 'in_sequence'),
        ));
      if (rows.length === 0) return [];
      // Loop because Drizzle's `inArray` import isn't worth the noise for tiny lists.
      for (const r of rows) {
        await tx.update(campaignContacts).set({
          status: 'stopped_manual',
          stoppedReason: reason,
          stoppedAt,
          nextScheduledAt: null,
        }).where(eq(campaignContacts.id, r.id));
      }
      return rows;
    });

    let cancelled = 0;
    for (const row of stoppedRows) {
      cancelled += await cancelPendingFollowupJobs(row.id);
    }

    try {
      await withTenant(request.tenantId, async (tx) => {
        await tx.insert(agentActivityLog).values({
          tenantId: request.tenantId,
          masterAgentId: null,
          agentType: 'outreach',
          action: 'followup_stopped',
          status: 'completed',
          details: { contactId, reason, stopped: stoppedRows.length, jobsCancelled: cancelled },
        });
      });
    } catch (err) {
      logger.debug({ err, contactId }, 'followup stop: activity-log insert failed (non-fatal)');
    }

    return { data: { stopped: stoppedRows.length, cancelled, contactId } };
  });

  // ─── POST /api/followup/contacts/:contactId/unsubscribe ───────────────
  fastify.post<{ Params: { contactId: string } }>('/contacts/:contactId/unsubscribe', async (request) => {
    const { contactId } = request.params;
    const parsed = stopBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const reason = parsed.data.reason ?? 'unsubscribed';

    const stoppedAt = new Date();
    const stoppedRows = await withTenant(request.tenantId, async (tx) => {
      const [contact] = await tx.select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
      if (!contact) return null;

      await tx.update(contacts).set({ unsubscribed: true, updatedAt: new Date() }).where(eq(contacts.id, contactId));

      const rows = await tx.select({ id: campaignContacts.id })
        .from(campaignContacts)
        .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
        .where(and(
          eq(campaignContacts.contactId, contactId),
          eq(campaigns.tenantId, request.tenantId),
          eq(campaignContacts.status, 'in_sequence'),
        ));

      for (const r of rows) {
        await tx.update(campaignContacts).set({
          status: 'stopped_manual',
          stoppedReason: reason,
          stoppedAt,
          nextScheduledAt: null,
        }).where(eq(campaignContacts.id, r.id));
      }
      return rows;
    });

    if (stoppedRows === null) throw new NotFoundError('Contact', contactId);

    let cancelled = 0;
    for (const row of stoppedRows) {
      cancelled += await cancelPendingFollowupJobs(row.id);
    }

    try {
      await withTenant(request.tenantId, async (tx) => {
        await tx.insert(agentActivityLog).values({
          tenantId: request.tenantId,
          masterAgentId: null,
          agentType: 'outreach',
          action: 'contact_unsubscribed',
          status: 'completed',
          details: { contactId, reason, sequencesStopped: stoppedRows.length, jobsCancelled: cancelled },
        });
      });
    } catch (err) {
      logger.debug({ err, contactId }, 'unsubscribe: activity-log insert failed (non-fatal)');
    }

    return { data: { stopped: stoppedRows.length, cancelled, contactId, unsubscribed: true } };
  });

  // ─── GET /api/followup/contacts/:contactId/sequence ───────────────────
  fastify.get<{ Params: { contactId: string } }>('/contacts/:contactId/sequence', async (request) => {
    const { contactId } = request.params;
    const data = await withTenant(request.tenantId, async (tx) => {
      const [contact] = await tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
      if (!contact) return null;

      const ccRows = await tx.select()
        .from(campaignContacts)
        .innerJoin(campaigns, eq(campaigns.id, campaignContacts.campaignId))
        .where(and(
          eq(campaignContacts.contactId, contactId),
          eq(campaigns.tenantId, request.tenantId),
        ));

      const result = await Promise.all(ccRows.map(async ({ campaign_contacts: cc, campaigns: c }) => {
        const steps = await tx.select().from(campaignSteps)
          .where(eq(campaignSteps.campaignId, cc.campaignId))
          .orderBy(asc(campaignSteps.stepNumber));
        const sends = await tx.select().from(emailsSent)
          .where(eq(emailsSent.campaignContactId, cc.id))
          .orderBy(asc(emailsSent.sentAt));
        return { campaign: c, campaignContact: cc, steps, sends };
      }));

      return { contact, sequences: result };
    });
    if (!data) throw new NotFoundError('Contact', contactId);
    return { data };
  });

  // ─── GET /api/followup/agents/:masterAgentId/stats ────────────────────
  fastify.get<{ Params: { masterAgentId: string } }>('/agents/:masterAgentId/stats', async (request) => {
    const { masterAgentId } = request.params;
    const stats = await withTenant(request.tenantId, async (tx) => {
      const totals = await tx.execute<{
        total: string;
        in_sequence: string;
        completed: string;
        stopped_manual: string;
        failed: string;
      }>(sql`
        SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE ${campaignContacts.status} = 'in_sequence')::text AS in_sequence,
          COUNT(*) FILTER (WHERE ${campaignContacts.status} = 'completed')::text AS completed,
          COUNT(*) FILTER (WHERE ${campaignContacts.status} = 'stopped_manual')::text AS stopped_manual,
          COUNT(*) FILTER (WHERE ${campaignContacts.status} = 'failed')::text AS failed
        FROM ${campaignContacts}
        INNER JOIN ${campaigns} ON ${campaigns.id} = ${campaignContacts.campaignId}
        WHERE ${campaigns.tenantId} = ${request.tenantId}
          AND ${campaigns.masterAgentId} = ${masterAgentId}
      `);

      const byTouch = await tx.execute<{ current_step: number; n: string }>(sql`
        SELECT ${campaignContacts.currentStep} AS current_step, COUNT(*)::text AS n
        FROM ${campaignContacts}
        INNER JOIN ${campaigns} ON ${campaigns.id} = ${campaignContacts.campaignId}
        WHERE ${campaigns.tenantId} = ${request.tenantId}
          AND ${campaigns.masterAgentId} = ${masterAgentId}
        GROUP BY 1
        ORDER BY 1
      `);

      return {
        totals: totals.rows?.[0] ?? null,
        byTouch: byTouch.rows ?? [],
      };
    });

    const t = stats.totals ?? { total: '0', in_sequence: '0', completed: '0', stopped_manual: '0', failed: '0' };
    const byTouchNumber: Record<string, number> = {};
    for (const r of stats.byTouch) {
      byTouchNumber[String(r.current_step)] = Number(r.n ?? 0);
    }
    return {
      data: {
        totalEnrolled: Number(t.total ?? 0),
        inSequence: Number(t.in_sequence ?? 0),
        completed: Number(t.completed ?? 0),
        stoppedManual: Number(t.stopped_manual ?? 0),
        failed: Number(t.failed ?? 0),
        byTouchNumber,
      },
    };
  });
}
