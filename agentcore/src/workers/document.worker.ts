import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { DocumentAgent } from '../agents/document.agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import logger from '../utils/logger.js';

export function createDocumentWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'document'),
    async (job: Job) => {
      const task = await createTaskRecord(job, 'document');
      const agent = new DocumentAgent({
        tenantId,
        masterAgentId: (job.data as Record<string, unknown>).masterAgentId as string ?? '',
        agentType: 'document',
      });
      try {
        const result = await agent.execute(job.data as Record<string, unknown>);
        await completeTaskRecord(tenantId, task.id, result);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await failTaskRecord(tenantId, task.id, message);
        logger.error({ err, tenantId, jobId: job.id }, 'Document worker failed');
        throw err;
      } finally {
        await agent.close();
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS.document.concurrency,
    },
  );
}
