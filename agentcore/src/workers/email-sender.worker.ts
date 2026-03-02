import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { getQueueName, QUEUE_CONFIGS } from '../queues/queues.js';
import { processEmailBatch } from '../services/email-sender.service.js';
import logger from '../utils/logger.js';

export function createEmailSenderWorker(tenantId: string): Worker {
  return new Worker(
    getQueueName(tenantId, 'email-send'),
    async (job: Job) => {
      try {
        const result = await processEmailBatch(tenantId);
        return result;
      } catch (err) {
        logger.error({ err, tenantId, jobId: job.id }, 'Email sender worker failed');
        throw err;
      }
    },
    {
      connection: createRedisConnection() as any,
      concurrency: QUEUE_CONFIGS['email-send'].concurrency,
    },
  );
}
