import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { db, withTenant } from '../config/database.js';
import { extensionSessions, extensionTasks, users, tenants } from '../db/schema/index.js';
import {
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
} from '../services/auth.service.js';
import { ValidationError, UnauthorizedError } from '../utils/errors.js';
import { pubRedis } from '../queues/setup.js';
import { env } from '../config/env.js';
import { readLatest } from './extension-distribution.routes.js';
import logger from '../utils/logger.js';

function generateApiKey(): { key: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('hex');
  const key = `tai_ext_${raw}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, hash };
}

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export default async function extensionRoutes(fastify: FastifyInstance) {
  // ─── Public (pre-auth) extension endpoints ───────────────────────────────
  // These are reachable without a JWT. They return tokens in the JSON body
  // because Chrome MV3 extensions cannot reliably use httpOnly cookies from
  // a service worker across origins.

  // POST /api/extension/auth/login   { email, password }
  fastify.post('/auth/login', async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', parsed.error.flatten());
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    const accessToken = generateAccessToken(fastify, {
      tenantId: user.tenantId,
      userId: user.id,
      role: user.role,
    });
    const refreshToken = await generateRefreshToken(user.id, user.tenantId);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);

    logger.info({ userId: user.id, tenantId: user.tenantId }, 'Extension login');

    return {
      data: {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : undefined,
      },
    };
  });

  // GET /api/extension/latest — shareable download link.
  // 302-redirects to the signed ZIP of the current release so users can click
  // this URL directly (from emails, docs, etc.) and get the file.
  fastify.get('/latest', async (_request, reply) => {
    try {
      const latest = await readLatest();
      const zipUrl = `${env.PUBLIC_API_URL}/extension/talentai-v${latest.version}.zip`;
      return reply.redirect(zipUrl, 302);
    } catch (err) {
      logger.warn({ err }, 'Extension latest.json not available');
      return reply.code(503).send({ error: 'No extension release available yet' });
    }
  });

  // GET /api/extension/latest/info — JSON metadata for the dashboard install page.
  fastify.get('/latest/info', async (_request, reply) => {
    try {
      const latest = await readLatest();
      return {
        data: {
          version: latest.version,
          extensionId: latest.extensionId,
          zipUrl: `${env.PUBLIC_API_URL}/extension/talentai-v${latest.version}.zip`,
          crxUrl: `${env.PUBLIC_API_URL}/extension/talentai-v${latest.version}.crx`,
          downloadUrl: `${env.PUBLIC_API_URL}/api/extension/latest`,
          releaseNotes: latest.releaseNotes ?? '',
          releasedAt: latest.releasedAt ?? null,
          sizeBytes: latest.sizeBytes ?? null,
        },
      };
    } catch (err) {
      logger.warn({ err }, 'Extension latest.json not available');
      return reply.code(503).send({ error: 'No extension release available yet' });
    }
  });

  // POST /api/extension/event — lightweight telemetry hook.
  fastify.post('/event', async (request) => {
    const body = (request.body ?? {}) as { event?: string; version?: string };
    logger.info(
      { event: body.event, version: body.version },
      'Extension event',
    );
    return { data: { ok: true } };
  });

  // POST /api/extension/auth/refresh   { refreshToken }
  fastify.post('/auth/refresh', async (request) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', parsed.error.flatten());
    }

    const result = await rotateRefreshToken(parsed.data.refreshToken);
    if (!result) throw new UnauthorizedError('Invalid refresh token');

    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    if (!user) throw new UnauthorizedError('User not found');

    const accessToken = generateAccessToken(fastify, {
      tenantId: result.tenantId,
      userId: result.userId,
      role: user.role,
    });

    return {
      data: {
        accessToken,
        refreshToken: result.newToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      },
    };
  });

  // ─── Protected (JWT-required) extension endpoints ────────────────────────
  await fastify.register(async (authScope) => {
    authScope.addHook('onRequest', fastify.authenticate);

    // POST /api/extension/generate-key
    authScope.post('/generate-key', async (request) => {
      const { key, hash } = generateApiKey();

      const [session] = await withTenant(request.tenantId, async (tx) => {
        // Revoke any existing active session for this user
        await tx
          .update(extensionSessions)
          .set({ revokedAt: new Date(), connected: false, updatedAt: new Date() })
          .where(
            and(
              eq(extensionSessions.tenantId, request.tenantId),
              eq(extensionSessions.userId, request.userId),
              isNull(extensionSessions.revokedAt),
            ),
          );

        return tx
          .insert(extensionSessions)
          .values({
            tenantId: request.tenantId,
            userId: request.userId,
            apiKey: key,
            apiKeyHash: hash,
            connected: false,
            dailyTasksCount: {},
            dailyResetAt: new Date(),
          })
          .returning({ id: extensionSessions.id });
      });

      logger.info(
        { tenantId: request.tenantId, userId: request.userId, sessionId: session!.id },
        'Extension API key generated',
      );
      return { data: { apiKey: key, sessionId: session!.id } };
    });

    // GET /api/extension/status
    authScope.get('/status', async (request) => {
      const [session] = await withTenant(request.tenantId, async (tx) => {
        return tx
          .select({
            id: extensionSessions.id,
            connected: extensionSessions.connected,
            lastSeenAt: extensionSessions.lastSeenAt,
            dailyTasksCount: extensionSessions.dailyTasksCount,
            dailyResetAt: extensionSessions.dailyResetAt,
          })
          .from(extensionSessions)
          .where(
            and(
              eq(extensionSessions.tenantId, request.tenantId),
              eq(extensionSessions.userId, request.userId),
              isNull(extensionSessions.revokedAt),
            ),
          )
          .orderBy(desc(extensionSessions.createdAt))
          .limit(1);
      });

      if (!session) {
        return {
          data: {
            hasKey: false,
            connected: false,
            lastSeenAt: null,
            dailyTasksCount: {},
            dailyResetAt: null,
          },
        };
      }

      return {
        data: {
          hasKey: true,
          connected: session.connected,
          lastSeenAt: session.lastSeenAt,
          dailyTasksCount: session.dailyTasksCount ?? {},
          dailyResetAt: session.dailyResetAt,
        },
      };
    });

    // POST /api/extension/revoke
    authScope.post('/revoke', async (request) => {
      const now = new Date();
      const revoked = await withTenant(request.tenantId, async (tx) => {
        return tx
          .update(extensionSessions)
          .set({ revokedAt: now, connected: false, updatedAt: now })
          .where(
            and(
              eq(extensionSessions.tenantId, request.tenantId),
              eq(extensionSessions.userId, request.userId),
              isNull(extensionSessions.revokedAt),
            ),
          )
          .returning({ id: extensionSessions.id });
      });

      for (const r of revoked) {
        // Ask the WS layer (on any node) to close the socket
        await pubRedis.publish(`extension-dispatch:${r.id}`, JSON.stringify({ type: 'revoked' }));
      }

      return { data: { ok: true, revokedCount: revoked.length } };
    });

    // GET /api/extension/tasks/recent?limit=50
    // Returns the full params + result blobs so the dashboard can show what
    // each task actually sent and received — this is how you debug "why did
    // 11 LinkedIn searches save zero companies?".
    authScope.get<{ Querystring: { limit?: string } }>('/tasks/recent', async (request) => {
      const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
      const rows = await withTenant(request.tenantId, async (tx) => {
        return tx
          .select({
            id: extensionTasks.id,
            site: extensionTasks.site,
            type: extensionTasks.type,
            status: extensionTasks.status,
            priority: extensionTasks.priority,
            attempts: extensionTasks.attempts,
            error: extensionTasks.error,
            params: extensionTasks.params,
            result: extensionTasks.result,
            createdAt: extensionTasks.createdAt,
            dispatchedAt: extensionTasks.dispatchedAt,
            completedAt: extensionTasks.completedAt,
          })
          .from(extensionTasks)
          .where(eq(extensionTasks.tenantId, request.tenantId))
          .orderBy(desc(extensionTasks.createdAt))
          .limit(limit);
      });

      // Cheap derived summary so the dashboard doesn't have to reimplement
      // the result-shape logic (linkedin.companies vs gmaps.businesses etc.).
      const tasks = rows.map((t) => {
        const r = (t.result ?? {}) as Record<string, unknown>;
        const itemCount =
          Array.isArray(r.companies) ? r.companies.length :
          Array.isArray(r.businesses) ? r.businesses.length :
          0;
        return { ...t, itemCount };
      });

      return { data: { tasks, count: tasks.length } };
    });
  });
}
