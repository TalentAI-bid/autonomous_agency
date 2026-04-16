import type { FastifyInstance } from 'fastify';
import {
  createConversation,
  sendMessage,
  sendMessageStream,
  approveProposal,
  getConversation,
} from '../services/chat.service.js';
import { ValidationError } from '../utils/errors.js';
import { isOriginAllowed } from '../utils/cors.js';

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/chat/conversations — Create a new conversation
  fastify.post('/conversations', async (request, reply) => {
    const result = await createConversation(request.tenantId, request.userId);
    return reply.status(201).send({ data: result });
  });

  // GET /api/chat/conversations/:id — Get conversation with messages
  fastify.get<{ Params: { id: string } }>('/conversations/:id', async (request) => {
    const result = await getConversation(request.tenantId, request.params.id);
    return { data: result };
  });

  // POST /api/chat/conversations/:id/messages — Send a message (with optional file attachments)
  fastify.post<{ Params: { id: string } }>('/conversations/:id/messages', async (request) => {
    const conversationId = request.params.id;

    let content = '';
    const attachments: Array<{ fileName: string; mimeType: string; buffer: Buffer }> = [];

    // Parse multipart form data
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'content') {
          content = part.value as string;
        }
      } else if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        attachments.push({
          fileName: part.filename,
          mimeType: part.mimetype,
          buffer: Buffer.concat(chunks),
        });
      }
    }

    if (!content && attachments.length === 0) {
      throw new ValidationError('Message content or file attachment is required');
    }

    const result = await sendMessage(
      request.tenantId,
      conversationId,
      content || 'I uploaded a document for you to analyze.',
      attachments.length > 0 ? attachments : undefined,
    );
    return { data: result };
  });

  // POST /api/chat/conversations/:id/messages/stream — Send a message with SSE streaming response
  fastify.post<{ Params: { id: string } }>('/conversations/:id/messages/stream', async (request, reply) => {
    const conversationId = request.params.id;

    let content = '';
    const attachments: Array<{ fileName: string; mimeType: string; buffer: Buffer }> = [];

    // Parse multipart form data
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === 'field') {
        if (part.fieldname === 'content') {
          content = part.value as string;
        }
      } else if (part.type === 'file') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        attachments.push({
          fileName: part.filename,
          mimeType: part.mimetype,
          buffer: Buffer.concat(chunks),
        });
      }
    }

    if (!content && attachments.length === 0) {
      throw new ValidationError('Message content or file attachment is required');
    }

    // SSE bypasses the @fastify/cors plugin (we write raw headers below), so
    // we re-implement the same allow-list check here. Echo the request's
    // actual origin if it's permitted; otherwise omit the header entirely so
    // the browser blocks the response.
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
      const stream = sendMessageStream(
        request.tenantId,
        conversationId,
        content || 'I uploaded a document for you to analyze.',
        attachments.length > 0 ? attachments : undefined,
      );

      for await (const chunk of stream) {
        reply.raw.write(chunk);
      }
    } catch (err) {
      reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
    }

    reply.raw.end();
    return reply;
  });

  // POST /api/chat/conversations/:id/approve — Approve and launch the proposed pipeline
  fastify.post<{ Params: { id: string } }>('/conversations/:id/approve', async (request) => {
    const result = await approveProposal(
      request.tenantId,
      request.params.id,
      request.userId,
    );
    return { data: result };
  });
}
