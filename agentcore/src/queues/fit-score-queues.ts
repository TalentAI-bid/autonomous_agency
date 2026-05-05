import { Queue } from 'bullmq';
import { queueRedis } from './setup.js';

// Global (cross-tenant) fit-score queue — one queue across the whole worker
// process. Each job carries its own tenantId so the worker can withTenant
// the work. Pattern mirrors the followup-scheduler / followup-send queues.

export const FIT_SCORE_QUEUE_NAME = 'fit-score';

let q: Queue | undefined;

export function getFitScoreQueue(): Queue {
  if (!q) {
    q = new Queue(FIT_SCORE_QUEUE_NAME, {
      connection: queueRedis as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return q;
}

export interface FitScoreJobData {
  companyId: string;
  tenantId: string;
  reason: 'info_arrived' | 'team_arrived' | 'manual_rescore' | 'initial';
}

/**
 * Enqueue a fit-score job. The jobId pattern guarantees:
 *   - duplicate enqueues for the same (companyId, reason) within a tick are
 *     a no-op (BullMQ deduplicates by jobId)
 *   - manual_rescore always gets a unique id (timestamp suffix) so users can
 *     re-trigger as often as they like
 */
export async function enqueueFitScore(data: FitScoreJobData): Promise<void> {
  const queue = getFitScoreQueue();
  const jobId =
    data.reason === 'manual_rescore'
      ? `fit-score:${data.companyId}:manual:${Date.now()}`
      : `fit-score:${data.companyId}:${data.reason}`;
  await queue.add('score', data, { jobId });
}
