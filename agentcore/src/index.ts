import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { db, closeDatabase } from './config/database.js';
import authPlugin from './middleware/auth.js';
import tenantPlugin from './middleware/tenant.js';
import rateLimitPlugin from './middleware/rate-limit.js';
import realtimePlugin, { startRealtimeRelay } from './websocket/realtime.js';
import extensionWsPlugin, { startExtensionRelay } from './websocket/extension.js';
import { closeAllQueues } from './queues/queues.js';
import { closeAllWorkers, registerTenantWorkers, scheduleAgentJobs } from './queues/workers.js';
import { closeRedisConnections } from './queues/setup.js';
import { errorHandler } from './utils/errors.js';
import { isOriginAllowed } from './utils/cors.js';
import { checkSearxngHealth } from './tools/searxng.tool.js';
import { checkCrawl4aiHealth } from './tools/crawl4ai.tool.js';
import logger from './utils/logger.js';
import { eq, sql } from 'drizzle-orm';
import { masterAgents, tenants } from './db/schema/index.js';
import { withTenant } from './config/database.js';

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
import chatRoutes from './routes/chat.routes.js';
import emailAccountRoutes from './routes/email-account.routes.js';
import emailListenerRoutes from './routes/email-listener.routes.js';
import crmRoutes from './routes/crm.routes.js';
import mailboxRoutes from './routes/mailbox.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';
import trackingRoutes from './routes/tracking.routes.js';
import activityRoutes from './routes/activity.routes.js';
import strategyRoutes from './routes/strategy.routes.js';
import opportunityRoutes from './routes/opportunity.routes.js';
import agentRoomRoutes from './routes/agent-room.routes.js';
import linkedinRoutes from './routes/linkedin.routes.js';
import extensionRoutes from './routes/extension.routes.js';
import productRoutes from './routes/product.routes.js';
import workspaceRoutes from './routes/workspace.routes.js';
import copilotRoutes from './routes/copilot.routes.js';

