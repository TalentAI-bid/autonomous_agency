import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { db, withTenant } from '../config/database.js';
import { extensionSessions, extensionTasks, users, tenants, contacts, companies, masterAgents } from '../db/schema/index.js';
import {
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
} from '../services/auth.service.js';
import { ValidationError, UnauthorizedError, NotFoundError } from '../utils/errors.js';
import { pubRedis } from '../queues/setup.js';
import { env } from '../config/env.js';
import { readLatest } from './extension-distribution.routes.js';
import { sanitizePersonName } from '../services/extension-dispatcher.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { dispatchJob } from '../services/queue.service.js';
import { ensureDeal } from '../services/crm-activity.service.js';
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

    // POST /api/extension/contacts/manual
    // Snov.io-style manual add from a LinkedIn /in/ profile.
    //
    // Fan-out routing:
    //   - Find every company in this tenant matching the scraped name AND
    //     owned (via master_agents.created_by) by the current extension user.
    //   - For each match, ensure (contact, deal) under that master agent.
    //   - If no company match, fall back to the user's most-active agent
    //     (one row only).
    //
    // Each row gets its own Lead-stage CRM deal so the contact appears on
    // every pipeline + every company team list it belongs to.
    const manualContactSchema = z.object({
      name: z.string().min(1).max(200),
      title: z.string().max(255).optional(),
      companyName: z.string().max(255).optional(),
      linkedinUrl: z.string().url().max(500),
      masterAgentId: z.string().uuid().optional(),
    });

    authScope.post('/contacts/manual', async (request, reply) => {
      const parsed = manualContactSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const { name, title, companyName, linkedinUrl, masterAgentId: overrideAgentId } = parsed.data;

      const cleanName = sanitizePersonName(name);
      if (!cleanName) {
        throw new ValidationError('Could not parse a valid person name from input');
      }
      const parts = cleanName.split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ') || '';
      if (!firstName) {
        throw new ValidationError('Person name is missing a first name');
      }

      // ─── Step 1: collect target (agent, companyId) pairs ───────────
      type Target = { masterAgentId: string; companyId: string | undefined; agentName: string; reason: 'override' | 'company_match' | 'most_active' | 'oldest' };
      const targets: Target[] = [];

      if (overrideAgentId) {
        const [agent] = await withTenant(request.tenantId, async (tx) => {
          return tx.select().from(masterAgents)
            .where(and(eq(masterAgents.id, overrideAgentId), eq(masterAgents.tenantId, request.tenantId)))
            .limit(1);
        });
        if (!agent) throw new NotFoundError('Master agent', overrideAgentId);
        let companyId: string | undefined;
        if (companyName?.trim()) {
          try {
            const savedCompany = await saveOrUpdateCompanyStatic(
              request.tenantId,
              { name: companyName.trim(), rawData: { source: 'linkedin_manual_extension' } },
              overrideAgentId,
            );
            companyId = savedCompany.id;
          } catch (err) {
            logger.warn({ err: err instanceof Error ? err.message : String(err), companyName }, 'manual_add_profile: company create failed');
          }
        }
        targets.push({ masterAgentId: overrideAgentId, companyId, agentName: agent.name, reason: 'override' });
      } else if (companyName?.trim()) {
        // Find every company in tenant matching name (case-insensitive),
        // restricted to master agents created by the current user. Each
        // match gives us one (agent, companyId) target.
        const matches = await withTenant(request.tenantId, async (tx) => {
          return tx.select({
            companyId: companies.id,
            masterAgentId: companies.masterAgentId,
            agentName: masterAgents.name,
          })
            .from(companies)
            .innerJoin(masterAgents, eq(masterAgents.id, companies.masterAgentId))
            .where(and(
              eq(companies.tenantId, request.tenantId),
              eq(masterAgents.tenantId, request.tenantId),
              eq(masterAgents.createdBy, request.userId),
              sql`LOWER(${companies.name}) = LOWER(${companyName.trim()})`,
            ));
        });
        for (const m of matches) {
          if (!m.masterAgentId) continue;
          targets.push({
            masterAgentId: m.masterAgentId,
            companyId: m.companyId,
            agentName: m.agentName,
            reason: 'company_match',
          });
        }
        logger.info({ companyName, matches: targets.length }, 'manual_add_profile: company-match fan-out');
      }

      // No company-match results → fall back to the user's most-active agent.
      if (targets.length === 0) {
        const candidates = await withTenant(request.tenantId, async (tx) => {
          return tx.select({
            id: masterAgents.id,
            name: masterAgents.name,
            createdAt: masterAgents.createdAt,
            lastContactAt: sql<Date | null>`(
              SELECT MAX(${contacts.createdAt}) FROM ${contacts}
              WHERE ${contacts.masterAgentId} = ${masterAgents.id}
            )`,
          })
          .from(masterAgents)
          .where(and(
            eq(masterAgents.tenantId, request.tenantId),
            eq(masterAgents.createdBy, request.userId),
          ))
          .orderBy(
            sql`(SELECT MAX(${contacts.createdAt}) FROM ${contacts} WHERE ${contacts.masterAgentId} = ${masterAgents.id}) DESC NULLS LAST`,
            masterAgents.createdAt,
          )
          .limit(1);
        });
        const best = candidates[0];
        if (!best) {
          throw new ValidationError('No master agent owned by you in this workspace — create one first.');
        }
        let companyId: string | undefined;
        if (companyName?.trim()) {
          try {
            const savedCompany = await saveOrUpdateCompanyStatic(
              request.tenantId,
              { name: companyName.trim(), rawData: { source: 'linkedin_manual_extension' } },
              best.id,
            );
            companyId = savedCompany.id;
          } catch (err) {
            logger.warn({ err: err instanceof Error ? err.message : String(err), companyName }, 'manual_add_profile: company create failed (fallback path)');
          }
        }
        targets.push({
          masterAgentId: best.id,
          companyId,
          agentName: best.name,
          reason: best.lastContactAt ? 'most_active' : 'oldest',
        });
        logger.info({ masterAgentId: best.id, reason: best.lastContactAt ? 'most_active' : 'oldest' }, 'manual_add_profile: routed via auto-pick fallback');
      }

      // ─── Step 2: insert one (contact, deal) per target ────────────
      type RowResult = {
        contactId: string;
        dealId: string;
        masterAgentId: string;
        agentName: string;
        companyId: string | undefined;
        reason: Target['reason'];
        dedup: boolean;
      };
      const results: RowResult[] = [];

      for (const t of targets) {
        // Dedup by (linkedinUrl + masterAgentId) — same person can exist
        // under multiple agents, but only once per agent.
        const [existing] = await withTenant(request.tenantId, async (tx) => {
          return tx.select({
            id: contacts.id,
            companyId: contacts.companyId,
            companyName: contacts.companyName,
            title: contacts.title,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
          }).from(contacts)
            .where(and(
              eq(contacts.tenantId, request.tenantId),
              eq(contacts.linkedinUrl, linkedinUrl),
              eq(contacts.masterAgentId, t.masterAgentId),
            ))
            .limit(1);
        });

        let contactId: string;
        let dedup = false;
        if (existing) {
          contactId = existing.id;
          dedup = true;

          // Backfill any fields the original create may have missed.
          // E.g. early manual-add saves had no company extraction, so the
          // contact's companyId is NULL even though the company now exists.
          // Without this update the contact won't show on the company's
          // People tab in the dashboard.
          const patch: Partial<typeof contacts.$inferInsert> = {};
          if (t.companyId && existing.companyId !== t.companyId) patch.companyId = t.companyId;
          if (companyName?.trim() && !existing.companyName) patch.companyName = companyName.trim();
          if (title?.trim() && !existing.title) patch.title = title.trim();
          if (firstName && !existing.firstName) patch.firstName = firstName;
          if (lastName && !existing.lastName) patch.lastName = lastName;

          if (Object.keys(patch).length > 0) {
            patch.updatedAt = new Date();
            await withTenant(request.tenantId, async (tx) => {
              return tx.update(contacts)
                .set(patch)
                .where(and(
                  eq(contacts.id, existing.id),
                  eq(contacts.tenantId, request.tenantId),
                ));
            });
            logger.info({ contactId, patched: Object.keys(patch) }, 'manual_add_profile: backfilled fields on dedup');
          }
        } else {
          const [inserted] = await withTenant(request.tenantId, async (tx) => {
            return tx.insert(contacts).values({
              tenantId: request.tenantId,
              firstName,
              lastName: lastName || undefined,
              title: title?.trim() || undefined,
              linkedinUrl,
              companyId: t.companyId,
              companyName: companyName?.trim() || undefined,
              masterAgentId: t.masterAgentId,
              source: 'linkedin_profile',
              rawData: {
                discoverySource: 'linkedin_manual_extension',
                addedByUser: true,
                addedAt: new Date().toISOString(),
                routeReason: t.reason,
              },
            }).returning({ id: contacts.id });
          });
          if (!inserted) {
            logger.warn({ masterAgentId: t.masterAgentId, linkedinUrl }, 'manual_add_profile: contact insert returned no row, skipping');
            continue;
          }
          contactId = inserted.id;
        }

        const deal = await ensureDeal({
          tenantId: request.tenantId,
          contactId,
          masterAgentId: t.masterAgentId,
        });

        try {
          await dispatchJob(request.tenantId, 'enrichment', {
            contactId,
            masterAgentId: t.masterAgentId,
            source: 'linkedin_manual_extension',
          });
        } catch (err) {
          logger.debug({ err, contactId }, 'manual_add_profile: enrichment dispatch failed (non-fatal)');
        }

        results.push({
          contactId,
          dealId: deal.id,
          masterAgentId: t.masterAgentId,
          agentName: t.agentName,
          companyId: t.companyId,
          reason: t.reason,
          dedup,
        });
      }

      logger.info({
        linkedinUrl,
        userId: request.userId,
        agentCount: results.length,
        agents: results.map((r) => r.agentName),
      }, 'manual_add_profile: completed fan-out');

      return reply.send({
        data: {
          rows: results,
          // Backward-compat fields — first row is the "primary"
          contactId: results[0]?.contactId,
          dealId: results[0]?.dealId,
          dealCreated: false,
          dealStage: 'lead',
          dedup: !!results[0]?.dedup,
          masterAgentId: results[0]?.masterAgentId,
          masterAgentName: results[0]?.agentName,
          routeReason: results[0]?.reason,
          companyId: results[0]?.companyId,
        },
      });
    });
  });
}
