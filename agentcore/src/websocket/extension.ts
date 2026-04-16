import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { WebSocket } from 'ws';
import crypto from 'crypto';
import { subRedis } from '../queues/setup.js';
import {
  findSessionByApiKeyHash,
  markSessionConnected,
  drainPending,
  onExtensionTaskComplete,
} from '../services/extension-dispatcher.js';
import logger from '../utils/logger.js';

/** sessionId → WebSocket (one active socket per session at a time) */
const sessionSockets = new Map<string, WebSocket>();

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

    await markSessionConnected(session.id, true);
    logger.info({ sessionId: session.id, tenantId: session.tenantId }, 'Extension WebSocket connected');

    socket.send(JSON.stringify({
      type: 'connected',
      sessionId: session.id,
      serverTime: new Date().toISOString(),
    }));

    // Drain any pending tasks
    drainPending(session.tenantId, session.id).catch((err) =>
      logger.warn({ err, sessionId: session.id }, 'Failed to drain pending extension tasks'),
    );

    socket.on('message', async (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'task_result') {
        const taskId = msg.taskId as string;
        const status = msg.status as 'completed' | 'failed';
        if (!taskId || !status) return;
        try {
          if (status === 'completed') {
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
