import { pubRedis } from '../queues/setup.js';
import logger from './logger.js';

// Realtime relay piggy-backs on the existing `agent-events:<tenantId>` channel
// pattern that the websocket layer already subscribes to via psubscribe.
// Adding helpers here so callers don't hand-format the JSON envelope and so
// new event types can land in one place.

interface RealtimeEnvelope<T extends string, P> {
  type: T;
  payload: P;
  ts: string;
}

async function publish<T extends string, P>(tenantId: string, type: T, payload: P): Promise<void> {
  const env: RealtimeEnvelope<T, P> = { type, payload, ts: new Date().toISOString() };
  try {
    await pubRedis.publish(`agent-events:${tenantId}`, JSON.stringify(env));
  } catch (err) {
    logger.debug({ err, tenantId, type }, 'realtime publish failed (non-fatal)');
  }
}

export interface FitScoreUpdatedPayload {
  companyId: string;
  score: number;
  dataCompleteness: 'partial' | 'full';
  fit_summary: string;
}

export async function publishFitScoreUpdated(params: { tenantId: string } & FitScoreUpdatedPayload): Promise<void> {
  const { tenantId, ...payload } = params;
  await publish(tenantId, 'fit_score_updated', payload);
}
