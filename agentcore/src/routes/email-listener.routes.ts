import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { emailListenerConfigs, masterAgents } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { getQueue } from '../queues/queues.js';
import { registerTenantWorkers } from '../queues/workers.js';
import {
  scheduleEmailListenerJob,
  removeEmailListenerJob,
} from '../services/email-poll-scheduler.service.js';
import logger from '../utils/logger.js';

const createSchema = z.object({
  emailAccountId: z.string().uuid().optional(),
  protocol: z.enum(['imap', 'pop3']).default('imap'),
  host: z.string().min(1),
  port: z.number().default(993),
  username: z.string().min(1),
  password: z.string().min(1),
  useTls: z.boolean().default(true),
  mailbox: z.string().default('INBOX'),
  pollingIntervalMs: z.number().min(10000).default(60000),
});

const updateSchema = createSchema.partial();

export default async function emailListenerRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/email-listeners
  fastify.get('/', async (request) => {
    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailListenerConfigs)
        .where(eq(emailListenerConfigs.tenantId, request.tenantId))
        .orderBy(desc(emailListenerConfigs.createdAt));
    });
    const data = results.map(({ password, ...rest }) => ({ ...rest, hasPassword: true }));
    return { data };
  });

  // POST /api/email-listeners
  fastify.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { password, ...rest } = parsed.data;
    const [config] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(emailListenerConfigs).values({
        tenantId: request.tenantId,
        ...rest,
        password: encrypt(password),
      }).returning();
    });

    // Auto-schedule polling if there's a running master agent
    try {
      const [runningAgent] = await withTenant(request.tenantId, async (tx) => {
        return tx.select({ id: masterAgents.id }).from(masterAgents)
          .where(and(eq(masterAgents.tenantId, request.tenantId), eq(masterAgents.status, 'running')))
          .limit(1);
      });
      if (runningAgent) {
        await scheduleEmailListenerJob(
          request.tenantId,
          config.id,
          runningAgent.id,
          parsed.data.pollingIntervalMs ?? 60000,
        );
      }
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId, configId: config.id }, 'Failed to auto-schedule email listener polling');
    }

    return reply.status(201).send({ data: config });
  });

  // GET /api/email-listeners/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [config] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, id), eq(emailListenerConfigs.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!config) throw new NotFoundError('EmailListenerConfig', id);
    const { password, ...rest } = config;
    return { data: { ...rest, hasPassword: true } };
  });

  // PATCH /api/email-listeners/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { password, ...rest } = parsed.data;
    const updateData: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (password !== undefined) {
      updateData.password = encrypt(password);
    }

    const [config] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(emailListenerConfigs)
        .set(updateData)
        .where(and(eq(emailListenerConfigs.id, id), eq(emailListenerConfigs.tenantId, request.tenantId)))
        .returning();
    });
    if (!config) throw new NotFoundError('EmailListenerConfig', id);

    // Re-schedule or remove polling based on isActive state
    if (config.isActive) {
      try {
        const [runningAgent] = await withTenant(request.tenantId, async (tx) => {
          return tx.select({ id: masterAgents.id }).from(masterAgents)
            .where(and(eq(masterAgents.tenantId, request.tenantId), eq(masterAgents.status, 'running')))
            .limit(1);
        });
        if (runningAgent) {
          await scheduleEmailListenerJob(
            request.tenantId,
            config.id,
            runningAgent.id,
            config.pollingIntervalMs,
          );
        }
      } catch (err) {
        logger.error({ err, tenantId: request.tenantId, configId: config.id }, 'Failed to reschedule email listener polling');
      }
    } else {
      // isActive is false — remove the repeatable job
      try {
        await removeEmailListenerJob(request.tenantId, config.id);
      } catch (err) {
        logger.error({ err, tenantId: request.tenantId, configId: config.id }, 'Failed to remove email listener job on deactivation');
      }
    }

    return { data: config };
  });

  // DELETE /api/email-listeners/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, id), eq(emailListenerConfigs.tenantId, request.tenantId)))
        .returning({ id: emailListenerConfigs.id });
    });
    if (result.length === 0) throw new NotFoundError('EmailListenerConfig', id);

    // Remove the repeatable job from BullMQ
    try {
      await removeEmailListenerJob(request.tenantId, id);
    } catch (err) {
      logger.error({ err, tenantId: request.tenantId, configId: id }, 'Failed to remove email listener job on delete');
    }

    return { success: true };
  });

  // POST /api/email-listeners/:id/test-connection
  fastify.post<{ Params: { id: string } }>('/:id/test-connection', async (request) => {
    const { id } = request.params;
    const [config] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, id), eq(emailListenerConfigs.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!config) throw new NotFoundError('EmailListenerConfig', id);

    try {
      if (config.protocol === 'imap') {
        const { ImapFlow } = await import('imapflow');
        const password = decrypt(config.password);
        const client = new ImapFlow({
          host: config.host,
          port: config.port,
          secure: config.useTls,
          auth: { user: config.username, pass: password },
          logger: false,
        });
        await client.connect();
        await client.logout();
        return { data: { success: true, protocol: 'imap' } };
      } else {
        const Pop3Command = (await import('node-pop3')).default;
        const password = decrypt(config.password);
        const pop3 = new Pop3Command({
          host: config.host,
          port: config.port,
          tls: config.useTls,
          user: config.username,
          password,
        });
        await pop3.STAT();
        await pop3.QUIT();
        return { data: { success: true, protocol: 'pop3' } };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: { success: false, error: message } };
    }
  });

  // POST /api/email-listeners/:id/poll-now
  fastify.post<{ Params: { id: string } }>('/:id/poll-now', async (request) => {
    const { id } = request.params;
    const [config] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, id), eq(emailListenerConfigs.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!config) throw new NotFoundError('EmailListenerConfig', id);

    // Find running master agent for this tenant
    const [runningAgent] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ id: masterAgents.id }).from(masterAgents)
        .where(and(eq(masterAgents.tenantId, request.tenantId), eq(masterAgents.status, 'running')))
        .limit(1);
    });

    registerTenantWorkers(request.tenantId);
    const queue = getQueue(request.tenantId, 'email-listen');
    const job = await queue.add('poll-now', {
      tenantId: request.tenantId,
      configId: id,
      masterAgentId: runningAgent?.id ?? null,
    });

    return { data: { jobId: job.id } };
  });

  // GET /api/email-listeners/:id/status — Diagnostics endpoint
  fastify.get<{ Params: { id: string } }>('/:id/status', async (request) => {
    const { id } = request.params;
    const [config] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, id), eq(emailListenerConfigs.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!config) throw new NotFoundError('EmailListenerConfig', id);

    const listenQueue = getQueue(request.tenantId, 'email-listen');
    const repeatableJobs = await listenQueue.getRepeatableJobs();
    const repeatableJob = repeatableJobs.find(j => j.id === `email-listen-${id}`) ?? null;

    const [waiting, active, failed, delayed] = await Promise.all([
      listenQueue.getWaitingCount(),
      listenQueue.getActiveCount(),
      listenQueue.getFailedCount(),
      listenQueue.getDelayedCount(),
    ]);

    const { password, ...safeConfig } = config;
    return {
      data: {
        config: { ...safeConfig, hasPassword: true },
        lastError: config.lastError ?? null,
        lastPolledAt: config.lastPolledAt ?? null,
        queue: { waiting, active, failed, delayed },
        repeatableJob: repeatableJob ? {
          key: repeatableJob.key,
          every: repeatableJob.every,
          next: repeatableJob.next,
        } : null,
      },
    };
  });
}
