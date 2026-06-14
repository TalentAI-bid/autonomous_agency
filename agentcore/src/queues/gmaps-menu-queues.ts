import { Queue } from 'bullmq';
import { queueRedis } from './setup.js';

// Global (cross-tenant) Google Maps menu-vision queue — one queue across the
// whole worker process. Each job carries its own tenantId so the worker can
// withTenant the work. Pattern mirrors the fit-score queue.

export const GMAPS_MENU_QUEUE_NAME = 'gmaps-menu';

let q: Queue | undefined;

export function getGmapsMenuQueue(): Queue {
  if (!q) {
    q = new Queue(GMAPS_MENU_QUEUE_NAME, {
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

export interface GmapsMenuJobData {
  contactId: string;
  tenantId: string;
  masterAgentId?: string;
}

/**
 * Enqueue a best-effort menu-vision job for a Google Maps food business.
 * Deduped by contactId so repeated detail scrapes don't pile up duplicate work.
 */
export async function enqueueGmapsMenu(data: GmapsMenuJobData): Promise<void> {
  const queue = getGmapsMenuQueue();
  await queue.add('menu', data, { jobId: `gmaps-menu:${data.contactId}` });
}
