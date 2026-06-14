import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import {
  prospectActions,
  contacts,
  companies,
} from '../db/schema/index.js';
import type { ProspectActionPriority, ProspectActionStatus } from '../db/schema/index.js';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { getQueue } from '../queues/queues.js';
import { recordTouch } from '../services/prospect-stage.service.js';
import { onSequenceTouchCompleted, ENGINE_REASON_PREFIX } from '../services/followup-engine.service.js';
import { logEvent } from '../services/timeline.service.js';
import {
  checkAndIncrementQueueRefresh,
  getQueueRefreshStatus,
} from '../services/queue-refresh-rate-limit.service.js';
import { retargetAction } from '../services/triage.service.js';
import logger from '../utils/logger.js';

/**
 * Sales Operations Stage 4 — daily queue HTTP surface.
 *
 * GET  /api/queue?date=today        → pending actions, grouped by priority.
 * POST /api/queue/refresh           → kick off triage worker on-demand.
 * POST /api/prospect-actions/:id/complete   → mark completed.
 * POST /api/prospect-actions/:id/skip       → mark skipped with reason.
 * POST /api/prospect-actions/:id/edit-draft → update draft body/subject.
 * POST /api/prospect-actions/:id/execute    → channel-aware execute.
 */

const SKIP_REASONS = ['not_right_time', 'different_angle_needed', 'bad_fit', 'other'] as const;
const skipSchema = z.object({
  reason: z.enum(SKIP_REASONS),
  notes: z.string().max(2000).optional(),
});
const completeSchema = z.object({
  sentAt: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
  channelData: z.record(z.unknown()).optional(),
});
const editDraftSchema = z.object({
  subject: z.string().max(500).optional(),
  body: z.string().max(20000),
});

const PRIORITY_BUCKETS: ProspectActionPriority[] = ['P0', 'P1', 'P2', 'P3'];

