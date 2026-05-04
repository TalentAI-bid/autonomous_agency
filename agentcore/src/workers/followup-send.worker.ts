import { Worker, type Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { createRedisConnection } from '../queues/setup.js';
import { FOLLOWUP_SEND_QUEUE_NAME } from '../queues/followup-queues.js';
import { withTenant } from '../config/database.js';
import {
  campaigns,
  campaignContacts,
  campaignSteps,
  contacts,
  emailsSent,
  masterAgents,
  emailAccounts,
  agentActivityLog,
} from '../db/schema/index.js';
import type { EmailAccount } from '../db/schema/index.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { acquireSmtpSlot } from '../services/smtp-rate-limiter.service.js';
import { selectEmailAccount } from '../tools/email-queue.tool.js';
import { generateFollowupContent } from '../services/followup-content.service.js';
import {
  resolveContactTimezone,
  isWithinSendingWindow,
  computeNextSendingSlot,
  resolveSendingWindow,
} from '../services/sending-window.service.js';
import { findNextActiveStep, computeNextScheduledAt } from '../services/followup.service.js';
import logger from '../utils/logger.js';

interface FollowupSendJobData {
  campaignContactId: string;
  tenantId: string;
}

async function logActivity(
  tenantId: string,
  masterAgentId: string | null,
  action: string,
  status: 'started' | 'completed' | 'failed' | 'skipped',
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx.insert(agentActivityLog).values({
        tenantId, masterAgentId, agentType: 'outreach', action, status, details,
      });
    });
  } catch (err) {
    logger.debug({ err, action }, 'followup-send.worker: activity-log insert failed (non-fatal)');
  }
}

/**
 * Process one follow-up send for the given campaign_contact. Reloads state
 * defensively because rows may change between scheduler enqueue and worker
 * pickup (manual stop, prior tick already advanced the counter, etc.).
 *
 * Errors thrown from this function are visible to BullMQ as job failures and
 * trigger the queue's exponential-backoff retry. After the configured max
 * attempts the BullMQ failed-handler marks the contact's sequenceStatus as
 * 'failed'.
 */
