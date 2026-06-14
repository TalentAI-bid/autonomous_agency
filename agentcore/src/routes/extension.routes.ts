import type { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { eq, and, desc, isNull, sql, gt, inArray } from 'drizzle-orm';
import { db, withTenant } from '../config/database.js';
import { extensionSessions, extensionTasks, users, tenants, contacts, companies, masterAgents, crmActivities } from '../db/schema/index.js';
import { userTenants } from '../db/schema/user-tenants.js';
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
import { sanitizePersonName, EXTENSION_SITE_LIMITS, enqueueExtensionTaskBatch } from '../services/extension-dispatcher.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { dispatchJob } from '../services/queue.service.js';
import { ensureDeal } from '../services/crm-activity.service.js';
import { logEvent } from '../services/timeline.service.js';
import { transitionStage } from '../services/prospect-stage.service.js';
import { ingestGmapsBusiness } from '../services/gmaps-lead.service.js';
import { scoreCompany } from '../services/buyer-fit-score.service.js';
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
  // Multi-workspace: the JWT and refresh token carry only userId. The login
  // response includes every workspace the user is a member of so the popup
  // can show "processing N workspace(s)". The dispatcher fans out across all
  // of them — there is no "active workspace" for the extension.
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
      userId: user.id,
      role: user.role,
    });
    const refreshToken = await generateRefreshToken(user.id);

    const memberships = await db
      .select({
        tenantId: userTenants.tenantId,
        role: userTenants.role,
        isDefault: userTenants.isDefault,
        name: tenants.name,
        slug: tenants.slug,
      })
      .from(userTenants)
      .innerJoin(tenants, eq(tenants.id, userTenants.tenantId))
      .where(eq(userTenants.userId, user.id));

    const workspaces = memberships.map((m) => ({
      id: m.tenantId,
      name: m.name,
      slug: m.slug,
      role: m.role,
      isDefault: m.isDefault,
    }));
    const defaultWorkspace = workspaces.find((w) => w.isDefault) ?? workspaces[0];
    const defaultWorkspaceId = defaultWorkspace?.id ?? user.tenantId;

    logger.info(
      { userId: user.id, workspaceCount: workspaces.length, defaultWorkspaceId },
      'Extension login (multi-workspace)',
    );

    return {
      data: {
        accessToken,
        refreshToken,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        workspaces,
        defaultWorkspaceId,
        // Backwards-compat: older popup builds read `tenant` to render the
        // header line. We surface the default workspace so they keep working
        // until everyone has the new build.
        tenant: defaultWorkspace
          ? { id: defaultWorkspace.id, name: defaultWorkspace.name, slug: defaultWorkspace.slug }
          : undefined,
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
  // Always mints a tenant-less access token, even if the stored refresh blob
  // still carries a legacy tenantId. After one round-trip every client is on
  // the new shape.
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
    // Multi-workspace: a user has at most one active extension session at a
    // time, regardless of which workspace they were "in" when the key was
    // created. Revokes every prior active session for the user before
    // inserting the new (tenant-less) row.
    authScope.post('/generate-key', async (request) => {
      const { key, hash } = generateApiKey();

      // Revoke any existing active session for this user across ALL tenants.
      await db
        .update(extensionSessions)
        .set({ revokedAt: new Date(), connected: false, updatedAt: new Date() })
        .where(
          and(
            eq(extensionSessions.userId, request.userId),
            isNull(extensionSessions.revokedAt),
          ),
        );

      const [session] = await db
        .insert(extensionSessions)
        .values({
          tenantId: null,
          userId: request.userId,
          apiKey: key,
          apiKeyHash: hash,
          connected: false,
          dailyTasksCount: {},
          dailyResetAt: new Date(),
        })
        .returning({ id: extensionSessions.id });

      logger.info(
        { userId: request.userId, sessionId: session!.id },
        'Extension API key generated (multi-workspace session)',
      );
      return { data: { apiKey: key, sessionId: session!.id } };
    });

    // GET /api/extension/status
    // Per-user: returns the active extension session for the authenticated
    // user regardless of which tenant the popup is "in". Also reports how
    // many workspaces the user is a member of so the popup can render
    // "Processing N workspace(s)".
    authScope.get('/status', async (request) => {
      const [session] = await db
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
            eq(extensionSessions.userId, request.userId),
            isNull(extensionSessions.revokedAt),
          ),
        )
        .orderBy(desc(extensionSessions.createdAt))
        .limit(1);

      const [{ count: workspaceCount = 0 } = { count: 0 }] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(userTenants)
        .where(eq(userTenants.userId, request.userId));

      // Depth of the queued/in-flight extension work for the ACTIVE workspace —
      // drives the "Stop & clear queued tasks" control.
      const pendingTaskCount = await withTenant(request.tenantId, async (tx) => {
        const [row] = await tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(extensionTasks)
          .where(and(
            eq(extensionTasks.tenantId, request.tenantId),
            inArray(extensionTasks.status, ['pending', 'dispatched']),
          ));
        return row?.count ?? 0;
      });

      if (!session) {
        return {
          data: {
            hasKey: false,
            connected: false,
            lastSeenAt: null,
            dailyTasksCount: {},
            dailyResetAt: null,
            workspaceCount,
            pendingTaskCount,
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
          workspaceCount,
          pendingTaskCount,
        },
      };
    });

    // GET /api/extension/me/rate-limits
    // Authoritative server-side counter snapshot — the extension calls this
    // on WS reconnect to reconcile its chrome.storage rateLimiterState in
    // case it missed a `rate_limits_purged` push while offline. The counter
    // lives on the user's single extension_sessions row, so it is naturally
    // a per-user (per-LinkedIn-account) cap — one quota across all the
    // workspaces the user processes.
    authScope.get('/me/rate-limits', async (request) => {
      const [session] = await db
        .select({
          dailyTasksCount: extensionSessions.dailyTasksCount,
          dailyResetAt: extensionSessions.dailyResetAt,
        })
        .from(extensionSessions)
        .where(
          and(
            eq(extensionSessions.userId, request.userId),
            isNull(extensionSessions.revokedAt),
          ),
        )
        .orderBy(desc(extensionSessions.createdAt))
        .limit(1);
      return {
        data: {
          dailyCounts: session?.dailyTasksCount ?? {},
          dailyResetAt: session?.dailyResetAt ?? null,
          caps: EXTENSION_SITE_LIMITS,
        },
      };
    });

    // POST /api/extension/revoke
    // Revokes the user's extension session across all tenants.
    authScope.post('/revoke', async (request) => {
      const now = new Date();
      const revoked = await db
        .update(extensionSessions)
        .set({ revokedAt: now, connected: false, updatedAt: now })
        .where(
          and(
            eq(extensionSessions.userId, request.userId),
            isNull(extensionSessions.revokedAt),
          ),
        )
        .returning({ id: extensionSessions.id });

      for (const r of revoked) {
        // Ask the WS layer (on any node) to close the socket
        await pubRedis.publish(`extension-dispatch:${r.id}`, JSON.stringify({ type: 'revoked' }));
      }

      return { data: { ok: true, revokedCount: revoked.length } };
    });

    // POST /api/extension/tasks/cancel-pending
    // Stop & clear all queued/in-flight extension tasks for the ACTIVE
    // workspace. Unlike /revoke (which kills the session but leaves tasks to
    // re-dispatch after re-pairing), this cancels the work itself so the
    // extension goes quiet. Used by the "Stop & clear queued tasks" control.
    authScope.post('/tasks/cancel-pending', async (request) => {
      const cancelled = await withTenant(request.tenantId, async (tx) => {
        return tx.update(extensionTasks)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(
            eq(extensionTasks.tenantId, request.tenantId),
            inArray(extensionTasks.status, ['pending', 'dispatched']),
          ))
          .returning({ id: extensionTasks.id });
      });

      // Tell any connected session to drop whatever it's currently running.
      const sessions = await db
        .select({ id: extensionSessions.id })
        .from(extensionSessions)
        .where(and(
          eq(extensionSessions.userId, request.userId),
          isNull(extensionSessions.revokedAt),
        ));
      for (const s of sessions) {
        await pubRedis.publish(`extension-dispatch:${s.id}`, JSON.stringify({ type: 'cancel' }));
      }

      return { data: { ok: true, cancelledCount: cancelled.length } };
    });

    // GET /api/extension/me/workspaces
    // The set of workspaces the user can be dispatched tasks from. Used by
    // the popup ("Processing N workspace(s)") and any future UI that needs
    // to show membership.
    authScope.get('/me/workspaces', async (request) => {
      const rows = await db
        .select({
          tenantId: userTenants.tenantId,
          role: userTenants.role,
          isDefault: userTenants.isDefault,
          name: tenants.name,
          slug: tenants.slug,
        })
        .from(userTenants)
        .innerJoin(tenants, eq(tenants.id, userTenants.tenantId))
        .where(eq(userTenants.userId, request.userId));
      return {
        data: {
          workspaces: rows.map((r) => ({
            id: r.tenantId,
            name: r.name,
            slug: r.slug,
            role: r.role,
            isDefault: r.isDefault,
          })),
        },
      };
    });

    // POST /api/extension/me/workspaces/:tenantId/set-default
    // Flip is_default to a single tenant for the authenticated user.
    authScope.post<{ Params: { tenantId: string } }>(
      '/me/workspaces/:tenantId/set-default',
      async (request) => {
        const target = request.params.tenantId;
        const [m] = await db
          .select({ id: userTenants.id })
          .from(userTenants)
          .where(and(eq(userTenants.userId, request.userId), eq(userTenants.tenantId, target)))
          .limit(1);
        if (!m) throw new ValidationError('Not a member of the requested workspace');

        await db.transaction(async (tx) => {
          await tx
            .update(userTenants)
            .set({ isDefault: false })
            .where(eq(userTenants.userId, request.userId));
          await tx
            .update(userTenants)
            .set({ isDefault: true })
            .where(and(eq(userTenants.userId, request.userId), eq(userTenants.tenantId, target)));
        });

        return { data: { ok: true, defaultWorkspaceId: target } };
      },
    );

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
      // What to do once the contact is ensured under the matching agent(s)/company:
      //   'add'           — just create/link (default)
      //   'connected'     — also log a LinkedIn connection-accepted (analytics)
      //   'accepted_lead' — also mark qualified + advance prospect stage
      action: z.enum(['add', 'connected', 'accepted_lead']).default('add'),
    });

    authScope.post('/contacts/manual', async (request, reply) => {
      const parsed = manualContactSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const { name, title, companyName, linkedinUrl, masterAgentId: overrideAgentId, action } = parsed.data;

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
            try {
              await scoreCompany({
                tenantId: request.tenantId,
                companyId: savedCompany.id,
                masterAgentId: overrideAgentId,
              });
            } catch (err) {
              logger.warn(
                { err: err instanceof Error ? err.message : String(err), companyId: savedCompany.id },
                'manual_add_profile: triage failed (non-fatal)',
              );
            }
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
            try {
              await scoreCompany({
                tenantId: request.tenantId,
                companyId: savedCompany.id,
                masterAgentId: best.id,
              });
            } catch (err) {
              logger.warn(
                { err: err instanceof Error ? err.message : String(err), companyId: savedCompany.id },
                'manual_add_profile: triage failed (non-fatal, fallback path)',
              );
            }
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

          // Backfill any fields the original create may have missed OR
          // poisoned with junk from the previous (broken) scraper.
          //   - Empty/null values: backfill with current payload
          //   - Values containing scraper junk ("Verified", "View profile")
          //     that we know are wrong: overwrite with current payload
          //   - Otherwise: keep what's there (user may have edited it)
          const isJunky = (v: string | null | undefined) =>
            !v
            || /\b(?:View|Verified|profile)\b/i.test(v)
            || /\bverifications?\b/i.test(v);

          const patch: Partial<typeof contacts.$inferInsert> = {};
          if (t.companyId && existing.companyId !== t.companyId) patch.companyId = t.companyId;
          if (companyName?.trim() && isJunky(existing.companyName)) patch.companyName = companyName.trim();
          if (title?.trim() && isJunky(existing.title)) patch.title = title.trim();
          if (firstName && isJunky(existing.firstName)) patch.firstName = firstName;
          if (lastName && isJunky(existing.lastName)) patch.lastName = lastName;

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

      // Apply the requested post-add action to every contact row the fan-out
      // produced (one per matched agent). 'add' is a no-op beyond the linking
      // already done above.
      if (action !== 'add') {
        for (const r of results) {
          try {
            if (action === 'connected') {
              // Dedupe: skip if a connection-accepted was logged for this
              // contact in the last 60s (repeat clicks).
              const recentCutoff = new Date(Date.now() - 60_000);
              const [recent] = await withTenant(request.tenantId, async (tx) => {
                return tx.select({ id: crmActivities.id })
                  .from(crmActivities)
                  .where(and(
                    eq(crmActivities.tenantId, request.tenantId),
                    eq(crmActivities.contactId, r.contactId),
                    eq(crmActivities.type, 'linkedin_connection_accepted'),
                    gt(crmActivities.occurredAt, recentCutoff),
                  ))
                  .limit(1);
              });
              if (!recent) {
                await logEvent({
                  tenantId: request.tenantId,
                  contactId: r.contactId,
                  type: 'linkedin_connection_accepted',
                  eventCategory: 'response',
                  actorType: 'user',
                  actorUserId: request.userId,
                  title: 'LinkedIn connection accepted',
                  metadata: { via: 'extension', linkedinUrl },
                });
              }
            } else if (action === 'accepted_lead') {
              await withTenant(request.tenantId, async (tx) => {
                await tx.update(contacts)
                  .set({ status: 'qualified', updatedAt: new Date() })
                  .where(and(eq(contacts.id, r.contactId), eq(contacts.tenantId, request.tenantId)));
              });
              await transitionStage({
                tenantId: request.tenantId,
                contactId: r.contactId,
                toStage: 'qualified',
                actorType: 'user',
                actorUserId: request.userId,
                reason: 'Accepted lead via extension',
              });
            }
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : String(err), contactId: r.contactId, action },
              'manual_add_profile: post-add action failed (non-fatal)',
            );
          }
        }
      }

      logger.info({
        linkedinUrl,
        userId: request.userId,
        action,
        agentCount: results.length,
        agents: results.map((r) => r.agentName),
      }, 'manual_add_profile: completed fan-out');

      return reply.send({
        data: {
          rows: results,
          action,
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

    // POST /api/extension/gmaps/capture
    // User-triggered capture from the Google Maps in-page panel. The panel
    // sends the normalized BusinessRecords produced by the extension's
    // maps-core module; each becomes company + business-contact + Lead-stage
    // deal via the shared gmaps-lead service (same rows as the
    // server-dispatched gmaps ingestion path).
    const gmapsCaptureSchema = z.object({
      searchQuery: z.string().max(300).optional(),
      location: z.string().max(200).optional(),
      businesses: z.array(z.object({
        name: z.string().min(1).max(300),
        category: z.string().max(200).optional(),
        address: z.string().max(500).optional(),
        phone: z.string().max(64).nullable().optional(),
        website: z.string().max(500).nullable().optional(),
        rating: z.number().nullable().optional(),
        reviewCount: z.number().int().nullable().optional(),
        mapsUrl: z.string().max(1000).optional(),
        // Place-detail fields (present when the record came from a detail scrape).
        hours: z.union([z.string().max(2000), z.record(z.string().max(200))]).nullable().optional(),
        priceLevel: z.string().max(60).nullable().optional(),
        description: z.string().max(4000).nullable().optional(),
        serviceOptions: z.array(z.string().max(60)).max(20).nullable().optional(),
        plusCode: z.string().max(60).nullable().optional(),
        coordinates: z.object({ lat: z.number(), lng: z.number() }).nullable().optional(),
        menuLink: z.string().max(1000).nullable().optional(),
        photoUrls: z.array(z.string().max(1000)).max(10).nullable().optional(),
        pricePerPerson: z.string().max(60).nullable().optional(),
        directionsUrl: z.string().max(300).nullable().optional(),
        reviewsHtml: z.string().max(50000).nullable().optional(),
        ratingDistribution: z.array(z.object({ label: z.string().max(200) })).max(10).nullable().optional(),
        aboutHtml: z.string().max(25000).nullable().optional(),
        detailFetched: z.boolean().optional(),
      })).min(1).max(100),
    });

    authScope.post('/gmaps/capture', async (request, reply) => {
      const parsed = gmapsCaptureSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
      const { businesses, searchQuery, location } = parsed.data;

      type CaptureRow = { name: string; mapsUrl?: string; status: 'saved' | 'duplicate' | 'error'; contactId?: string; dealId?: string; companyId?: string; error?: string };
      const results: CaptureRow[] = [];
      // Businesses still needing a place-detail scrape (phone/hours/menu). The
      // panel sends thin search-card records; we open each place page in the
      // user's connected extension to capture the full data set.
      const detailFanout: Array<{ site: 'gmaps'; type: 'fetch_business'; params: Record<string, unknown>; priority: number }> = [];

      for (const b of businesses) {
        try {
          const r = await ingestGmapsBusiness(
            request.tenantId,
            undefined, // no master agent attachment for manual captures
            { ...b, searchQuery, location },
            request.userId,
          );
          const { needsDetail, ...row } = r;
          results.push({ name: b.name, mapsUrl: b.mapsUrl, ...row });
          if (needsDetail && b.mapsUrl) {
            detailFanout.push({ site: 'gmaps', type: 'fetch_business', params: { mapsUrl: b.mapsUrl }, priority: 6 });
          }
        } catch (err) {
          results.push({
            name: b.name,
            mapsUrl: b.mapsUrl,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (detailFanout.length > 0) {
        try {
          await enqueueExtensionTaskBatch(request.tenantId, detailFanout);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), count: detailFanout.length },
            'gmaps_capture: fetch_business fanout enqueue failed (non-fatal)',
          );
        }
      }

      const saved = results.filter((r) => r.status === 'saved').length;
      const duplicate = results.filter((r) => r.status === 'duplicate').length;

      logger.info({
        userId: request.userId,
        tenantId: request.tenantId,
        searchQuery,
        location,
        total: businesses.length,
        saved,
        duplicate,
      }, 'gmaps_capture: completed');

      return reply.send({ data: { results, saved, duplicate } });
    });
  });
}
