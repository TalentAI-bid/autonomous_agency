import { getQueue, type AgentType, AGENT_TYPES } from '../queues/queues.js';
import logger from '../utils/logger.js';

export interface JobOptions {
  priority?: number;
  delay?: number;
  attempts?: number;
}

export async function dispatchJob(
  tenantId: string,
  agentType: AgentType,
  data: Record<string, unknown>,
  opts?: JobOptions,
): Promise<string> {
  const queue = getQueue(tenantId, agentType);
  const job = await queue.add(
    `${agentType}-job`,
    { ...data, tenantId },
    {
      priority: opts?.priority,
      delay: opts?.delay,
      attempts: opts?.attempts,
    },
  );

  logger.info({ tenantId, agentType, jobId: job.id }, 'Job dispatched');
  return job.id!;
}

export async function dispatchAllAgents(
  tenantId: string,
  masterAgentId: string,
  input: Record<string, unknown>,
): Promise<Record<string, string>> {
  const jobIds: Record<string, string> = {};
  // Start with discovery agent — others will be triggered by workers in Prompt 2
  const jobId = await dispatchJob(tenantId, 'discovery', {
    masterAgentId,
    ...input,
  });
  jobIds.discovery = jobId;
  return jobIds;
}

export async function getQueueStatus(
  tenantId: string,
  agentType: AgentType,
): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getQueue(tenantId, agentType);
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

export async function getAllQueuesStatus(tenantId: string) {
  const statuses: Record<string, Awaited<ReturnType<typeof getQueueStatus>>> = {};
  for (const agentType of AGENT_TYPES) {
    statuses[agentType] = await getQueueStatus(tenantId, agentType);
  }
  return statuses;
}

/** Pipeline queue types to drain on start/stop/delete (excludes email-listen/email-send — handled separately) */
const PIPELINE_QUEUE_TYPES: AgentType[] = [
  'discovery', 'enrichment', 'document', 'scoring', 'outreach', 'reply', 'action',
  'strategy', 'strategist', 'reddit-monitor', 'mailbox',
];

/**
 * Drain all pipeline queues for a tenant — removes all waiting and delayed jobs.
 * Call this before starting a new pipeline to clear stale jobs from previous runs.
 */
export async function drainAllPipelineQueues(tenantId: string): Promise<number> {
  let totalDrained = 0;
  for (const agentType of PIPELINE_QUEUE_TYPES) {
    const queue = getQueue(tenantId, agentType);
    try {
      const waiting = await queue.getWaitingCount();
      const delayed = await queue.getDelayedCount();
      if (waiting + delayed > 0) {
        await queue.drain();
        totalDrained += waiting + delayed;
        logger.info({ tenantId, agentType, waiting, delayed }, 'Queue drained');
      }
    } catch (err) {
      logger.warn({ err, tenantId, agentType }, 'Failed to drain queue');
    }
  }
  if (totalDrained > 0) {
    logger.info({ tenantId, totalDrained }, 'All pipeline queues drained');
  }
  return totalDrained;
}

export async function pauseAgentQueue(tenantId: string, agentType: AgentType): Promise<void> {
  const queue = getQueue(tenantId, agentType);
  await queue.pause();
  logger.info({ tenantId, agentType }, 'Queue paused');
}

export async function resumeAgentQueue(tenantId: string, agentType: AgentType): Promise<void> {
  const queue = getQueue(tenantId, agentType);
  await queue.resume();
  logger.info({ tenantId, agentType }, 'Queue resumed');
}
