import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS, type AgentType } from '../queues/queues.js';
import { LinkedInAgent } from '../agents/linkedin.agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import logger from '../utils/logger.js';

export function createLinkedInWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'linkedin' as AgentType),
    async (job: Job) => {
      let task: { id: string; tenantId: string } | undefined;
      try {
        task = await createTaskRecord(job, 'linkedin' as AgentType);
      } catch (taskErr) {
        logger.warn(
          { err: taskErr, tenantId, jobId: job.id },
          'Failed to create task record for linkedin — continuing without it',
        );
      }

      const data = job.data as Record<string, unknown>;
      const agent = new LinkedInAgent({
        tenantId,
        masterAgentId: (data.masterAgentId as string) || '',
        agentType: 'linkedin',
      });

      try {
        const result = await agent.run(data as any);
        if (task) await completeTaskRecord(tenantId, task.id, result as unknown as Record<string, unknown>);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (task) await failTaskRecord(tenantId, task.id, message);
        logger.error({ err, tenantId, jobId: job.id }, 'LinkedIn worker failed');
        throw err;
      } finally {
        await agent.close();
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS.linkedin.concurrency,
    },
  );
}