export default async function queueRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/queue — pending actions for the current user, grouped by priority.
  // Joins each action's company (the unit of identity post-0035) and its
  // recommended contact (nullable for Rule M research actions). Optional
  // ?masterAgentId=<uuid> filters to actions for companies owned by that
  // agent (companies.master_agent_id); unowned companies never appear in
  // a per-agent queue.
  const queryQueueSchema = z.object({
    userId: z.string().uuid().optional(),
    masterAgentId: z.string().uuid().optional(),
  });
  fastify.get<{ Querystring: { userId?: string; masterAgentId?: string } }>('/', async (request) => {
    const parsed = queryQueueSchema.safeParse(request.query);
    if (!parsed.success) throw new ValidationError(parsed.error.message);
    const userId = parsed.data.userId ?? request.userId;
    if (!userId) throw new ValidationError('userId required');
    const masterAgentId = parsed.data.masterAgentId;

    const rows = await withTenant(request.tenantId, async (tx) => {
      const baseConditions = [
        eq(prospectActions.tenantId, request.tenantId),
        eq(prospectActions.userId, userId),
        inArray(prospectActions.status, ['pending', 'in_progress'] as ProspectActionStatus[]),
      ];
      if (masterAgentId) {
        baseConditions.push(eq(companies.masterAgentId, masterAgentId));
      }
      return tx
        .select({
          action: prospectActions,
          company: companies,
          recommendedContact: contacts,
        })
        .from(prospectActions)
        .innerJoin(companies, eq(companies.id, prospectActions.companyId))
        .leftJoin(contacts, eq(contacts.id, prospectActions.contactId))
        .where(and(...baseConditions))
        .orderBy(prospectActions.priority, prospectActions.scheduledFor);
    });

    const buckets: Record<ProspectActionPriority, typeof rows> = {
      P0: [], P1: [], P2: [], P3: [],
    };
    for (const r of rows) buckets[r.action.priority].push(r);

    const count = rows.length;
    const etaMinutes = Math.max(5, Math.round(count * 1.5));
    const refreshQuota = await getQueueRefreshStatus(request.userId);

    return {
      data: {
        count,
        etaMinutes,
        refreshQuota: {
          remaining: refreshQuota.remaining,
          limit: refreshQuota.limit,
          resetAt: refreshQuota.resetAt,
        },
        buckets: PRIORITY_BUCKETS.map((p) => ({
          priority: p,
          count: buckets[p].length,
          actions: buckets[p],
        })),
      },
    };
  });

  // POST /api/queue/refresh — enqueue a triage job, return immediately.
  // Capped at 3 manual refreshes per user per UTC day; the 06:00 UTC cron
  // is independent and never counts against this quota.
  fastify.post('/refresh', async (request, reply) => {
    const verdict = await checkAndIncrementQueueRefresh(request.userId);
    if (!verdict.allowed) {
      reply.code(429);
      return {
        error: 'QUEUE_REFRESH_RATE_LIMIT',
        message: `Daily manual refresh limit reached (${verdict.limit}/day). Next reset at ${verdict.resetAt}. The automated 06:00 UTC run still happens.`,
        remaining: 0,
        limit: verdict.limit,
        resetAt: verdict.resetAt,
      };
    }

    const triageQueue = getQueue(request.tenantId, 'triage');
    await triageQueue.add(
      'on-demand-triage',
      { tenantId: request.tenantId },
      { removeOnComplete: { count: 100 } },
    );
    reply.code(202);
    return {
      data: {
        queued: true,
        remaining: verdict.remaining,
        limit: verdict.limit,
        resetAt: verdict.resetAt,
      },
    };
  });

  // ─── prospect-actions/:id/<verb> ──────────────────────────────────

  async function loadAction(tenantId: string, actionId: string, userId?: string) {
    const [row] = await withTenant(tenantId, async (tx) => {
      return tx
        .select()
        .from(prospectActions)
        .where(
          and(
            eq(prospectActions.tenantId, tenantId),
            eq(prospectActions.id, actionId),
          ),
        )
        .limit(1);
    });
    if (!row) throw new NotFoundError('ProspectAction', actionId);
    if (userId && row.userId !== userId) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    return row;
  }

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/actions/:id/complete',
    async (request) => {
      const parsed = completeSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const action = await loadAction(request.tenantId, request.params.id, request.userId);

      await withTenant(request.tenantId, async (tx) => {
        await tx
          .update(prospectActions)
          .set({
            status: 'completed',
            userCompletedAt: parsed.data.sentAt ? new Date(parsed.data.sentAt) : new Date(),
            userNotes: parsed.data.notes,
          })
          .where(eq(prospectActions.id, action.id));
      });

      // If this was a touch (outreach channel) and we have a contact, bump
      // stage tracking. Rule M ("research_company_decision_makers") has no
      // contact and no touch to record.
      if (action.contactId && action.channelTarget && action.channelTarget !== 'review' && action.channelTarget !== 'meeting') {
        try {
          const channelMap: Record<string, 'email' | 'linkedin_dm' | 'linkedin_connect' | 'whatsapp' | 'phone'> = {
            email: 'email',
            linkedin_dm: 'linkedin_dm',
            linkedin_connection_request: 'linkedin_connect',
            whatsapp: 'whatsapp',
            phone: 'phone',
          };
          const channel = channelMap[action.channelTarget];
          if (channel) {
            await recordTouch({
              tenantId: request.tenantId,
              contactId: action.contactId,
              channel,
              actorUserId: request.userId,
            });
          }
        } catch (err) {
          logger.warn({ err, actionId: action.id }, 'queue: recordTouch failed on complete');
        }

        // Follow-up engine card sent → advance the sequence (touch++ and
        // schedule the next follow-up, or complete after the final touch).
        if (action.priorityReason?.startsWith(ENGINE_REASON_PREFIX)) {
          try {
            await onSequenceTouchCompleted(request.tenantId, action.contactId);
          } catch (err) {
            logger.warn({ err, actionId: action.id }, 'queue: follow-up sequence advance failed on complete');
          }
        }
      }

      // Audit-log the completion as an action_completed timeline event.
      // Skip the contact-scoped event for contact-less actions (Rule M).
      if (action.contactId) {
        try {
          await logEvent({
            tenantId: request.tenantId,
            contactId: action.contactId,
            type: 'agent_action' as any,
            eventCategory: 'system_action',
            actorType: 'user',
            actorUserId: request.userId,
            title: `Queue action completed: ${action.actionType}`,
            metadata: {
              actionId: action.id,
              actionType: action.actionType,
              priority: action.priority,
              channelData: parsed.data.channelData,
            },
          });
        } catch (err) {
          logger.warn({ err, actionId: action.id }, 'queue: failed to log action_completed event');
        }
      }

      return { data: { ok: true } };
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/actions/:id/skip',
    async (request) => {
      const parsed = skipSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const action = await loadAction(request.tenantId, request.params.id, request.userId);

      await withTenant(request.tenantId, async (tx) => {
        await tx
          .update(prospectActions)
          .set({
            status: 'skipped',
            userSkippedAt: new Date(),
            skipReason: parsed.data.reason,
            userNotes: parsed.data.notes,
          })
          .where(eq(prospectActions.id, action.id));
      });

      return { data: { ok: true } };
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/actions/:id/edit-draft',
    async (request) => {
      const parsed = editDraftSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const action = await loadAction(request.tenantId, request.params.id, request.userId);

      await withTenant(request.tenantId, async (tx) => {
        await tx
          .update(prospectActions)
          .set({
            draftSubject: parsed.data.subject ?? action.draftSubject,
            draftBody: parsed.data.body,
          })
          .where(eq(prospectActions.id, action.id));
      });

      return { data: { ok: true } };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/actions/:id/execute',
    async (request) => {
      const action = await loadAction(request.tenantId, request.params.id, request.userId);
      const channel = action.channelTarget ?? '';

      // For email actions, we mark in_progress + return the body/subject for
      // the dashboard to confirm-and-send via the existing /contacts/:id/send-email
      // route. We don't auto-send server-side from /execute — the user clicks
      // [Send] in the confirm dialog. Stage 5 adds the confidence-gated
      // auto-send path.
      if (channel === 'email') {
        await withTenant(request.tenantId, async (tx) => {
          await tx
            .update(prospectActions)
            .set({ status: 'in_progress', userOpenedAt: new Date() })
            .where(eq(prospectActions.id, action.id));
        });
        return {
          data: {
            kind: 'email_confirm',
            contactId: action.contactId,
            subject: action.draftSubject,
            body: action.draftBody,
          },
        };
      }

      // Research action (Rule M) — no contact, no draft, no channel target.
      // The dashboard surfaces a "Find decision-makers" CTA which routes to
      // the discovery flow.
      if (channel === 'research' || action.actionType === 'research_company_decision_makers') {
        await withTenant(request.tenantId, async (tx) => {
          await tx
            .update(prospectActions)
            .set({ status: 'in_progress', userOpenedAt: new Date() })
            .where(eq(prospectActions.id, action.id));
        });
        return {
          data: {
            kind: 'research',
            companyId: action.companyId,
            actionType: action.actionType,
          },
        };
      }

      // LinkedIn channels: open the target URL in a new tab and copy the
      // draft to clipboard. Stage 5 ships the extension auto-fill path.
      if (channel === 'linkedin_dm' || channel === 'linkedin_connection_request') {
        if (!action.contactId) {
          throw new ValidationError('LinkedIn action has no target contact');
        }
        const targetContactId = action.contactId;
        const [contact] = await withTenant(request.tenantId, async (tx) => {
          return tx.select().from(contacts).where(eq(contacts.id, targetContactId)).limit(1);
        });
        if (!contact?.linkedinUrl) {
          throw new ValidationError('Contact has no LinkedIn URL; cannot execute LinkedIn action');
        }
        await withTenant(request.tenantId, async (tx) => {
          await tx
            .update(prospectActions)
            .set({ status: 'in_progress', userOpenedAt: new Date() })
            .where(eq(prospectActions.id, action.id));
        });
        return {
          data: {
            kind: 'linkedin_clipboard',
            targetUrl: contact.linkedinUrl,
            draftBody: action.draftBody,
            draftSubject: action.draftSubject,
            actionType: action.actionType,
          },
        };
      }

      // meeting_prep / manual_research / mark_dead_review — no execute,
      // just open the contact detail page.
      await withTenant(request.tenantId, async (tx) => {
        await tx
          .update(prospectActions)
          .set({ status: 'in_progress', userOpenedAt: new Date() })
          .where(eq(prospectActions.id, action.id));
      });
      return {
        data: {
          kind: 'manual',
          contactId: action.contactId,
          actionType: action.actionType,
        },
      };
    },
  );

  // POST /api/queue/actions/:id/retarget — switch the recommended target to
  // a different contact at the same company. Regenerates the draft for the
  // new target. Body: { contactId }.
  const retargetSchema = z.object({ contactId: z.string().uuid() });
  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/actions/:id/retarget',
    async (request) => {
      const parsed = retargetSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.message);
      const action = await loadAction(request.tenantId, request.params.id, request.userId);
      try {
        const draft = await retargetAction({
          tenantId: request.tenantId,
          userId: request.userId,
          actionId: action.id,
          newContactId: parsed.data.contactId,
        });
        return { data: { ok: true, draft } };
      } catch (err) {
        if (err instanceof Error && err.message.includes('not at this action')) {
          throw new ValidationError(err.message);
        }
        throw err;
      }
    },
  );
}
