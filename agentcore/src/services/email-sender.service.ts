import { eq, and, inArray } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { emailQueue, emailsSent, emailAccounts } from '../db/schema/index.js';
import type { EmailQueueItem, EmailAccount } from '../db/schema/index.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { selectEmailAccount, incrementQuota, popBatchQueue } from '../tools/email-queue.tool.js';
import { logActivity } from './crm-activity.service.js';
import { pubRedis } from '../queues/setup.js';
import { emailIntelligenceEngine } from '../tools/email-intelligence.js';
import logger from '../utils/logger.js';

const BATCH_SIZE = 10;

/**
 * Process a batch of queued emails for a tenant.
 * Called by the email-send BullMQ worker on a repeatable schedule.
 */
export async function processEmailBatch(tenantId: string): Promise<{ sent: number; failed: number }> {
  // 1. Pop up to BATCH_SIZE items from Redis queue
  const queuedIds = await popBatchQueue(tenantId, BATCH_SIZE);
  if (queuedIds.length === 0) return { sent: 0, failed: 0 };

  // 2. Load queue items from DB
  const items = await withTenant(tenantId, async (tx) => {
    return tx.select().from(emailQueue)
      .where(and(eq(emailQueue.tenantId, tenantId), inArray(emailQueue.id, queuedIds)));
  });

  let sent = 0;
  let failed = 0;

  for (const item of items) {
    // Skip if already processed or cancelled
    if (item.status !== 'queued') continue;

    // Check if scheduled for later
    if (item.scheduledAt && new Date(item.scheduledAt) > new Date()) {
      // Re-push to queue for later
      const { Redis } = await import('ioredis');
      const { createRedisConnection } = await import('../queues/setup.js');
      const redis = createRedisConnection();
      await redis.rpush(`tenant:${tenantId}:email-batch-queue`, item.id);
      await redis.quit();
      continue;
    }

    try {
      await sendSingleEmail(tenantId, item);
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await handleSendFailure(tenantId, item, message);
      failed++;
    }
  }

  if (sent > 0 || failed > 0) {
    logger.info({ tenantId, sent, failed, total: items.length }, 'Email batch processed');
  }
  return { sent, failed };
}

async function sendSingleEmail(tenantId: string, item: EmailQueueItem): Promise<void> {
  // Mark as sending
  await withTenant(tenantId, async (tx) => {
    await tx.update(emailQueue)
      .set({ status: 'sending', attempts: item.attempts + 1 })
      .where(eq(emailQueue.id, item.id));
  });

  // Select email account (or use env fallback)
  let account: EmailAccount | null = null;
  if (item.emailAccountId) {
    const [acc] = await withTenant(tenantId, async (tx) => {
      return tx.select().from(emailAccounts).where(eq(emailAccounts.id, item.emailAccountId!)).limit(1);
    });
    account = acc ?? null;
  }
  if (!account) {
    account = await selectEmailAccount(tenantId);
  }

  // Send via SMTP
  const result = await sendEmail({
    tenantId,
    from: account?.fromEmail ?? item.fromEmail,
    to: item.toEmail,
    subject: item.subject,
    html: item.body,
    text: item.textBody ?? undefined,
    trackingId: item.trackingId ?? undefined,
    emailAccount: account ?? undefined,
  });

  // Mark as sent
  await withTenant(tenantId, async (tx) => {
    await tx.update(emailQueue)
      .set({ status: 'sent', sentAt: new Date(), emailAccountId: account?.id })
      .where(eq(emailQueue.id, item.id));

    // Insert emailsSent record
    await tx.insert(emailsSent).values({
      campaignContactId: item.campaignContactId,
      stepId: item.stepId,
      fromEmail: account?.fromEmail ?? item.fromEmail,
      toEmail: item.toEmail,
      subject: item.subject,
      body: item.body,
      sentAt: new Date(),
      messageId: result.messageId,
      trackingId: item.trackingId ?? undefined,
    });
  });

  // Record delivery signal for email intelligence
  try {
    const domain = item.toEmail.split('@')[1];
    if (domain) {
      await emailIntelligenceEngine.recordDeliverySignal(item.toEmail, domain, null, true);
    }
  } catch (err) {
    logger.debug({ err, itemId: item.id }, 'Failed to record delivery signal');
  }

  // Increment quota counter
  if (account) {
    await incrementQuota(tenantId, account.id);
  }

  // Log CRM activity
  if (item.contactId) {
    try {
      await logActivity({
        tenantId,
        contactId: item.contactId,
        masterAgentId: item.masterAgentId || undefined,
        type: 'email_sent',
        title: `Email sent: ${item.subject}`,
        metadata: {
          toEmail: item.toEmail,
          fromEmail: account?.fromEmail ?? item.fromEmail,
          messageId: result.messageId,
          queueItemId: item.id,
        },
      });
    } catch (err) {
      logger.warn({ err, itemId: item.id }, 'Failed to log CRM activity for email send');
    }
  }

  // Emit real-time event for dashboard updates
  try {
    await pubRedis.publish(
      `agent-events:${tenantId}`,
      JSON.stringify({
        event: 'email:sent',
        data: { emailId: item.id, toEmail: item.toEmail, subject: item.subject, masterAgentId: item.masterAgentId },
        agentType: 'email-send',
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ err, itemId: item.id }, 'Failed to emit email:sent event');
  }

  // Dispatch to mailbox agent for threading + CRM
  try {
    const { dispatchJob } = await import('./queue.service.js');
    await dispatchJob(tenantId, 'mailbox', {
      action: 'thread_email',
      emailId: item.id,
      type: 'outbound',
      masterAgentId: item.masterAgentId,
    });
  } catch (err) {
    logger.warn({ err, itemId: item.id }, 'Failed to dispatch mailbox agent for outbound email');
  }
}

async function handleSendFailure(tenantId: string, item: EmailQueueItem, error: string): Promise<void> {
  const newAttempts = item.attempts + 1;

  if (newAttempts < item.maxAttempts) {
    // Retry: reset to queued and re-push to Redis
    await withTenant(tenantId, async (tx) => {
      await tx.update(emailQueue)
        .set({ status: 'queued', attempts: newAttempts, lastError: error })
        .where(eq(emailQueue.id, item.id));
    });
    const { createRedisConnection } = await import('../queues/setup.js');
    const redis = createRedisConnection();
    await redis.rpush(`tenant:${tenantId}:email-batch-queue`, item.id);
    await redis.quit();
    logger.warn({ tenantId, itemId: item.id, attempt: newAttempts, error }, 'Email send failed, will retry');
  } else {
    // Exhausted retries
    await withTenant(tenantId, async (tx) => {
      await tx.update(emailQueue)
        .set({ status: 'failed', attempts: newAttempts, lastError: error })
        .where(eq(emailQueue.id, item.id));
    });
    logger.error({ tenantId, itemId: item.id, error }, 'Email send permanently failed');
  }
}
