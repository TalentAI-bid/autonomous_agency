import Fastify from 'fastify';
import { env } from './config/env.js';
import { registerMcpEndpoint } from './http/mcp-endpoint.js';
import { registerWellKnown } from './http/well-known.js';

const fastify = Fastify({
  logger: { level: env.LOG_LEVEL },
  // SSE streams stay open; don't let Fastify time out the request.
  requestTimeout: 0,
});

fastify.get('/health', async () => ({ status: 'ok', service: 'agentcore-mcp' }));

registerWellKnown(fastify);
registerMcpEndpoint(fastify);

try {
  const addr = await fastify.listen({ port: env.PORT, host: '0.0.0.0' });
  fastify.log.info(`agentcore-mcp listening on ${addr} → agentcore ${env.AGENTCORE_URL}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
