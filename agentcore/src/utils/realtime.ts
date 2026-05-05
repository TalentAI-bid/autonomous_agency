import { pubRedis } from '../queues/setup.js';
import logger from './logger.js';

// Realtime relay piggy-backs on the existing `agent-events:<tenantId>` channel
// pattern that the websocket layer already subscribes to via psubscribe.
// Adding helpers here so callers don't hand-format the JSON envelope and so
// new event types can land in one place.

// Matches dashboard's `AgentEvent` shape: { event, data, timestamp }. The
// realtime relay forwards the JSON verbatim and the WebSocketManager
// dispatches by `event` field.
interface RealtimeEnvelope<E extends string, D> {
  event: E;
  data: D;
  timestamp: string;
}

async function publish<E extends string, D>(tenantId: string, event: E, data: D): Promise<void> {
  const envelope: RealtimeEnvelope<E, D> = { event, data, timestamp: new Date().toISOString() };
  try {
    await pubRedis.publish(`agent-events:${tenantId}`, JSON.stringify(envelope));
  } catch (err) {
    logger.debug({ err, tenantId, event }, 'realtime publish failed (non-fatal)');
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
