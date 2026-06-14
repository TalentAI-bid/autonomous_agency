import { Worker, type Job } from 'bullmq';
import { createRedisConnection } from '../queues/setup.js';
import { GMAPS_MENU_QUEUE_NAME, type GmapsMenuJobData } from '../queues/gmaps-menu-queues.js';
import { extractAndStoreGmapsMenu } from '../services/gmaps-menu.service.js';
import { extractAndStoreGmapsWebsiteMenu } from '../services/gmaps-website-menu.service.js';
import logger from '../utils/logger.js';

/**
 * Process one Google Maps menu-vision job. Global worker (one per process,
 * cross-tenant) — each job carries its own tenantId. Mirrors the fit-score
 * worker pattern; no agent_tasks row (not an agent-enum job).
 */
export async function processGmapsMenuJob(job: Job<GmapsMenuJobData>): Promise<{ stored: boolean }> {
  const { tenantId, contactId } = job.data;
  // Prefer the business's own website (clean text, exact prices, correct
  // language); fall back to photo-vision OCR. Both are fail-soft & idempotent.
  const stored = (await extractAndStoreGmapsWebsiteMenu(tenantId, contactId))
    || (await extractAndStoreGmapsMenu(tenantId, contactId));
  return { stored };
}

let worker: Worker | undefined;

export function startGmapsMenuWorker(): Worker {
  if (worker) return worker;
  const concurrency = Number(process.env.GMAPS_MENU_WORKER_CONCURRENCY ?? '3') || 3;
  worker = new Worker<GmapsMenuJobData>(
    GMAPS_MENU_QUEUE_NAME,
    processGmapsMenuJob,
    {
      connection: createRedisConnection() as any,
      concurrency,
    },
  );

  worker.on('error', (err) => {
    logger.error({ err }, 'gmaps-menu worker error');
  });

  logger.info({ concurrency }, 'gmaps-menu worker started');
  return worker;
}

export async function stopGmapsMenuWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = undefined;
  }
}
