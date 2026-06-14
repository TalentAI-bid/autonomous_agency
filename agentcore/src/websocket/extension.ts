import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { WebSocket } from 'ws';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { extensionSessions } from '../db/schema/index.js';
import { subRedis } from '../queues/setup.js';
import {
  findSessionByApiKeyHash,
  markSessionConnected,
  touchSessionLastSeen,
  drainPending,
  drainPendingForUser,
  onExtensionTaskComplete,
} from '../services/extension-dispatcher.js';
import logger from '../utils/logger.js';

/** sessionId → WebSocket (one active socket per session at a time) */
const sessionSockets = new Map<string, WebSocket>();

/**
 * Liveness check used by the dispatcher: a DB row marked `connected=true`
 * is only meaningful if THIS process actually holds a live OPEN socket for
 * that session. After a crash or pm2 restart the row stays true but the
 * Map is empty, so dispatching to it would silently lose the message.
 */
export function hasLiveExtensionSocket(sessionId: string): boolean {
  const s = sessionSockets.get(sessionId);
  return !!s && s.readyState === 1; // WebSocket.OPEN
}

/**
 * Reset all `connected=true` rows on api startup. Anything currently flagged
 * as connected is by definition an orphan from a prior process that died
 * without running the WS `close` handler.
 */
export async function clearOrphanSessionsOnBoot(): Promise<void> {
  const rows = await db
    .update(extensionSessions)
    .set({ connected: false, updatedAt: new Date() })
    .where(eq(extensionSessions.connected, true))
    .returning({ id: extensionSessions.id });
  if (rows.length > 0) {
    logger.warn({ count: rows.length }, 'cleared_orphan_extension_sessions_on_boot');
  }
}

function hashKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function extensionPlugin(fastify: FastifyInstance) {
  // @fastify/websocket is already registered by realtime.ts — don't double-register.
  fastify.get('/ws/extension', { websocket: true }, async (socket: WebSocket, request) => {
    const apiKey = (request.query as Record<string, string>).apiKey;
    if (!apiKey || !apiKey.startsWith('tai_ext_')) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    const session = await findSessionByApiKeyHash(hashKey(apiKey));
    if (!session) {
      socket.close(4401, 'Unauthorized');
      return;
    }

    // Close any prior socket for the same session
    const prev = sessionSockets.get(session.id);
    if (prev) {
      try { prev.close(4000, 'Superseded'); } catch { /* ignore */ }
    }
    sessionSockets.set(session.id, socket);

    // Per-socket throttled lastSeenAt updater. Bumps the row at most once
    // every 10s on inbound activity (ping or task_result) so the field is a
    // real liveness signal rather than just connect/close timestamps.
    let lastSeenWriteAt = Date.now();
    const maybeTouchLastSeen = () => {
      const now = Date.now();
      if (now - lastSeenWriteAt < 10_000) return;
      lastSeenWriteAt = now;
      touchSessionLastSeen(session.id).catch((err) =>
        logger.warn({ err, sessionId: session.id }, 'touchSessionLastSeen failed'),
      );
    };

    await markSessionConnected(session.id, true);
    logger.info(
      { sessionId: session.id, userId: session.userId, tenantId: session.tenantId },
      'Extension WebSocket connected',
    );

    socket.send(JSON.stringify({
      type: 'connected',
      sessionId: session.id,
      serverTime: new Date().toISOString(),
    }));

    // Drain any pending tasks. Multi-workspace sessions (tenantId === null)
    // pull pending work from every tenant the user is a member of via the
    // user_tenants join. Legacy per-tenant sessions still drain only their
    // own tenant.
    if (session.tenantId) {
      drainPending(session.tenantId, session.id).catch((err) =>
        logger.warn({ err, sessionId: session.id }, 'Failed to drain pending extension tasks (legacy)'),
      );
    } else {
      drainPendingForUser(session.userId, session.id).catch((err) =>
        logger.warn({ err, sessionId: session.id, userId: session.userId }, 'Failed to drain pending extension tasks (multi-workspace)'),
      );
    }

    socket.on('message', async (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      logger.debug({ sessionId: session.id, type: msg.type }, 'extension_ws_recv');

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        maybeTouchLastSeen();
        return;
      }

      if (msg.type === 'task_result') {
        const taskId = msg.taskId as string;
        const status = msg.status as 'completed' | 'failed';
        if (!taskId || !status) return;
        maybeTouchLastSeen();
        logger.info(
          {
            sessionId: session.id,
            taskId,
            status,
            hasResult: !!msg.result,
            errorPreview: typeof msg.error === 'string' ? msg.error.slice(0, 200) : undefined,
          },
          'extension_task_result_received',
        );
        try {
          if (status === 'completed') {
            logger.debug(
              { taskId, resultKeys: Object.keys((msg.result as Record<string, unknown>) ?? {}) },
              'extension_task_result_ingesting',
            );
            await onExtensionTaskComplete(taskId, {
              status: 'completed',
              result: (msg.result as Record<string, unknown>) ?? {},
            });
          } else {
            await onExtensionTaskComplete(taskId, {
              status: 'failed',
              error: String(msg.error ?? 'unknown'),
            });
          }
        } catch (err) {
          logger.warn({ err, taskId }, 'Failed to handle extension task_result');
        }
      }
    });

    socket.on('close', async () => {
      sessionSockets.delete(session.id);
      try {
        await markSessionConnected(session.id, false);
      } catch {
        /* ignore */
      }
      logger.info({ sessionId: session.id }, 'Extension WebSocket disconnected');
    });

    socket.on('error', (err: Error) => {
      logger.warn({ err, sessionId: session.id }, 'Extension WebSocket error');
    });
  });
}

/**
 * Start the Redis PubSub listener that relays extension-dispatch messages
 * to the locally-connected extension socket.
 */
export async function startExtensionRelay(): Promise<void> {
  await subRedis.psubscribe('extension-dispatch:*');

  subRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
    if (!channel.startsWith('extension-dispatch:')) return;
    const sessionId = channel.slice('extension-dispatch:'.length);
    const socket = sessionSockets.get(sessionId);
    if (!socket || socket.readyState !== 1) return;

    try {
      const parsed = JSON.parse(message);
      if (parsed?.type === 'revoked') {
        try { socket.close(4401, 'Revoked'); } catch { /* ignore */ }
        sessionSockets.delete(sessionId);
        return;
      }
      socket.send(message);
    } catch {
      // Non-JSON — forward as-is
      socket.send(message);
    }
  });

  logger.info('Extension relay started — listening for extension-dispatch:* events');
}

export default fp(extensionPlugin, { name: 'extension-ws', dependencies: ['realtime'] });
