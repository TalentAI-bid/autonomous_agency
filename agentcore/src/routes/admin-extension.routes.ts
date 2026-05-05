import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, db } from '../config/database.js';
import { agentActivityLog, extensionSessions, users } from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import { EXTENSION_SITE_LIMITS } from '../services/extension-dispatcher.js';
import logger from '../utils/logger.js';

const resetRateLimitsSchema = z.object({
  userEmail: z.string().email().optional(),
  userId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  taskTypes: z.array(z.string()).optional(),
}).refine(
  (v) => !!(v.userEmail || v.userId || v.tenantId),
  { message: 'At least one of userEmail, userId, or tenantId is required' },
);

export default async function adminExtensionRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('preHandler', fastify.requireRole('owner'));

  // POST /api/admin/extension/reset-rate-limits
  // Clears server-side daily counters on extension_sessions and notifies the
  // extension over its WS channel so it can clear its local mirror state.
  fastify.post('/reset-rate-limits', async (request, reply) => {
    const parsed = resetRateLimitsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() },
      });
    }
    const { userEmail, userId: bodyUserId, tenantId: bodyTenantId, taskTypes } = parsed.data;

    // Resolve userEmail → userId. Owners can only purge within their own tenant
    // unless they target a tenant they own; the tenant scope below enforces that.
    let resolvedUserId = bodyUserId;
    if (userEmail && !resolvedUserId) {
      const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, userEmail)).limit(1);
      if (!u) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: `No user with email ${userEmail}` },
        });
      }
      resolvedUserId = u.id;
    }

    // Scope = the tenant we run withTenant() under. Default to the caller's
    // tenant; allow override only when the caller explicitly passed tenantId
    // AND it matches their own (the requireRole('owner') check above is
    // tenant-scoped, so a different tenant would already be a 403 in practice).
    const scopeTenantId = bodyTenantId ?? request.tenantId;
    if (scopeTenantId !== request.tenantId) {
      return reply.status(403).send({
        error: { code: 'CROSS_TENANT_DENIED', message: 'Cannot reset rate limits for a different tenant' },
      });
    }

    const result = await withTenant(scopeTenantId, async (tx) => {
      const conds = [isNull(extensionSessions.revokedAt), eq(extensionSessions.tenantId, scopeTenantId)];
      if (resolvedUserId) conds.push(eq(extensionSessions.userId, resolvedUserId));

      // Build the SET clause:
      //  - taskTypes provided → subtract those keys from JSONB.
      //  - Otherwise → reset to '{}'.
      const newDailyTasksCount = (taskTypes && taskTypes.length > 0)
        ? sql`${extensionSessions.dailyTasksCount} - ${sql`ARRAY[${sql.join(taskTypes.map((t) => sql`${t}`), sql`, `)}]::text[]`}`
        : sql`'{}'::jsonb`;

      const rows = await tx.update(extensionSessions)
        .set({
          dailyTasksCount: newDailyTasksCount as unknown as Record<string, number>,
          dailyResetAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(...conds))
        .returning({
          id: extensionSessions.id,
          userId: extensionSessions.userId,
          dailyTasksCount: extensionSessions.dailyTasksCount,
        });

      // Audit log — required for owner-triggered safety-cap purges.
      await tx.insert(agentActivityLog).values({
        tenantId: scopeTenantId,
        masterAgentId: null,
        agentType: 'action',
        action: 'rate_limits_purged',
        status: 'completed',
        details: {
          triggeredBy: request.userId,
          scope: { userEmail: userEmail ?? null, userId: resolvedUserId ?? null, tenantId: scopeTenantId },
          taskTypes: taskTypes ?? null,
          sessionsReset: rows.length,
        },
      });

      return rows;
    });

    // Push WS event so each connected extension clears its chrome.storage mirror immediately.
    // If the extension was offline, it'll reconcile on next reconnect via GET /api/extension/me/rate-limits.
    for (const row of result) {
      try {
        await pubRedis.publish(
          `extension-dispatch:${row.id}`,
          JSON.stringify({ type: 'rate_limits_purged', taskTypes: taskTypes ?? null }),
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: row.id },
          'rate-limit purge: WS notify failed (extension will reconcile on reconnect)',
        );
      }
    }

    return {
      data: {
        sessionsReset: result.length,
        scope: { userEmail: userEmail ?? null, userId: resolvedUserId ?? null, tenantId: scopeTenantId },
        taskTypes: taskTypes ?? null,
        sessions: result,
      },
    };
  });
}
