import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { pubRedis } from './setup.js';
import { getQueue } from './queues.js';
import { createDeadLetterWorker } from './dead-letter.js';
import { registerAllWorkers } from '../workers/index.js';
import { db, withTenant } from '../config/database.js';
import { emailListenerConfigs, masterAgents, tenants } from '../db/schema/index.js';
import { scheduleEmailListenerJob, removeAllEmailListenerJobs, removeAllEmailSendJobs } from '../services/email-poll-scheduler.service.js';
import logger from '../utils/logger.js';

/** Active workers registry */
const activeWorkers: Worker[] = [];

/** Tracks tenants that already have workers registered */
const registeredTenants = new Set<string>();

/**
 * Register workers for a specific tenant.
 * Called when a tenant starts their agents.
 */
export function registerTenantWorkers(tenantId: string): void {
  if (registeredTenants.has(tenantId)) {
    logger.info({ tenantId }, 'Workers already registered, skipping');
    return;
  }
  const workers = registerAllWorkers(tenantId);
  activeWorkers.push(...workers);

  // Also create dead letter worker for this tenant
  const dlWorker = createDeadLetterWorker(tenantId);
  activeWorkers.push(dlWorker);

  registeredTenants.add(tenantId);
  logger.info({ tenantId }, `Registered ${workers.length + 1} workers for tenant`);
}

/**
 * Schedule repeating BullMQ jobs for a running agent.
 * Called on agent start and on app restart for agents with status='running'.
 */
export async function scheduleAgentJobs(
  tenantId: string,
  agentId: string,
  config: Record<string, unknown>,
): Promise<void> {
  registerTenantWorkers(tenantId);
  const enabledAgents = (config.enabledAgents as string[]) ?? [];

  // Schedule email-send repeatable job (every 10s) if outreach/email-send enabled
  if (!enabledAgents.length || enabledAgents.includes('email-send') || enabledAgents.includes('outreach')) {
    const emailSendQueue = getQueue(tenantId, 'email-send');
    // Remove stale repeatable before re-adding
    const existingSendJobs = await emailSendQueue.getRepeatableJobs();
    const staleSendJob = existingSendJobs.find(j => j.id === `email-send-${tenantId}`);
    if (staleSendJob) {
      await emailSendQueue.removeRepeatableByKey(staleSendJob.key);
    }
    await emailSendQueue.add('batch-send', { tenantId }, {
      repeat: { every: 10000 },
      jobId: `email-send-${tenantId}`,
    });
  }

  // Always schedule email listener polling if active configs exist
  const specificConfigId = config.emailListenerConfigId as string | undefined;

  // Validate UUID format — invalid values would cause a Postgres type-cast error
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validConfigId = specificConfigId && UUID_RE.test(specificConfigId) ? specificConfigId : undefined;

  if (specificConfigId && !validConfigId) {
    logger.warn({ tenantId, agentId, specificConfigId }, 'emailListenerConfigId is not a valid UUID — querying all active configs');
  }

  const listenerCfgs = validConfigId
    ? await withTenant(tenantId, async (tx) => {
        return tx.select().from(emailListenerConfigs)
          .where(and(eq(emailListenerConfigs.id, validConfigId), eq(emailListenerConfigs.tenantId, tenantId), eq(emailListenerConfigs.isActive, true)));
      })
    : await withTenant(tenantId, async (tx) => {
        return tx.select().from(emailListenerConfigs)
          .where(and(eq(emailListenerConfigs.tenantId, tenantId), eq(emailListenerConfigs.isActive, true)));
      });

  logger.info({ tenantId, agentId, listenerCount: listenerCfgs.length, specificConfigId: validConfigId ?? 'all' }, 'Email listener configs queried');

  if (listenerCfgs.length === 0) {
    logger.warn({ tenantId, agentId }, 'No active email listener configs found — email polling not scheduled');
  }

  for (const cfg of listenerCfgs) {
    await scheduleEmailListenerJob(tenantId, cfg.id, agentId, cfg.pollingIntervalMs);
  }

  if (listenerCfgs.length > 0) {
    logger.info({ tenantId, agentId, count: listenerCfgs.length }, 'Scheduled email-listen jobs');
  }
}

export async function closeAllWorkers(): Promise<void> {
  await Promise.all(activeWorkers.map((w) => w.close()));
  activeWorkers.length = 0;
  registeredTenants.clear();
}

/**
 * Standalone worker process entry point.
 * When run directly, this starts workers for all known tenants.
 * Note: PM2 sets process.env.pm_exec_path but does NOT update process.argv[1],
 * so we check both for direct invocation and PM2-managed execution.
 */
const scriptPath = process.env.pm_exec_path || process.argv[1] || '';
if (scriptPath.endsWith('workers.js') || scriptPath.endsWith('workers.ts')) {
  logger.info('Worker process started. Registering workers for running agents...');

  (async () => {
    try {
      const allTenants = await db.select({ id: tenants.id }).from(tenants);
      const runningAgents: Array<{ id: string; tenantId: string; config: unknown }> = [];

      for (const tenant of allTenants) {
        const agents = await withTenant(tenant.id, async (tx) => {
          return tx.select({ id: masterAgents.id, tenantId: masterAgents.tenantId, config: masterAgents.config })
            .from(masterAgents)
            .where(eq(masterAgents.status, 'running'));
        });
        runningAgents.push(...agents);
      }

      const tenantIds = [...new Set(runningAgents.map(a => a.tenantId))];
      for (const tid of tenantIds) {
        registerTenantWorkers(tid);
        // Clean all stale repeatable jobs before re-scheduling
        await removeAllEmailListenerJobs(tid);
        await removeAllEmailSendJobs(tid);
      }

      for (const agent of runningAgents) {
        try {
          const agentConfig = (agent.config as Record<string, unknown>) ?? {};
          await scheduleAgentJobs(agent.tenantId, agent.id, agentConfig);
        } catch (err) {
          logger.error({ err, tenantId: agent.tenantId, agentId: agent.id }, 'Failed to schedule jobs for agent in worker process');
        }
      }

      logger.info({ tenants: tenantIds.length, agents: runningAgents.length }, 'Worker process ready — workers registered and jobs scheduled');
    } catch (err) {
      logger.error(err, 'Worker process failed to initialize');
    }
  })();

  const shutdown = async () => {
    logger.info('Shutting down workers...');
    await closeAllWorkers();
    await pubRedis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
