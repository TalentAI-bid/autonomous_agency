import { eq } from 'drizzle-orm';
import type { Job, Worker } from 'bullmq';
import { withTenant } from '../config/database.js';
import { agentTasks } from '../db/schema/index.js';
import type { AgentType } from '../queues/queues.js';
import { createDiscoveryWorker } from './discovery.worker.js';
import { createDocumentWorker } from './document.worker.js';
import { createEnrichmentWorker } from './enrichment.worker.js';
import { createScoringWorker } from './scoring.worker.js';
import { createOutreachWorker } from './outreach.worker.js';
import { createReplyWorker } from './reply.worker.js';
import { createActionWorker } from './action.worker.js';

export function registerAllWorkers(tenantId: string): Worker[] {
  return [
    createDiscoveryWorker(tenantId),
    createDocumentWorker(tenantId),
    createEnrichmentWorker(tenantId),
    createScoringWorker(tenantId),
    createOutreachWorker(tenantId),
    createReplyWorker(tenantId),
    createActionWorker(tenantId),
  ];
}

export async function createTaskRecord(
  job: Job,
  agentType: AgentType,
): Promise<{ id: string; tenantId: string }> {
  const tenantId = (job.data as Record<string, unknown>).tenantId as string;
  const masterAgentId = (job.data as Record<string, unknown>).masterAgentId as string | undefined;

  const [task] = await withTenant(tenantId, async (tx) => {
    return tx.insert(agentTasks).values({
      tenantId,
      masterAgentId: masterAgentId ?? undefined,
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
