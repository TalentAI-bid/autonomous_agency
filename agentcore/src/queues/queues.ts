import { Queue } from 'bullmq';
import { queueRedis } from './setup.js';

export const AGENT_TYPES = [
  'discovery', 'enrichment', 'document', 'scoring', 'outreach', 'reply', 'action',
] as const;

export type AgentType = (typeof AGENT_TYPES)[number];

export type QueueType = AgentType | 'dead-letter';

/** Default job options per agent type */
export const QUEUE_CONFIGS: Record<QueueType, {
  defaultJobOptions: {
    attempts: number;
    backoff: { type: 'exponential' | 'fixed'; delay: number };
    priority?: number;
    delay?: number;
  };
  concurrency: number;
}> = {
  discovery: {
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    concurrency: 5,
  },
  enrichment: {
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    concurrency: 5,
  },
  document: {
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    concurrency: 3,
  },
  scoring: {
    defaultJobOptions: { attempts: 5, backoff: { type: 'fixed', delay: 10000 }, priority: 10 },
    concurrency: 10,
  },
  outreach: {
    defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 60000 }, priority: 1 },
    concurrency: 3,
  },
  reply: {
    defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 1000 }, priority: 1 },
    concurrency: 5,
  },
  action: {
    defaultJobOptions: { attempts: 2, backoff: { type: 'fixed', delay: 300000 } },
    concurrency: 3,
  },
  'dead-letter': {
    defaultJobOptions: { attempts: 1, backoff: { type: 'fixed', delay: 0 } },
    concurrency: 1,
  },
};

/** Cache of created queues: key = "queueType:tenantId" */
const queueCache = new Map<string, Queue>();

export function getQueueName(tenantId: string, queueType: QueueType): string {
  return `queue:${queueType}:${tenantId}`;
}

export function getQueue(tenantId: string, queueType: QueueType): Queue {
  const key = `${queueType}:${tenantId}`;
  let queue = queueCache.get(key);

  if (!queue) {
    const config = QUEUE_CONFIGS[queueType];
    queue = new Queue(getQueueName(tenantId, queueType), {
      connection: queueRedis as any,
      defaultJobOptions: {
        attempts: config.defaultJobOptions.attempts,
        backoff: config.defaultJobOptions.backoff,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
    queueCache.set(key, queue);
  }

  return queue;
}

export async function closeAllQueues(): Promise<void> {
  const closePromises = Array.from(queueCache.values()).map((q) => q.close());
  await Promise.all(closePromises);
  queueCache.clear();
}
