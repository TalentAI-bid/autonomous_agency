import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from './setup.js';
import { getQueueName } from './queues.js';
import logger from '../utils/logger.js';

/**
 * Dead letter queue worker.
 * Handles jobs that have exhausted all retries.
 * Logs the failure details for debugging and monitoring.
 */
export function createDeadLetterWorker(tenantId: string): Worker {
  const queueName = getQueueName(tenantId, 'dead-letter');
  const connection = createRedisConnection();

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      logger.error(
        {
          deadLetterJobId: job.id,
          tenantId: (job.data as Record<string, unknown>).tenantId,
          originalAgentType: (job.data as Record<string, unknown>).agentType,
          failedReason: (job.data as Record<string, unknown>).failedReason,
          originalJobId: (job.data as Record<string, unknown>).originalJobId,
          data: job.data,
        },
        'Dead letter: job permanently failed',
      );

      // In Prompt 2, this will also:
      // 1. Update agent_tasks table with status='failed'
      // 2. Send notification via WebSocket
      // 3. Optionally alert via email/webhook

      return { recorded: true };
    },
    {
      connection: connection as any,
      concurrency: 1,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err, tenantId }, 'Dead letter worker error');
  });

  return worker;
}

/**
 * Move a failed job to the dead letter queue for a tenant.
 */
export async function moveToDeadLetter(
  tenantId: string,
  originalJobData: Record<string, unknown>,
  failedReason: string,
): Promise<void> {
  // Import dynamically to avoid circular deps
  const { getQueue } = await import('./queues.js');
  const dlQueue = getQueue(tenantId, 'dead-letter');
  await dlQueue.add('dead-letter-job', {
    ...originalJobData,
    failedReason,
    movedAt: new Date().toISOString(),
  });
}
