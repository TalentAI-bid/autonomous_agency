import { Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { pubRedis } from './setup.js';
import { getQueue } from './queues.js';
import { createDeadLetterWorker } from './dead-letter.js';
import { registerAllWorkers } from '../workers/index.js';
import { db, withTenant } from '../config/database.js';
import { emailListenerConfigs, masterAgents, tenants } from '../db/schema/index.js';
import { scheduleEmailListenerJob, removeAllEmailListenerJobs, removeAllEmailSendJobs } from '../services/email-poll-scheduler.service.js';
import { checkSearxngHealth } from '../tools/searxng.tool.js';
import { checkCrawl4aiHealth } from '../tools/crawl4ai.tool.js';
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
  const enableOutreach = config.enableOutreach !== false; // default true for backward compat

  // Schedule email-send repeatable job (every 10s) if outreach/email-send enabled AND outreach not disabled
  if (enableOutreach && (!enabledAgents.length || enabledAgents.includes('email-send') || enabledAgents.includes('outreach'))) {
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

  // Schedule reddit-monitor repeatable job (every 4 hours)
  if (!enabledAgents.length || enabledAgents.includes('reddit-monitor')) {
    const redditMonitorQueue = getQueue(tenantId, 'reddit-monitor');
    const existingRedditJobs = await redditMonitorQueue.getRepeatableJobs();
    const staleRedditJob = existingRedditJobs.find(j => j.id === `reddit-monitor-${tenantId}`);
    if (staleRedditJob) {
      await redditMonitorQueue.removeRepeatableByKey(staleRedditJob.key);
    }
    await redditMonitorQueue.add('reddit-scan', { tenantId, masterAgentId: agentId }, {
      repeat: { every: 4 * 60 * 60 * 1000 },
      jobId: `reddit-monitor-${tenantId}`,
    });
  }

  // Schedule strategy repeatable job (daily at 6 AM UTC)
  if (!enabledAgents.length || enabledAgents.includes('strategy')) {
    const strategyQueue = getQueue(tenantId, 'strategy');
    const existingStrategyJobs = await strategyQueue.getRepeatableJobs();
    const staleStrategyJob = existingStrategyJobs.find(j => j.id === `strategy-${tenantId}-${agentId}`);
    if (staleStrategyJob) {
      await strategyQueue.removeRepeatableByKey(staleStrategyJob.key);
    }
    await strategyQueue.add('daily-strategy', { tenantId, masterAgentId: agentId }, {
      repeat: { pattern: '0 6 * * *' },
      jobId: `strategy-${tenantId}-${agentId}`,
    });
  }

  // Schedule master-orchestrate repeatable job (every 60s while running)
  if (!enabledAgents.length || enabledAgents.includes('discovery')) {
    const discoveryQueue = getQueue(tenantId, 'discovery');
    const existingOrchJobs = await discoveryQueue.getRepeatableJobs();
    const staleOrchJob = existingOrchJobs.find(j => j.id === `master-orchestrate-${tenantId}-${agentId}`);
    if (staleOrchJob) {
      await discoveryQueue.removeRepeatableByKey(staleOrchJob.key);
    }
    await discoveryQueue.add('master-orchestrate', { tenantId, masterAgentId: agentId, orchestrate: true }, {
      repeat: { every: 60000 },
      jobId: `master-orchestrate-${tenantId}-${agentId}`,
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
      // ── Startup dependency check ──────────────────────────────────────────
      const [searxng, crawl4ai] = await Promise.all([checkSearxngHealth(), checkCrawl4aiHealth()]);

      if (!searxng.ok) {
        logger.warn(
          { url: searxng.url, error: searxng.error },
          '*** SearXNG NOT REACHABLE at %s — discovery and enrichment agents will return empty results. Start it with: pm2 start ecosystem.config.cjs (searxng service) ***',
          searxng.url,
        );
      } else {
        logger.info({ url: searxng.url }, 'SearXNG is reachable');
      }

      if (!crawl4ai.ok) {
        logger.warn(
          { url: crawl4ai.url, error: crawl4ai.error },
          '*** Crawl4AI NOT REACHABLE at %s — enrichment page scraping will return empty. Start it with: pm2 start ecosystem.config.cjs (crawl4ai service) ***',
          crawl4ai.url,
        );
      } else {
        logger.info({ url: crawl4ai.url }, 'Crawl4AI is reachable');
      }

      const allTenants = await db.select({ id: tenants.id }).from(tenants);
      logger.info({ tenantCount: allTenants.length }, 'Worker startup: found tenants');

      const runningAgents: Array<{ id: string; tenantId: string; config: unknown }> = [];

      for (const tenant of allTenants) {
        const agents = await withTenant(tenant.id, async (tx) => {
          return tx.select({ id: masterAgents.id, tenantId: masterAgents.tenantId, config: masterAgents.config })
            .from(masterAgents)
            .where(eq(masterAgents.status, 'running'));
        });

        if (agents.length > 0) {
          logger.info({ tenantId: tenant.id, runningCount: agents.length }, 'Worker startup: found running agents for tenant');
        }

        runningAgents.push(...agents);
      }

      // Diagnostic: if no running agents found, check what statuses actually exist
      if (runningAgents.length === 0) {
        logger.warn('Worker startup: 0 running agents found across all tenants — checking all agent statuses');
        for (const tenant of allTenants) {
          const allAgents = await withTenant(tenant.id, async (tx) => {
            return tx.select({
              id: masterAgents.id,
              status: masterAgents.status,
              name: masterAgents.name,
            }).from(masterAgents);
          });
          if (allAgents.length > 0) {
            const statusCounts: Record<string, number> = {};
            for (const a of allAgents) {
              statusCounts[a.status ?? 'null'] = (statusCounts[a.status ?? 'null'] ?? 0) + 1;
            }
            logger.warn(
              { tenantId: tenant.id, totalAgents: allAgents.length, statusCounts },
              'Worker startup diagnostic: agent statuses for tenant',
            );
          }
        }
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
