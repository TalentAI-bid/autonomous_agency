import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { ActionAgent } from '../agents/action.agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import logger from '../utils/logger.js';

export function createActionWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'action'),
    async (job: Job) => {
      let task: { id: string; tenantId: string } | undefined;
      try {
        task = await createTaskRecord(job, 'action');
      } catch (taskErr) {
        logger.warn({ err: taskErr, tenantId, jobId: job.id }, 'Failed to create task record for action — continuing without it');
      }

      const agent = new ActionAgent({
        tenantId,
        masterAgentId: (job.data as Record<string, unknown>).masterAgentId as string || '',
        agentType: 'action',
      });
      try {
        const result = await agent.execute(job.data as Record<string, unknown>);
        if (task) await completeTaskRecord(tenantId, task.id, result);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (task) await failTaskRecord(tenantId, task.id, message);
        logger.error({ err, tenantId, jobId: job.id }, 'Action worker failed');
        throw err;
      } finally {
        await agent.close();
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS.action.concurrency,
    },
  );
}
