import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { agentMessages } from '../db/schema/index.js';
import { createRedisConnection, pubRedis } from '../queues/setup.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

export default async function agentRoomRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/agent-room/:masterAgentId/messages — Paginated message feed
  fastify.get<{
    Params: { masterAgentId: string };
    Querystring: { cursor?: string; limit?: string; fromAgent?: string; toAgent?: string; messageType?: string };
  }>('/:masterAgentId/messages', async (request) => {
    const { masterAgentId } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 200);
    const { cursor, fromAgent, toAgent, messageType } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(agentMessages.tenantId, request.tenantId),
        eq(agentMessages.masterAgentId, masterAgentId),
      ];

      if (fromAgent) conditions.push(eq(agentMessages.fromAgent, fromAgent));
      if (toAgent) conditions.push(eq(agentMessages.toAgent, toAgent));
      if (messageType) conditions.push(eq(agentMessages.messageType, messageType));

      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(agentMessages.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor');
        }
      }

      return tx.select().from(agentMessages)
        .where(and(...conditions))
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({
          createdAt: data[data.length - 1]!.createdAt.toISOString(),
          id: data[data.length - 1]!.id,
        })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor } };
  });

  // POST /api/agent-room/:masterAgentId/messages — Human sends message to agent
  fastify.post<{
    Params: { masterAgentId: string };
    Body: { toAgent: string; content: string; actionType?: string };
  }>('/:masterAgentId/messages', async (request, reply) => {
    const { masterAgentId } = request.params;
    const { toAgent, content, actionType = 'instruction' } = request.body as {
      toAgent: string; content: string; actionType?: string;
    };

    if (!content || !toAgent) {
      throw new ValidationError('toAgent and content are required');
    }

    // 1. Save to agent_messages
    const [msg] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(agentMessages).values({
        tenantId: request.tenantId,
        masterAgentId,
        fromAgent: 'human',
        toAgent: toAgent === 'all' ? undefined : toAgent,
        messageType: 'human_message',
        content: { message: content, actionType },
      }).returning();
    });

    // 2. Store instruction in Redis (24h TTL)
    try {
      const redis = createRedisConnection();
      if (toAgent === 'all') {
        // Broadcast to all agent types
        const agentTypes = ['discovery', 'enrichment', 'scoring', 'outreach', 'master'];
        for (const at of agentTypes) {
          const key = `tenant:${request.tenantId}:human-instruction:${masterAgentId}:${at}`;
          await redis.setex(key, 86400, content);
        }
      } else {
        const key = `tenant:${request.tenantId}:human-instruction:${masterAgentId}:${toAgent}`;
        await redis.setex(key, 86400, content);
      }
      await redis.quit();
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'Failed to store human instruction in Redis');
    }

    // 3. Emit event
    try {
      await pubRedis.publish(
        `agent-events:${request.tenantId}`,
        JSON.stringify({
          event: 'agent:message',
          data: {
            id: msg?.id,
            masterAgentId,
            fromAgent: 'human',
            toAgent: toAgent === 'all' ? undefined : toAgent,
            messageType: 'human_message',
            content: { message: content, actionType },
          },
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to emit human message event');
    }

    return reply.status(201).send({ data: msg });
  });
}
