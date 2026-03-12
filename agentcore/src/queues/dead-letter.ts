import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { queueRedis, pubRedis } from './setup.js';
import { getQueueName } from './queues.js';
import { withTenant } from '../config/database.js';
import { agentTasks } from '../db/schema/index.js';
import logger from '../utils/logger.js';

/**
 * Dead letter queue worker.
 * Handles jobs that have exhausted all retries.
 * Updates task status and emits WebSocket notification.
 */
export function createDeadLetterWorker(tenantId: string): Worker {
  const queueName = getQueueName(tenantId, 'dead-letter');

  const worker = new Worker(
    queueName,
    async (job: Job) => {
      const data = job.data as Record<string, unknown>;
      const jobTenantId = (data.tenantId as string) ?? tenantId;
      const originalAgentType = data.agentType as string | undefined;
      const failedReason = data.failedReason as string | undefined;
      const originalJobId = data.originalJobId as string | undefined;

      logger.error(
        {
          deadLetterJobId: job.id,
          tenantId: jobTenantId,
          originalAgentType,
          failedReason,
          originalJobId,
          data,
        },
        'Dead letter: job permanently failed',
      );

      // Update agent_tasks with failed status
      if (jobTenantId && originalJobId) {
        try {
          await withTenant(jobTenantId, async (tx) => {
            await tx.update(agentTasks)
              .set({
                status: 'failed',
                error: `Dead letter: ${failedReason ?? 'unknown'}`,
                completedAt: new Date(),
              })
              .where(eq(agentTasks.id, originalJobId));
          });
        } catch (err) {
          logger.warn({ err, originalJobId }, 'Failed to update task record from dead letter');
        }
      }

      // Emit WebSocket notification
      try {
        await pubRedis.publish(
          `agent-events:${jobTenantId}`,
          JSON.stringify({
            event: 'task:dead_letter',
            data: { agentType: originalAgentType, failedReason },
            timestamp: new Date().toISOString(),
          }),
        );
      } catch { /* non-critical */ }

      return { recorded: true };
    },
    {
      connection: queueRedis as any,
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
