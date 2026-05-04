import { Worker, type Job } from 'bullmq';
import { eq, and, lte, isNotNull, inArray } from 'drizzle-orm';
import { db, withTenant } from '../config/database.js';
import { campaignContacts, tenants } from '../db/schema/index.js';
import { createRedisConnection } from '../queues/setup.js';
import {
  FOLLOWUP_SCHEDULER_QUEUE_NAME,
  getFollowupSchedulerQueue,
  getFollowupSendQueue,
} from '../queues/followup-queues.js';
import logger from '../utils/logger.js';

const SCAN_LIMIT_PER_TENANT = 500;
const SCHEDULER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let cachedTenants: { ids: string[]; cachedAt: number } | null = null;
const TENANT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getTenantIds(): Promise<string[]> {
  if (cachedTenants && Date.now() - cachedTenants.cachedAt < TENANT_CACHE_TTL_MS) {
    return cachedTenants.ids;
  }
  const rows = await db.select({ id: tenants.id }).from(tenants);
  cachedTenants = { ids: rows.map((r) => r.id), cachedAt: Date.now() };
  return cachedTenants.ids;
}

/**
 * One scheduler tick. Scans every tenant for campaign_contacts whose
 * nextScheduledAt is in the past and whose status is one of the active
 * sequence states, then enqueues a follow-up send job per row.
 *
 * The send-queue jobId pattern `followup-send:<ccId>:<targetTouch>` makes
 * duplicate enqueues a no-op within the same tick, and lets the manual
 * /stop endpoint cancel a pending job by id.
 */
export async function scanAndDispatchFollowups(): Promise<{ tenantsScanned: number; dispatched: number }> {
  const tenantIds = await getTenantIds();
  const sendQueue = getFollowupSendQueue();
  let dispatched = 0;
  const now = new Date();

  for (const tenantId of tenantIds) {
    try {
      const due = await withTenant(tenantId, async (tx) => {
        return tx.select().from(campaignContacts)
          .where(and(
            inArray(campaignContacts.status, ['in_sequence', 'active', 'pending'] as const),
            isNotNull(campaignContacts.nextScheduledAt),
            lte(campaignContacts.nextScheduledAt, now),
          ))
          .limit(SCAN_LIMIT_PER_TENANT);
      });

      for (const cc of due) {
        const targetTouch = cc.currentStep + 1;
        try {
          await sendQueue.add(
            'send',
            { campaignContactId: cc.id, tenantId },
            {
              jobId: `followup-send:${cc.id}:${targetTouch}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 60_000 },
            },
          );
          dispatched++;
        } catch (err) {
          // Most likely cause: jobId collision (same job already queued from
          // the previous tick). Treat as benign — the existing job will run.
          logger.debug(
            { err: err instanceof Error ? err.message : String(err), ccId: cc.id, targetTouch },
            'followup-scheduler: enqueue skipped (likely duplicate jobId)',
          );
        }
      }

      if (due.length > 0) {
        logger.info({ tenantId, due: due.length }, 'followup-scheduler: tenant scan');
      }
    } catch (err) {
      // Failure isolation per spec: one tenant's failure must never block
      // the others.
      logger.warn({ err, tenantId }, 'followup-scheduler: tenant scan failed (non-fatal, continuing)');
    }
  }

  if (dispatched > 0) {
    logger.info({ tenantsScanned: tenantIds.length, dispatched }, 'followup-scheduler: tick complete');
  }
  return { tenantsScanned: tenantIds.length, dispatched };
}

let worker: Worker | undefined;

export function startFollowupSchedulerWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    FOLLOWUP_SCHEDULER_QUEUE_NAME,
    async (_job: Job) => scanAndDispatchFollowups(),
    {
      connection: createRedisConnection() as any,
      concurrency: 1,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err }, 'followup-scheduler worker error');
  });

  logger.info('followup-scheduler worker started');
  return worker;
}

export async function stopFollowupSchedulerWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
}

/**
 * Register the repeatable scheduler tick. Idempotent — drops the prior
 * repeatable job (matched by jobId) before adding a fresh one so a deploy
 * cleanly re-pins the schedule.
 */
export async function ensureFollowupSchedulerRepeatable(): Promise<void> {
  const queue = getFollowupSchedulerQueue();
  const existing = await queue.getRepeatableJobs();
  for (const j of existing) {
    if (j.id === 'followup-scheduler-tick') {
      await queue.removeRepeatableByKey(j.key);
    }
  }
  await queue.add('tick', {}, {
    repeat: { every: SCHEDULER_INTERVAL_MS },
    jobId: 'followup-scheduler-tick',
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 200 },
  });
  logger.info({ everyMs: SCHEDULER_INTERVAL_MS }, 'followup-scheduler: repeatable tick registered');
}
