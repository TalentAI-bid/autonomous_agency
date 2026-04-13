import { eq } from 'drizzle-orm';
import type { Job, Worker } from 'bullmq';
import { withTenant } from '../config/database.js';
import { agentTasks, masterAgents as masterAgentsTable } from '../db/schema/index.js';
import type { AgentType } from '../queues/queues.js';
import { createDiscoveryWorker } from './discovery.worker.js';
import { createDocumentWorker } from './document.worker.js';
import { createEnrichmentWorker } from './enrichment.worker.js';
import { createScoringWorker } from './scoring.worker.js';
import { createOutreachWorker } from './outreach.worker.js';
import { createReplyWorker } from './reply.worker.js';
import { createActionWorker } from './action.worker.js';
import { createEmailListenerWorker } from './email-listener.worker.js';
import { createEmailSenderWorker } from './email-sender.worker.js';
import { createMailboxWorker } from './mailbox.worker.js';
import { createRedditMonitorWorker } from './reddit-monitor.worker.js';
import { createStrategyWorker } from './strategy.worker.js';
import { createStrategistWorker } from './strategist.worker.js';
import { createCompanyFinderWorker } from './company-finder.worker.js';
import { createCandidateFinderWorker } from './candidate-finder.worker.js';
import { createLinkedInWorker } from './linkedin.worker.js';
import logger from '../utils/logger.js';

export function registerAllWorkers(tenantId: string): Worker[] {
  const workers = [
    createDiscoveryWorker(tenantId),
    createDocumentWorker(tenantId),
    createEnrichmentWorker(tenantId),
    createScoringWorker(tenantId),
    createOutreachWorker(tenantId),
    createReplyWorker(tenantId),
    createActionWorker(tenantId),
    createEmailListenerWorker(tenantId),
    createEmailSenderWorker(tenantId),
    createMailboxWorker(tenantId),
    createRedditMonitorWorker(tenantId),
    createStrategyWorker(tenantId),
    createStrategistWorker(tenantId),
    createCompanyFinderWorker(tenantId),
    createCandidateFinderWorker(tenantId),
    createLinkedInWorker(tenantId),
  ];

  for (const worker of workers) {
    worker.on('error', (err) => {
      logger.error({ err, tenantId, workerName: worker.name }, 'Worker error');
    });
  }

  return workers;
}

export async function createTaskRecord(
  job: Job,
  agentType: AgentType,
): Promise<{ id: string; tenantId: string }> {
  const tenantId = (job.data as Record<string, unknown>).tenantId as string;
  let masterAgentId = (job.data as Record<string, unknown>).masterAgentId as string | undefined;

  // Validate masterAgentId exists — prevent FK violation for orphaned jobs
  if (masterAgentId) {
    const exists = await withTenant(tenantId, async (tx) => {
      const [row] = await tx.select({ id: masterAgentsTable.id }).from(masterAgentsTable)
        .where(eq(masterAgentsTable.id, masterAgentId!))
        .limit(1);
      return !!row;
    });
    if (!exists) {
      logger.warn({ tenantId, masterAgentId, agentType, jobId: job.id }, 'masterAgentId not found — setting to null to prevent FK violation');
      masterAgentId = undefined;
    }
  }

  const [task] = await withTenant(tenantId, async (tx) => {
    return tx.insert(agentTasks).values({
      tenantId,
      masterAgentId: masterAgentId || undefined,
      agentType,
      status: 'processing',
      input: job.data as Record<string, unknown>,
      startedAt: new Date(),
      priority: (job.opts.priority as number) ?? 0,
    }).returning({ id: agentTasks.id, tenantId: agentTasks.tenantId });
  });

  return task!;
}

export async function completeTaskRecord(
  tenantId: string,
  taskId: string,
  output: Record<string, unknown>,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.update(agentTasks)
      .set({ status: 'completed', output, completedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  });
}

export async function failTaskRecord(
  tenantId: string,
  taskId: string,
  error: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.update(agentTasks)
      .set({ status: 'failed', error, completedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  });
}
