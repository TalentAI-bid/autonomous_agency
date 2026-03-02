import { getQueue } from '../queues/queues.js';
import { registerTenantWorkers } from '../queues/workers.js';
import logger from '../utils/logger.js';

/**
 * Schedule a repeatable email-listener poll job for a specific config.
 * Removes any stale repeatable first, then adds the repeatable + an immediate poll.
 */
export async function scheduleEmailListenerJob(
  tenantId: string,
  configId: string,
  masterAgentId: string,
  pollingIntervalMs: number,
): Promise<void> {
  registerTenantWorkers(tenantId);
  const listenQueue = getQueue(tenantId, 'email-listen');

  // Remove stale repeatable job before re-adding
  const existingJobs = await listenQueue.getRepeatableJobs();
  const staleJob = existingJobs.find(j => j.id === `email-listen-${configId}`);
  if (staleJob) {
    await listenQueue.removeRepeatableByKey(staleJob.key);
    logger.info({ tenantId, configId }, 'Removed stale repeatable poll job');
  }

  await listenQueue.add('poll', {
    tenantId,
    configId,
    masterAgentId,
  }, {
    repeat: { every: pollingIntervalMs },
    jobId: `email-listen-${configId}`,
  });

  // Immediate first poll so the user doesn't wait for the full interval
  await listenQueue.add('poll-now', {
    tenantId,
    configId,
    masterAgentId,
  }, { jobId: `email-listen-now-${configId}-${Date.now()}` });

  logger.info({ tenantId, configId, intervalMs: pollingIntervalMs }, 'Scheduled poll + poll-now for config');
}

/**
 * Remove a specific email-listener repeatable job for a config.
 */
export async function removeEmailListenerJob(
  tenantId: string,
  configId: string,
): Promise<void> {
  const listenQueue = getQueue(tenantId, 'email-listen');
  const existingJobs = await listenQueue.getRepeatableJobs();
  const job = existingJobs.find(j => j.id === `email-listen-${configId}`);
  if (job) {
    await listenQueue.removeRepeatableByKey(job.key);
    logger.info({ tenantId, configId }, 'Removed email-listener repeatable job');
  }
}

/**
 * Remove ALL email-listener repeatable jobs for a tenant.
 */
export async function removeAllEmailListenerJobs(
  tenantId: string,
): Promise<void> {
  const listenQueue = getQueue(tenantId, 'email-listen');
  const repeatableJobs = await listenQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await listenQueue.removeRepeatableByKey(job.key);
  }
  if (repeatableJobs.length > 0) {
    logger.info({ tenantId, count: repeatableJobs.length }, 'Removed all email-listener repeatable jobs');
  }
}

/**
 * Remove ALL email-send repeatable jobs for a tenant.
 */
export async function removeAllEmailSendJobs(
  tenantId: string,
): Promise<void> {
  const sendQueue = getQueue(tenantId, 'email-send');
  const repeatableJobs = await sendQueue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    await sendQueue.removeRepeatableByKey(job.key);
  }
  if (repeatableJobs.length > 0) {
    logger.info({ tenantId, count: repeatableJobs.length }, 'Removed all email-send repeatable jobs');
  }
}