export async function processFollowupSend(job: Job<FollowupSendJobData>): Promise<{ ok: boolean; reason?: string }> {
  const { campaignContactId, tenantId } = job.data;

  // ─── 1. Reload state — could have changed since enqueue ───────────────
  const ctx = await withTenant(tenantId, async (tx) => {
    const [cc] = await tx.select().from(campaignContacts)
      .where(eq(campaignContacts.id, campaignContactId)).limit(1);
    if (!cc) return null;
    const [campaign] = await tx.select().from(campaigns)
      .where(eq(campaigns.id, cc.campaignId)).limit(1);
    const [contact] = await tx.select().from(contacts)
      .where(eq(contacts.id, cc.contactId)).limit(1);
    const [agent] = campaign?.masterAgentId
      ? await tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, campaign.masterAgentId), eq(masterAgents.tenantId, tenantId)))
        .limit(1)
      : [undefined];
    return { cc, campaign, contact, agent };
  });

  if (!ctx || !ctx.cc) {
    logger.warn({ campaignContactId }, 'followup-send: cc not found, skipping');
    return { ok: false, reason: 'cc_missing' };
  }
  const { cc, campaign, contact, agent } = ctx;
  if (cc.status !== 'in_sequence' && cc.status !== 'active' && cc.status !== 'pending') {
    logger.info({ campaignContactId, status: cc.status }, 'followup-send: cc no longer in_sequence, skipping');
    return { ok: false, reason: 'not_in_sequence' };
  }
  if (!contact || !contact.email || contact.unsubscribed) {
    logger.info({ campaignContactId, hasEmail: !!contact?.email, unsubscribed: contact?.unsubscribed }, 'followup-send: contact unreachable, marking stopped_manual');
    await withTenant(tenantId, async (tx) => {
      await tx.update(campaignContacts).set({
        status: 'stopped_manual',
        stoppedReason: contact?.unsubscribed ? 'unsubscribed' : 'no_email',
        stoppedAt: new Date(),
        nextScheduledAt: null,
      }).where(eq(campaignContacts.id, cc.id));
    });
    return { ok: false, reason: 'contact_unreachable' };
  }

  // ─── 2. Find the next active step ─────────────────────────────────────
  const targetStep = cc.currentStep + 1;
  const [step] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(campaignSteps)
      .where(and(
        eq(campaignSteps.campaignId, cc.campaignId),
        eq(campaignSteps.stepNumber, targetStep),
        eq(campaignSteps.active, true),
      )).limit(1);
  });

  // No more active steps → mark completed (skipped-inactive case is also
  // handled here: if step exists but is inactive, we just skip ahead by
  // looking for the next active step).
  const stepRow = step ?? await findNextActiveStep(tenantId, cc.campaignId, cc.currentStep);
  if (!stepRow) {
    await withTenant(tenantId, async (tx) => {
      await tx.update(campaignContacts).set({
        status: 'completed',
        nextScheduledAt: null,
      }).where(eq(campaignContacts.id, cc.id));
    });
    logger.info({ campaignContactId }, 'followup-send: no more active steps, marked completed');
    return { ok: true };
  }

  // ─── 3. Sending hours check ───────────────────────────────────────────
  const tz = await resolveContactTimezone(tenantId, contact.id);
  const window = resolveSendingWindow((agent?.config ?? null) as Record<string, unknown> | null);
  if (!isWithinSendingWindow(new Date(), tz, window)) {
    const next = computeNextSendingSlot(new Date(), tz, window);
    await withTenant(tenantId, async (tx) => {
      await tx.update(campaignContacts).set({ nextScheduledAt: next }).where(eq(campaignContacts.id, cc.id));
    });
    logger.info({ campaignContactId, tz, next }, 'followup-send: outside sending window, rescheduled');
    return { ok: false, reason: 'outside_window' };
  }

  // ─── 4. Generate email content ────────────────────────────────────────
  const generated = await generateFollowupContent({
    campaignContactId: cc.id,
    step: { id: 'stepRowId' in stepRow ? (stepRow as { id: string }).id : '', stepNumber: stepRow.stepNumber, stepType: ('stepType' in stepRow ? (stepRow as { stepType: string }).stepType : 'custom') },
    tenantId,
  });

  // ─── 5. Acquire SMTP slot — defer on rate-limit ───────────────────────
  // The rate limiter blocks rather than throws, so we wrap a timeout-based
  // bail-out: if it doesn't return within 30s we punt the cc forward by
  // an hour. PART 10 says: never bypass the rate limit.
  const RATE_LIMIT_BAIL_MS = 30_000;
  let acquired = false;
  try {
    await Promise.race([
      acquireSmtpSlot().then(() => { acquired = true; }),
      new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('rate_limit_timeout')), RATE_LIMIT_BAIL_MS)),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === 'rate_limit_timeout') {
      const deferTo = new Date(Date.now() + 60 * 60 * 1000);
      await withTenant(tenantId, async (tx) => {
        await tx.update(campaignContacts).set({ nextScheduledAt: deferTo }).where(eq(campaignContacts.id, cc.id));
      });
      await logActivity(tenantId, campaign?.masterAgentId ?? null, 'followup_deferred_rate_limit', 'completed', {
        campaignContactId, deferTo, stepNumber: stepRow.stepNumber,
      });
      logger.info({ campaignContactId, deferTo }, 'followup-send: rate-limited, deferred 1h');
      return { ok: false, reason: 'rate_limited' };
    }
    throw err;
  }
  if (!acquired) {
    // Defensive — should be unreachable, but covers the case where the race
    // resolves with a thrown timeout that doesn't match our pattern.
    return { ok: false, reason: 'rate_limit_unknown' };
  }

  // ─── 6. Resolve email account + threading headers ─────────────────────
  let account: EmailAccount | null = null;
  try {
    account = await selectEmailAccount(tenantId);
  } catch {
    account = null;
  }
  const fromEmail = account?.fromEmail ?? null;
  if (!fromEmail) {
    await withTenant(tenantId, async (tx) => {
      await tx.update(campaignContacts).set({
        status: 'failed',
        stoppedReason: 'no_sender_account',
        stoppedAt: new Date(),
        nextScheduledAt: null,
      }).where(eq(campaignContacts.id, cc.id));
    });
    logger.warn({ campaignContactId, tenantId }, 'followup-send: no email account configured, marked failed');
    return { ok: false, reason: 'no_sender_account' };
  }

  // Pull touch-1 message-id and accumulated references from prior emailsSent
  const sentRows = await withTenant(tenantId, async (tx) => {
    return tx.select().from(emailsSent).where(eq(emailsSent.campaignContactId, cc.id));
  });
  const orderedSent = sentRows.sort((a, b) => {
    const aTouch = a.touchNumber ?? 1;
    const bTouch = b.touchNumber ?? 1;
    return aTouch - bTouch;
  });
  const inReplyTo = orderedSent[orderedSent.length - 1]?.messageId ?? undefined;
  const refIds = orderedSent.map((r) => r.messageId).filter((v): v is string => !!v);
  const references = refIds.length ? refIds.join(' ') : undefined;
  // Touch 4 (followup_breakup) may use a fresh subject — skip threading if
  // the LLM produced a "Closing the loop on..." subject that doesn't start
  // with Re:. Otherwise thread under the original.
  const useThreading = stepRow.stepType !== 'followup_breakup' || /^re:\s/i.test(generated.subject);

  // ─── 7. Send via SMTP ─────────────────────────────────────────────────
  let sendResult: { messageId: string };
  try {
    sendResult = await sendEmail({
      tenantId,
      from: fromEmail,
      to: contact.email,
      subject: generated.subject,
      html: generated.body,
      text: generated.body,
      emailAccount: account ?? undefined,
      inReplyTo: useThreading ? inReplyTo : undefined,
      references: useThreading ? references : undefined,
    });
  } catch (err) {
    // Throw to let BullMQ retry. After max attempts the failed-handler in
    // workers.ts marks the cc as 'failed'.
    logger.warn({ err: err instanceof Error ? err.message : String(err), campaignContactId, attempt: job.attemptsMade }, 'followup-send: SMTP send failed');
    throw err;
  }

  // ─── 8. Persist emails_sent + advance state ───────────────────────────
  const now = new Date();
  const stepIdForRow = ('id' in stepRow && typeof (stepRow as { id: string }).id === 'string')
    ? (stepRow as { id: string }).id
    : null;

  await withTenant(tenantId, async (tx) => {
    await tx.insert(emailsSent).values({
      campaignContactId: cc.id,
      stepId: stepIdForRow,
      fromEmail,
      toEmail: contact.email,
      subject: generated.subject,
      body: generated.body,
      sentAt: now,
      messageId: sendResult.messageId,
      touchNumber: stepRow.stepNumber,
      inReplyTo: useThreading ? inReplyTo ?? null : null,
      references: useThreading ? references ?? null : null,
    });
  });

  // Decide what to schedule next.
  const next = await computeNextScheduledAt(
    tenantId,
    cc.campaignId,
    stepRow.stepNumber,
    {
      firstSentAt: orderedSent[0]?.sentAt ?? cc.lastActionAt ?? now,
      lastSentAt: now,
    },
  );

  const newAngles = [...(cc.sequenceState?.anglesUsed ?? []), generated.angleUsed];

  await withTenant(tenantId, async (tx) => {
    await tx.update(campaignContacts).set({
      currentStep: stepRow.stepNumber,
      lastActionAt: now,
      nextScheduledAt: next?.nextScheduledAt ?? null,
      status: next ? 'in_sequence' : 'completed',
      sequenceState: {
        ...(cc.sequenceState ?? {}),
        anglesUsed: newAngles,
      },
    }).where(eq(campaignContacts.id, cc.id));
  });

  await logActivity(tenantId, campaign?.masterAgentId ?? null, 'followup_sent', 'completed', {
    campaignContactId: cc.id,
    touchNumber: stepRow.stepNumber,
    subject: generated.subject,
    angleUsed: generated.angleUsed,
    threaded: useThreading,
    messageId: sendResult.messageId,
  });

  logger.info({ campaignContactId, touchNumber: stepRow.stepNumber, messageId: sendResult.messageId }, 'followup-send: sent');
  return { ok: true };
}

