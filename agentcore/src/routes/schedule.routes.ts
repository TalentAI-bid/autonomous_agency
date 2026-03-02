import type { FastifyInstance } from 'fastify';
import { eq, and, asc, inArray } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { emailQueue, agentTasks } from '../db/schema/index.js';

export default async function scheduleRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/schedule/upcoming — Scheduled actions timeline
  fastify.get('/upcoming', async (request) => {
    const { limit = 50, filter } = request.query as {
      limit?: number;
      filter?: 'all' | 'emails' | 'tasks';
    };

    const data = await withTenant(request.tenantId, async (tx) => {
      const items: Array<{
        id: string;
        type: 'email' | 'task';
        title: string;
        scheduledAt: string;
        status: string;
        metadata: Record<string, unknown>;
      }> = [];

      // Queued emails
      if (!filter || filter === 'all' || filter === 'emails') {
        const queuedEmails = await tx
          .select({
            id: emailQueue.id,
            toEmail: emailQueue.toEmail,
            subject: emailQueue.subject,
            status: emailQueue.status,
            scheduledAt: emailQueue.scheduledAt,
            createdAt: emailQueue.createdAt,
          })
          .from(emailQueue)
          .where(and(
            eq(emailQueue.tenantId, request.tenantId),
            eq(emailQueue.status, 'queued'),
          ))
          .orderBy(asc(emailQueue.scheduledAt))
          .limit(Number(limit));

        for (const email of queuedEmails) {
          items.push({
            id: email.id,
            type: 'email',
            title: `Email to ${email.toEmail}: ${email.subject ?? 'No subject'}`,
            scheduledAt: (email.scheduledAt ?? email.createdAt).toISOString(),
            status: email.status,
            metadata: { toEmail: email.toEmail, subject: email.subject },
          });
        }
      }

      // Active agent tasks
      if (!filter || filter === 'all' || filter === 'tasks') {
        const activeTasks = await tx
          .select({
            id: agentTasks.id,
            agentType: agentTasks.agentType,
            status: agentTasks.status,
            input: agentTasks.input,
            createdAt: agentTasks.createdAt,
            startedAt: agentTasks.startedAt,
          })
          .from(agentTasks)
          .where(and(
            eq(agentTasks.tenantId, request.tenantId),
            inArray(agentTasks.status, ['pending', 'processing']),
          ))
          .orderBy(asc(agentTasks.createdAt))
          .limit(Number(limit));

        for (const task of activeTasks) {
          items.push({
            id: task.id,
            type: 'task',
            title: `${task.agentType} task`,
            scheduledAt: (task.startedAt ?? task.createdAt).toISOString(),
            status: task.status,
            metadata: { agentType: task.agentType, input: task.input },
          });
        }
      }

      // Sort merged items by date ascending
      items.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

      return items.slice(0, Number(limit));
    });

    return { data };
  });
}
