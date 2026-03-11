import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { DiscoveryAgent } from '../agents/discovery.agent.js';
import { MasterAgent } from '../agents/master-agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import logger from '../utils/logger.js';

export function createDiscoveryWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'discovery'),
    async (job: Job) => {
      const data = job.data as Record<string, unknown>;

      // Handle master-orchestrate repeatable job
      if (data.orchestrate) {
        const masterAgentId = data.masterAgentId as string;
        const agent = new MasterAgent({ tenantId, masterAgentId });
        try {
          return await agent.orchestrate(data);
        } catch (err) {
          logger.error({ err, tenantId, masterAgentId }, 'Master orchestration loop failed');
          throw err;
        } finally {
          await agent.close();
        }
      }

      let task: { id: string; tenantId: string } | undefined;
      try {
        task = await createTaskRecord(job, 'discovery');
      } catch (taskErr) {
        logger.warn({ err: taskErr, tenantId, jobId: job.id }, 'Failed to create task record for discovery — continuing without it');
      }

      const agent = new DiscoveryAgent({
        tenantId,
        masterAgentId: data.masterAgentId as string || '',
        agentType: 'discovery',
      });
      try {
        const result = await agent.execute(data);
        if (task) await completeTaskRecord(tenantId, task.id, result);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (task) await failTaskRecord(tenantId, task.id, message);
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
