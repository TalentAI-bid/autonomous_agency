import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { DiscoveryAgent } from '../agents/discovery.agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import logger from '../utils/logger.js';

export function createDiscoveryWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'discovery'),
    async (job: Job) => {
      const task = await createTaskRecord(job, 'discovery');
      const agent = new DiscoveryAgent({
        tenantId,
        masterAgentId: (job.data as Record<string, unknown>).masterAgentId as string ?? '',
        agentType: 'discovery',
      });
      try {
        const result = await agent.execute(job.data as Record<string, unknown>);
        await completeTaskRecord(tenantId, task.id, result);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await failTaskRecord(tenantId, task.id, message);
        logger.error({ err, tenantId, jobId: job.id }, 'Discovery worker failed');
        throw err;
      } finally {
        await agent.close();
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS.discovery.concurrency,
    },
  );
}
