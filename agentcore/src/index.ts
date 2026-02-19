import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { closeDatabase } from './config/database.js';
import authPlugin from './middleware/auth.js';
import tenantPlugin from './middleware/tenant.js';
import rateLimitPlugin from './middleware/rate-limit.js';
import realtimePlugin, { startRealtimeRelay } from './websocket/realtime.js';
import { closeAllQueues } from './queues/queues.js';
import { closeAllWorkers } from './queues/workers.js';
import { closeRedisConnections } from './queues/setup.js';
import { errorHandler } from './utils/errors.js';
import logger from './utils/logger.js';

// Route imports
import authRoutes from './routes/auth.routes.js';
import tenantRoutes from './routes/tenant.routes.js';
import masterAgentRoutes from './routes/master-agent.routes.js';
import agentRoutes from './routes/agent.routes.js';
import contactRoutes from './routes/contact.routes.js';
import companyRoutes from './routes/company.routes.js';
import campaignRoutes from './routes/campaign.routes.js';
import documentRoutes from './routes/document.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';

async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
  });

  // Global error handler
  fastify.setErrorHandler(errorHandler);

  // Core plugins
  await fastify.register(cors, {
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  await fastify.register(cookie);

  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB
    },
  });

  // Auth & tenant
  await fastify.register(authPlugin);
  await fastify.register(tenantPlugin);

  // Rate limiting
  await fastify.register(rateLimitPlugin);

  // WebSocket
  await fastify.register(realtimePlugin);

  // Health check (unauthenticated)
  fastify.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }));

  // API routes
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(tenantRoutes, { prefix: '/api/tenants' });
  await fastify.register(masterAgentRoutes, { prefix: '/api/master-agents' });
  await fastify.register(agentRoutes, { prefix: '/api/agents' });
  await fastify.register(contactRoutes, { prefix: '/api/contacts' });
  await fastify.register(companyRoutes, { prefix: '/api/companies' });
  await fastify.register(campaignRoutes, { prefix: '/api/campaigns' });
  await fastify.register(documentRoutes, { prefix: '/api/documents' });
  await fastify.register(analyticsRoutes, { prefix: '/api/analytics' });

  return fastify;
}

async function start() {
  const app = await buildApp();

  // Start real-time relay (Redis PubSub → WebSocket)
  await startRealtimeRelay();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully...');
    await app.close();
    await closeAllWorkers();
    await closeAllQueues();
    await closeRedisConnections();
    await closeDatabase();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`AgentCore API running on http://0.0.0.0:${env.PORT}`);
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// Export for testing
export { buildApp };

start();
