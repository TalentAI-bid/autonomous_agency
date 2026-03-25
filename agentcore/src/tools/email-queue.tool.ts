import { eq, and, asc } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createRedisConnection } from '../queues/setup.js';
import { withTenant } from '../config/database.js';
import { emailAccounts, emailQueue } from '../db/schema/index.js';
import type { EmailAccount, NewEmailQueueItem } from '../db/schema/index.js';
import logger from '../utils/logger.js';

const redis: Redis = createRedisConnection();

/** Warmup schedule: days since start -> max emails per day */
const WARMUP_SCHEDULE: Array<{ maxDay: number; limit: number }> = [
  { maxDay: 3, limit: 5 },
  { maxDay: 7, limit: 15 },
  { maxDay: 14, limit: 30 },
  { maxDay: 21, limit: 50 },
  { maxDay: 30, limit: 100 },
];

export function getWarmupLimit(daysSinceStart: number, fullQuota: number): number {
  for (const tier of WARMUP_SCHEDULE) {
    if (daysSinceStart <= tier.maxDay) return tier.limit;
  }
  return fullQuota;
}

export interface EnqueueEmailOpts {
  tenantId: string;
  contactId?: string;
  campaignContactId?: string;
  emailAccountId?: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  textBody?: string;
  trackingId?: string;
  scheduledAt?: Date;
  masterAgentId?: string;
  campaignId?: string;
  stepId?: string;
}

/**
 * Enqueue an email for batch sending.
 * Inserts into DB (durable) and pushes to Redis list for fast pickup.
 */
export async function enqueueEmail(opts: EnqueueEmailOpts): Promise<{ queuedId: string }> {
  const item: NewEmailQueueItem = {
    tenantId: opts.tenantId,
    contactId: opts.contactId,
    campaignContactId: opts.campaignContactId,
    emailAccountId: opts.emailAccountId,
    fromEmail: opts.fromEmail,
    toEmail: opts.toEmail,
    subject: opts.subject,
    body: opts.body,
    textBody: opts.textBody,
    trackingId: opts.trackingId,
    scheduledAt: opts.scheduledAt,
    status: 'queued',
    masterAgentId: opts.masterAgentId,
    campaignId: opts.campaignId,
    stepId: opts.stepId,
  };

  const [inserted] = await withTenant(opts.tenantId, async (tx) => {
    return tx.insert(emailQueue).values(item).returning({ id: emailQueue.id });
  });

  // Push to Redis batch queue for fast processing
  const redisKey = `tenant:${opts.tenantId}:email-batch-queue`;
  await redis.rpush(redisKey, inserted!.id);

  logger.info({ tenantId: opts.tenantId, queuedId: inserted!.id, to: opts.toEmail }, 'Email enqueued');
  return { queuedId: inserted!.id };
}

/**
 * Check quota availability for an email account.
 * Returns { daily, hourly } with current counts and limits.
 */
export async function checkQuota(tenantId: string, accountId: string, account: EmailAccount): Promise<{
  dailyUsed: number;
  dailyLimit: number;
  hourlyUsed: number;
  hourlyLimit: number;
  available: boolean;
}> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const hourStr = `${dateStr}-${String(now.getUTCHours()).padStart(2, '0')}`;

  const dailyKey = `tenant:${tenantId}:eq:${accountId}:d:${dateStr}`;
  const hourlyKey = `tenant:${tenantId}:eq:${accountId}:h:${hourStr}`;

  const [dailyUsed, hourlyUsed] = await Promise.all([
    redis.get(dailyKey).then((v) => parseInt(v ?? '0', 10)),
    redis.get(hourlyKey).then((v) => parseInt(v ?? '0', 10)),
  ]);

  // Compute effective daily limit (considering warmup)
  let dailyLimit = account.dailyQuota;
  if (account.isWarmup && account.warmupStartDate) {
    const daysSinceStart = Math.floor((Date.now() - new Date(account.warmupStartDate).getTime()) / 86400000);
    dailyLimit = getWarmupLimit(daysSinceStart, account.dailyQuota);
  }

  const hourlyLimit = account.hourlyQuota;
  const available = dailyUsed < dailyLimit && hourlyUsed < hourlyLimit;

  return { dailyUsed, dailyLimit, hourlyUsed, hourlyLimit, available };
}

/**
 * Increment quota counters after a successful send.
 */
export async function incrementQuota(tenantId: string, accountId: string): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const hourStr = `${dateStr}-${String(now.getUTCHours()).padStart(2, '0')}`;

  const dailyKey = `tenant:${tenantId}:eq:${accountId}:d:${dateStr}`;
  const hourlyKey = `tenant:${tenantId}:eq:${accountId}:h:${hourStr}`;

  const pipeline = redis.pipeline();
  pipeline.incr(dailyKey);
  pipeline.expire(dailyKey, 86400);
  pipeline.incr(hourlyKey);
  pipeline.expire(hourlyKey, 3600);
  await pipeline.exec();
}

/**
 * Select the best email account for sending.
 * Picks highest-priority active account with available quota.
 */
export async function selectEmailAccount(tenantId: string): Promise<EmailAccount | null> {
  const accounts = await withTenant(tenantId, async (tx) => {
    return tx.select().from(emailAccounts)
      .where(and(eq(emailAccounts.tenantId, tenantId), eq(emailAccounts.isActive, true)))
      .orderBy(asc(emailAccounts.priority));
  });

  for (const account of accounts) {
    const quota = await checkQuota(tenantId, account.id, account);
    if (quota.available) {
      return account;
    }
  }

  return null;
}

/**
 * Pop items from the Redis batch queue.
 */
export async function popBatchQueue(tenantId: string, count: number): Promise<string[]> {
  const redisKey = `tenant:${tenantId}:email-batch-queue`;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await redis.lpop(redisKey);
    if (!id) break;
    ids.push(id);
  }
  return ids;
}

/**
 * Flush the email batch queue for a tenant.
 * Clears the Redis list and marks all queued DB records as cancelled.
 * Call this on agent start/restart to prevent stale emails from being sent.
 */
export async function flushEmailQueue(tenantId: string): Promise<number> {
  const redisKey = `tenant:${tenantId}:email-batch-queue`;
  const flushedCount = await redis.llen(redisKey);
  if (flushedCount > 0) {
    await redis.del(redisKey);
    // Mark queued DB records as cancelled so they can't be re-sent
    await withTenant(tenantId, async (tx) => {
      await tx.update(emailQueue)
        .set({ status: 'cancelled', lastError: 'Queue flushed on agent restart' })
        .where(and(eq(emailQueue.tenantId, tenantId), eq(emailQueue.status, 'queued')));
    });
    logger.info({ tenantId, flushedCount }, 'Email batch queue flushed');
  }
  return flushedCount;
}
