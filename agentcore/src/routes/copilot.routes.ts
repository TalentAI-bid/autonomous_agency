import type { FastifyInstance } from 'fastify';
import {
  createCopilotSession,
  sendCopilotMessageStream,
  approveCopilotProfile,
  suggestProduct,
} from '../services/copilot.service.js';
import { getConversation } from '../services/chat.service.js';
import { ValidationError } from '../utils/errors.js';
import { isOriginAllowed } from '../utils/cors.js';

export default async function copilotRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/copilot/sessions — Create a new copilot session
  fastify.post('/sessions', async (request, reply) => {
    const result = await createCopilotSession(request.tenantId, request.userId);
    return reply.status(201).send({ data: result });
  });

  // GET /api/copilot/sessions/:id — Get copilot session with messages
  fastify.get<{ Params: { id: string } }>('/sessions/:id', async (request) => {
    const result = await getConversation(request.tenantId, request.params.id);
    return { data: result };
  });

  // POST /api/copilot/sessions/:id/messages/stream — Send message with SSE streaming
  fastify.post<{ Params: { id: string } }>('/sessions/:id/messages/stream', async (request, reply) => {
    const conversationId = request.params.id;
    const body = request.body as Record<string, unknown>;
    const content = (body?.content as string) ?? '';

    if (!content.trim()) {
      throw new ValidationError('Message content is required');
    }

    // SSE headers with CORS
    const reqOrigin = (request.headers.origin as string) || '';
    const allowOrigin = isOriginAllowed(reqOrigin) ? reqOrigin : '';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    });

    try {
      const stream = sendCopilotMessageStream(request.tenantId, conversationId, content);
      for await (const chunk of stream) {
        reply.raw.write(chunk);
      }
    } catch (err) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }

    reply.raw.end();
    return reply;
  });

  // POST /api/copilot/sessions/:id/approve — Apply the generated profile
  fastify.post<{ Params: { id: string } }>('/sessions/:id/approve', async (request) => {
    const result = await approveCopilotProfile(request.tenantId, request.params.id);
    return { data: result };
  });

  // POST /api/copilot/suggest-product — AI-generate product details from name
  fastify.post('/suggest-product', async (request) => {
    const body = request.body as Record<string, unknown>;
    const name = (body?.name as string) ?? '';
    if (!name.trim()) {
      throw new ValidationError('Product name is required');
    }
    const suggestion = await suggestProduct(request.tenantId, name.trim());
    return { data: { suggestion } };
  });
}