/**
 * Single global worker (not per-tenant). One process handles follow-up sends
 * for every tenant; the per-call withTenant scopes the DB ops correctly.
 */
let worker: Worker | undefined;

export function startFollowupSendWorker(): Worker {
  if (worker) return worker;
  worker = new Worker<FollowupSendJobData>(
    FOLLOWUP_SEND_QUEUE_NAME,
    processFollowupSend,
    {
      connection: createRedisConnection() as any,
      concurrency: 5,
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const attemptsMade = job.attemptsMade;
    const maxAttempts = job.opts.attempts ?? 3;
    if (attemptsMade < maxAttempts) {
      logger.info({ jobId: job.id, attemptsMade, maxAttempts }, 'followup-send: will retry');
      return;
    }
    // Final failure — mark the cc failed so the scheduler stops re-enqueueing.
    const data = job.data;
    if (!data) return;
    try {
      await withTenant(data.tenantId, async (tx) => {
        await tx.update(campaignContacts).set({
          status: 'failed',
          stoppedReason: 'smtp_failure_after_retries',
          stoppedAt: new Date(),
          nextScheduledAt: null,
        }).where(eq(campaignContacts.id, data.campaignContactId));
      });
      await logActivity(data.tenantId, null, 'followup_failed', 'failed', {
        campaignContactId: data.campaignContactId,
        attempts: attemptsMade,
        error: err.message,
      });
    } catch (writeErr) {
      logger.warn({ err: writeErr, jobId: job.id }, 'followup-send: failed to mark cc as failed (non-fatal)');
    }
  });

  worker.on('error', (err) => {
    logger.error({ err }, 'followup-send worker error');
  });

  logger.info('followup-send worker started');
  return worker;
}

export async function stopFollowupSendWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
}
