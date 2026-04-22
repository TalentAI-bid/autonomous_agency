import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS, type AgentType } from '../queues/queues.js';
import { CompanyFinderAgent } from '../agents/company-finder.agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import logger from '../utils/logger.js';

export function createCompanyFinderWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'company-finder' as AgentType),
    async (job: Job) => {
      let task: { id: string; tenantId: string } | undefined;
      try {
        task = await createTaskRecord(job, 'company-finder' as AgentType);
      } catch (taskErr) {
        logger.warn(
          { err: taskErr, tenantId, jobId: job.id },
          'Failed to create task record for company-finder — continuing without it',
        );
      }

      const data = job.data as Record<string, unknown>;
      const agent = new CompanyFinderAgent({
        tenantId,
        masterAgentId: (data.masterAgentId as string) || '',
      });

      try {
        const result = await agent.run(data as any);
        if (task) await completeTaskRecord(tenantId, task.id, result as unknown as Record<string, unknown>);
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (task) await failTaskRecord(tenantId, task.id, message);
        logger.error({ err, tenantId, jobId: job.id }, 'Company-finder worker failed');
        throw err;
      } finally {
        await agent.close();
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS['company-finder' as AgentType].concurrency,
    },
  );
}
