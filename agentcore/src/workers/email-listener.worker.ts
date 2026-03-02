import { Worker, type Job } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { EmailListenerAgent } from '../agents/email-listener.agent.js';
import { createTaskRecord, completeTaskRecord, failTaskRecord } from './index.js';
import { withTenant } from '../config/database.js';
import { emailListenerConfigs } from '../db/schema/index.js';
import logger from '../utils/logger.js';

export function createEmailListenerWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'email-listen'),
    async (job: Job) => {
      let task: { id: string; tenantId: string } | undefined;
      try {
        task = await createTaskRecord(job, 'email-listen');
      } catch (taskErr) {
        logger.warn({ err: taskErr, tenantId, jobId: job.id }, 'Failed to create task record for email-listen — continuing without it');
      }

      const configId = (job.data as Record<string, unknown>).configId as string | undefined;

      const agent = new EmailListenerAgent({
        tenantId,
        masterAgentId: (job.data as Record<string, unknown>).masterAgentId as string || '',
        agentType: 'email-listen',
      });
      try {
        const result = await agent.execute(job.data as Record<string, unknown>);
        if (task) await completeTaskRecord(tenantId, task.id, result);
        // Clear lastError on success
        if (configId) {
          try {
            await withTenant(tenantId, async (tx) => {
              await tx.update(emailListenerConfigs)
                .set({ lastError: null })
                .where(and(eq(emailListenerConfigs.id, configId), eq(emailListenerConfigs.tenantId, tenantId)));
            });
          } catch (_) { /* best-effort */ }
        }
        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (task) await failTaskRecord(tenantId, task.id, message);
        // Write lastError to config
        if (configId) {
          try {
            await withTenant(tenantId, async (tx) => {
              await tx.update(emailListenerConfigs)
                .set({ lastError: message })
                .where(and(eq(emailListenerConfigs.id, configId), eq(emailListenerConfigs.tenantId, tenantId)));
            });
          } catch (_) { /* best-effort */ }
        }
        logger.error({ err, tenantId, jobId: job.id }, 'Email listener worker failed');
        throw err;
      } finally {
        await agent.close();
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS['email-listen'].concurrency,
    },
  );
}
