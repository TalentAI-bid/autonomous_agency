import { Worker } from 'bullmq';
import { pubRedis } from './setup.js';
import { createDeadLetterWorker } from './dead-letter.js';
import { registerAllWorkers } from '../workers/index.js';
import logger from '../utils/logger.js';

/** Active workers registry */
const activeWorkers: Worker[] = [];

/**
 * Register workers for a specific tenant.
 * Called when a tenant starts their agents.
 */
export function registerTenantWorkers(tenantId: string): void {
  const workers = registerAllWorkers(tenantId);
  activeWorkers.push(...workers);

  // Also create dead letter worker for this tenant
  const dlWorker = createDeadLetterWorker(tenantId);
  activeWorkers.push(dlWorker);

  logger.info({ tenantId }, `Registered ${workers.length + 1} workers for tenant`);
}

export async function closeAllWorkers(): Promise<void> {
  await Promise.all(activeWorkers.map((w) => w.close()));
  activeWorkers.length = 0;
}

/**
 * Standalone worker process entry point.
 * When run directly, this starts workers for all known tenants.
 */
if (process.argv[1]?.endsWith('workers.js') || process.argv[1]?.endsWith('workers.ts')) {
  // In production, you'd query the DB for active tenants.
  // For now, workers are registered on-demand when master agents start.
  logger.info('Worker process started. Workers will be registered on demand.');

  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await closeAllWorkers();
    await pubRedis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
