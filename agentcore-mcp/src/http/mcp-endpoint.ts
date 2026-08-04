import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { sessions } from '../mcp/session-store.js';
import { createMcpServer } from '../mcp/server.js';
import { extractBearer } from '../auth/verify-token.js';
import { RESOURCE_METADATA_URL } from './well-known.js';

function unauthorized(reply: FastifyReply): void {
  // RFC 9728: point the client at our protected-resource metadata so it can
  // discover the Authorization Server and start the OAuth flow.
  reply
    .code(401)
    .header('WWW-Authenticate', `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`)
    .send({ jsonrpc: '2.0', error: { code: -32001, message: 'Authentication required' }, id: null });
}

/**
 * Streamable-HTTP MCP transport mounted at /mcp:
 *   POST   — JSON-RPC requests (the first must be `initialize`, which opens a session)
 *   GET    — server→client SSE stream for an existing session
 *   DELETE — explicit session teardown
 * Each session gets its own transport + McpServer, tracked by Mcp-Session-Id.
 */
export function registerMcpEndpoint(fastify: FastifyInstance): void {
  fastify.post('/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request);
    if (!bearer) return unauthorized(reply);

    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (entry) {
      entry.ctx.bearer = bearer; // token may rotate between calls
    } else {
      if (!isInitializeRequest(request.body)) {
        reply
          .code(400)
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send initialize first' }, id: null });
        return;
      }
      const ctx = { bearer };
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { transport, ctx });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const server = createMcpServer(ctx);
      await server.connect(transport);
      entry = { transport, ctx };
    }

    reply.hijack();
    await entry.transport.handleRequest(request.raw, reply.raw, request.body);
  });

  const handleSessionRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const bearer = extractBearer(request);
    if (!bearer) return unauthorized(reply);

    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      reply.code(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Unknown or missing session' }, id: null });
      return;
    }
    entry.ctx.bearer = bearer;
    reply.hijack();
    await entry.transport.handleRequest(request.raw, reply.raw);
  };

  fastify.get('/mcp', handleSessionRequest);
  fastify.delete('/mcp', handleSessionRequest);
}
