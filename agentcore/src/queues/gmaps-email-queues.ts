import { Queue } from 'bullmq';
import { queueRedis } from './setup.js';

// Global (cross-tenant) Google Maps generic-email queue — one queue across the
// whole worker process. Each job carries its own tenantId so the worker can
// withTenant the work. Pattern mirrors the gmaps-menu queue.

export const GMAPS_EMAIL_QUEUE_NAME = 'gmaps-email';

let q: Queue | undefined;

export function getGmapsEmailQueue(): Queue {
  if (!q) {
    q = new Queue(GMAPS_EMAIL_QUEUE_NAME, {
      connection: queueRedis as any,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return q;
}

export interface GmapsEmailJobData {
  contactId: string;
  tenantId: string;
  masterAgentId?: string;
}

/**
 * Enqueue a best-effort generic-email crawl for a Google Maps business contact.
 * Deduped by contactId so repeated detail scrapes don't pile up duplicate work.
 */
export async function enqueueGmapsEmail(data: GmapsEmailJobData): Promise<void> {
  const queue = getGmapsEmailQueue();
  await queue.add('email', data, { jobId: `gmaps-email:${data.contactId}` });
}
