import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { runTriageForTenant } from '../services/triage.service.js';
import logger from '../utils/logger.js';

/**
 * BullMQ worker for daily triage. Repeatable job is registered in
 * scheduleAgentJobs() at cron '0 6 * * *' (06:00 UTC). Also fires on
 * demand via POST /api/queue/refresh.
 */
export function createTriageWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'triage'),
    async (job: Job) => {
      const data = job.data as { tenantId: string; cap?: number };
      try {
        const result = await runTriageForTenant({ tenantId: data.tenantId, cap: data.cap });
        logger.info({ tenantId: data.tenantId, ...result }, 'Triage worker complete');
        return result;
      } catch (err) {
        logger.error({ err, tenantId: data.tenantId, jobId: job.id }, 'Triage worker failed');
        throw err;
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS['triage'].concurrency,
    },
  );
}
