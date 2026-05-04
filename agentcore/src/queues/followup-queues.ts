import { Queue } from 'bullmq';
import { queueRedis } from './setup.js';

// Global (non-tenant-scoped) queues for the follow-up subsystem. The scheduler
// scans across all tenants on a repeatable tick; the send worker handles one
// campaign_contact at a time and uses withTenant internally for DB ops.

export const FOLLOWUP_SCHEDULER_QUEUE_NAME = 'followup-scheduler';
export const FOLLOWUP_SEND_QUEUE_NAME = 'followup-send';

let schedulerQueue: Queue | undefined;
let sendQueue: Queue | undefined;

export function getFollowupSchedulerQueue(): Queue {
  if (!schedulerQueue) {
    schedulerQueue = new Queue(FOLLOWUP_SCHEDULER_QUEUE_NAME, {
      connection: queueRedis as any,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return schedulerQueue;
}

export function getFollowupSendQueue(): Queue {
  if (!sendQueue) {
    sendQueue = new Queue(FOLLOWUP_SEND_QUEUE_NAME, {
      connection: queueRedis as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return sendQueue;
}
