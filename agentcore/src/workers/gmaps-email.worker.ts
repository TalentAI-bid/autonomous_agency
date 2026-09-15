import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { GMAPS_EMAIL_QUEUE_NAME, type GmapsEmailJobData } from '../queues/gmaps-email-queues.js';
import { extractAndStoreGmapsWebsiteEmail } from '../services/gmaps-website-email.service.js';
import logger from '../utils/logger.js';

/**
 * Process one Google Maps generic-email job. Global worker (one per process,
 * cross-tenant) — each job carries its own tenantId. Mirrors the gmaps-menu
 * worker; no agent_tasks row (not an agent-enum job). Fail-soft & idempotent.
 */
export async function processGmapsEmailJob(job: Job<GmapsEmailJobData>): Promise<{ stored: boolean }> {
  const { tenantId, contactId } = job.data;
  const stored = await extractAndStoreGmapsWebsiteEmail(tenantId, contactId);
  return { stored };
}

let worker: Worker | undefined;

export function startGmapsEmailWorker(): Worker {
  if (worker) return worker;
  const concurrency = Number(process.env.GMAPS_EMAIL_WORKER_CONCURRENCY ?? '3') || 3;
  worker = new Worker<GmapsEmailJobData>(
    GMAPS_EMAIL_QUEUE_NAME,
    processGmapsEmailJob,
    {
      connection: createRedisConnection() as any,
      concurrency,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err }, 'gmaps-email worker error');
  });

  logger.info({ concurrency }, 'gmaps-email worker started');
  return worker;
}

export async function stopGmapsEmailWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
}