async function buildApp() {
  const fastify = Fastify({
    bodyLimit: 50 * 1024 * 1024, // 50MB — needed for PDF/DOCX uploads
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
  // CORS — function form so we can echo the request origin (required when
  // credentials: true; wildcards are forbidden in that combination) AND
  // transparently allow any chrome-extension://... origin (extension popup).
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
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
  await fastify.register(extensionWsPlugin);

  // Health check (unauthenticated)
  fastify.get('/api/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  }));

  // Detailed health/services check (unauthenticated — for diagnostics)
  fastify.get('/api/health/services', async () => {
    const [searxng, crawl4ai, redis, postgres] = await Promise.all([
      checkSearxngHealth(),
      checkCrawl4aiHealth(),
      (async () => {
        try {
          const { createRedisConnection } = await import('./queues/setup.js');
          const r = createRedisConnection();
          const pong = await r.ping();
          await r.quit();
          return { ok: pong === 'PONG', url: env.REDIS_URL };
        } catch (err) {
          return { ok: false, url: env.REDIS_URL, error: err instanceof Error ? err.message : String(err) };
        }
      })(),
      (async () => {
        try {
          await db.execute(sql`SELECT 1`);
          return { ok: true, url: env.DATABASE_URL.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') };
        } catch (err) {
          return { ok: false, url: env.DATABASE_URL.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'), error: err instanceof Error ? err.message : String(err) };
        }
      })(),
    ]);

    const togetherAi = {
      ok: !!env.TOGETHER_API_KEY,
      configured: !!env.TOGETHER_API_KEY,
    };

    const claudeAi = {
      ok: !!env.CLAUDE_API_KEY,
      configured: !!env.CLAUDE_API_KEY,
    };

    const allOk = searxng.ok && crawl4ai.ok && redis.ok && postgres.ok && togetherAi.ok;

    return {
      status: allOk ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      services: {
        searxng: { ...searxng, description: 'Meta-search engine (required for discovery + enrichment)' },
        crawl4ai: { ...crawl4ai, description: 'Web scraper (required for enrichment page scraping)' },
        redis: { ...redis, description: 'Cache, queues, sessions' },
        postgres: { ...postgres, description: 'Primary database' },
        togetherAi: { ...togetherAi, description: 'LLM for classification, extraction, scoring' },
        claudeAi: { ...claudeAi, description: 'LLM for outreach email generation' },
      },
    };
  });

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
  await fastify.register(chatRoutes, { prefix: '/api/chat' });
  await fastify.register(emailAccountRoutes, { prefix: '/api/email-accounts' });
  await fastify.register(emailListenerRoutes, { prefix: '/api/email-listeners' });
  await fastify.register(crmRoutes, { prefix: '/api/crm' });
  await fastify.register(mailboxRoutes, { prefix: '/api/mailbox' });
  await fastify.register(scheduleRoutes, { prefix: '/api/schedule' });
  await fastify.register(activityRoutes, { prefix: '/api/activity' });
  await fastify.register(strategyRoutes, { prefix: '/api/strategy' });
  await fastify.register(opportunityRoutes, { prefix: '/api/opportunities' });
  await fastify.register(agentRoomRoutes, { prefix: '/api/agent-room' });
  await fastify.register(linkedinRoutes, { prefix: '/api/linkedin' });
  await fastify.register(extensionRoutes, { prefix: '/api/extension' });
  await fastify.register(productRoutes, { prefix: '/api/products' });
  await fastify.register(workspaceRoutes, { prefix: '/api/workspaces' });
  await fastify.register(copilotRoutes, { prefix: '/api/copilot' });

  // Tracking pixel route — registered WITHOUT /api prefix (email clients hit this directly)
  await fastify.register(trackingRoutes, { prefix: '/track' });

  return fastify;
}

async function start() {
  const app = await buildApp();

  // Start real-time relay (Redis PubSub → WebSocket)
  await startRealtimeRelay();
  await startExtensionRelay();

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

    // Reset stale Crawl4AI circuit breaker from previous session
    try {
      const { createRedisConnection: createRedis } = await import('./queues/setup.js');
      const cbRedis = createRedis();
      await cbRedis.del('circuit:crawl4ai:open', 'circuit:crawl4ai:failures');
      cbRedis.disconnect();
      logger.info('Circuit breaker state cleared');
    } catch { /* non-critical */ }

    // Re-register workers and re-schedule repeating jobs for tenants with running agents (survives PM2 restarts)
    try {
      const allTenants = await db.select({ id: tenants.id }).from(tenants);

      const runningAgents: Array<{ id: string; tenantId: string; config: unknown }> = [];
      for (const tenant of allTenants) {
        const agents = await withTenant(tenant.id, async (tx) => {
          return tx.select({ id: masterAgents.id, tenantId: masterAgents.tenantId, config: masterAgents.config })
            .from(masterAgents)
            .where(eq(masterAgents.status, 'running'));
        });
        runningAgents.push(...agents);
      }

      const tenantIds = [...new Set(runningAgents.map(a => a.tenantId))];
      for (const tid of tenantIds) {
        registerTenantWorkers(tid);
      }

      for (const agent of runningAgents) {
        try {
          const agentConfig = (agent.config as Record<string, unknown>) ?? {};
          await scheduleAgentJobs(agent.tenantId, agent.id, agentConfig);
        } catch (err) {
          logger.error({ err, tenantId: agent.tenantId, agentId: agent.id }, 'Failed to schedule jobs for running agent on startup');
        }
      }

      if (runningAgents.length > 0) {
        logger.info({ tenants: tenantIds.length, agents: runningAgents.length }, 'Re-registered workers and re-scheduled jobs');
      }
    } catch (err) {
      logger.error(err, 'Failed to re-register workers on startup');
    }
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }
}

// Export for testing
export { buildApp };

start();
