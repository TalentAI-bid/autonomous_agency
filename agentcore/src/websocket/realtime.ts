import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { subRedis } from '../queues/setup.js';
import { verifySession } from '../services/auth.service.js';
import logger from '../utils/logger.js';

/** Track active connections per tenant */
const tenantConnections = new Map<string, Set<WebSocket>>();

async function realtimePlugin(fastify: FastifyInstance) {
  await fastify.register(websocket);

  // WebSocket route: /ws/realtime
  fastify.get('/ws/realtime', { websocket: true }, async (socket: WebSocket, request) => {
    // Authenticate via query param token
    const token = (request.query as Record<string, string>).token;

    if (!token) {
      socket.send(JSON.stringify({ error: 'Authentication required. Pass ?token=JWT' }));
      socket.close(4001, 'Unauthorized');
      return;
    }

    let tenantId: string;
    let userId: string;

    // Primary path: opaque Redis session (dashboard).
    const session = await verifySession(token);
    if (session) {
      tenantId = session.tenantId;
      userId = session.userId;
    } else {
      // Fallback: JWT (extension popup / legacy clients).
      try {
        const decoded = fastify.jwt.verify<{ tenantId: string; userId: string }>(token);
        tenantId = decoded.tenantId;
        userId = decoded.userId;
      } catch {
        socket.send(JSON.stringify({ error: 'Invalid token' }));
        socket.close(4001, 'Unauthorized');
        return;
      }
    }

    // Register connection
    if (!tenantConnections.has(tenantId)) {
      tenantConnections.set(tenantId, new Set());
    }
    tenantConnections.get(tenantId)!.add(socket);

    logger.info({ tenantId, userId }, 'WebSocket client connected');

    // Send welcome message
    socket.send(JSON.stringify({
      event: 'connected',
      data: { tenantId, userId, timestamp: new Date().toISOString() },
    }));

    // Handle client messages (ping/pong, subscribe to specific events)
    socket.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    // Cleanup on disconnect
    socket.on('close', () => {
      tenantConnections.get(tenantId)?.delete(socket);
      if (tenantConnections.get(tenantId)?.size === 0) {
        tenantConnections.delete(tenantId);
      }
      logger.info({ tenantId, userId }, 'WebSocket client disconnected');
    });

    socket.on('error', (err: Error) => {
      logger.error({ err, tenantId, userId }, 'WebSocket error');
    });
  });
}

/**
 * Start the Redis PubSub listener that relays events to WebSocket clients.
 * Call this once during server startup.
 */
export async function startRealtimeRelay(): Promise<void> {
  // Subscribe to all tenant event channels
  await subRedis.psubscribe('agent-events:*');

  subRedis.on('pmessage', (_pattern: string, channel: string, message: string) => {
    // channel format: agent-events:{tenantId}
    const tenantId = channel.split(':')[1];
    if (!tenantId) return;

    const connections = tenantConnections.get(tenantId);
    if (!connections || connections.size === 0) return;

    // Broadcast to all connected clients for this tenant
    for (const socket of connections) {
      if (socket.readyState === 1) { // WebSocket.OPEN
        socket.send(message);
      }
    }
  });

  logger.info('Real-time relay started — listening for agent events via Redis PubSub');
}

export default fp(realtimePlugin, { name: 'realtime', dependencies: ['auth'] });
