import { eq, and, asc, desc, isNull } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, contacts, extensionSessions, extensionTasks, masterAgents } from '../db/schema/index.js';
import type { ExtensionTask } from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import { dispatchJob } from './queue.service.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import logger from '../utils/logger.js';

// ─── Rate limits (server-authoritative; client mirrors these) ──────────────

export type ExtensionSite = 'linkedin' | 'gmaps' | 'crunchbase';
export type ExtensionTaskType = 'search_companies' | 'fetch_company' | 'search_businesses' | 'fetch_business';

export const EXTENSION_SITE_LIMITS = {
  linkedin: {
    search_companies: { dailyCap: 10, minDelayMs: 4000 },
    fetch_company: { dailyCap: 100, minDelayMs: 4000 },
  },
  gmaps: {
    search_businesses: { dailyCap: 20, minDelayMs: 2000 },
    fetch_business: { dailyCap: 200, minDelayMs: 2000 },
  },
  crunchbase: {
    search_companies: { dailyCap: 10, minDelayMs: 5000 },
    fetch_company: { dailyCap: 50, minDelayMs: 5000 },
  },
} as const;

function getLimit(site: ExtensionSite, type: ExtensionTaskType): { dailyCap: number; minDelayMs: number } | undefined {
  const siteLimits = EXTENSION_SITE_LIMITS[site] as Record<string, { dailyCap: number; minDelayMs: number } | undefined>;
  return siteLimits?.[type];
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

export async function enqueueExtensionTask(params: {
  tenantId: string;
  masterAgentId?: string;
  site: ExtensionSite;
  type: ExtensionTaskType;
  params: Record<string, unknown>;
  priority?: number;
}): Promise<{ taskId: string }> {
  const [row] = await withTenant(params.tenantId, async (tx) => {
    return tx
      .insert(extensionTasks)
      .values({
        tenantId: params.tenantId,
        masterAgentId: params.masterAgentId,
        site: params.site,
        type: params.type,
        params: params.params ?? {},
        priority: params.priority ?? 5,
        status: 'pending',
      })
      .returning({ id: extensionTasks.id });
  });
  const taskId = row!.id;

  // Fire-and-forget immediate dispatch attempt (don't block the caller)
  tryDispatch(params.tenantId, taskId).catch((err) => {
    logger.debug({ err, taskId }, 'Extension task immediate dispatch failed (will retry on reconnect)');
  });

  return { taskId };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function tryDispatch(tenantId: string, taskId: string): Promise<boolean> {
  // Load active session + task
  const result = await withTenant(tenantId, async (tx) => {
    const [task] = await tx
      .select()
      .from(extensionTasks)
      .where(and(eq(extensionTasks.id, taskId), eq(extensionTasks.tenantId, tenantId)))
      .limit(1);
    if (!task || task.status !== 'pending') return { task: null, session: null };

    const [session] = await tx
      .select()
      .from(extensionSessions)
      .where(
        and(
          eq(extensionSessions.tenantId, tenantId),
          eq(extensionSessions.connected, true),
          isNull(extensionSessions.revokedAt),
        ),
      )
      .orderBy(desc(extensionSessions.lastSeenAt))
      .limit(1);
    return { task, session: session ?? null };
  });

  if (!result.task || !result.session) return false;

  const { task, session } = result;

  // Skip dispatch if the owning master agent is paused
  if (task.masterAgentId) {
    const [agentRow] = await withTenant(tenantId, async (tx) => {
      return tx.select({ status: masterAgents.status })
        .from(masterAgents)
        .where(eq(masterAgents.id, task.masterAgentId as string))
        .limit(1);
    });
    if (agentRow?.status === 'paused') {
      logger.info({ taskId, masterAgentId: task.masterAgentId }, 'Skipped dispatch — master agent is paused');
      return false;
    }
  }

  const limit = getLimit(task.site as ExtensionSite, task.type as ExtensionTaskType);
  const key = `${task.site}:${task.type}`;

  // Reset daily counters if dailyResetAt older than 24h
  const now = new Date();
  const resetAt = session.dailyResetAt ? new Date(session.dailyResetAt) : new Date(0);
  const needsReset = now.getTime() - resetAt.getTime() > 24 * 60 * 60 * 1000;
  const counts: Record<string, number> = needsReset
    ? {}
    : { ...((session.dailyTasksCount as Record<string, number>) ?? {}) };

  const used = counts[key] ?? 0;
  if (limit && used >= limit.dailyCap) {
    logger.info({ taskId, tenantId, site: task.site, type: task.type, used, cap: limit.dailyCap }, 'rate_limit_hit');
    return false;
  }

  // Look up the master-agent name (for popup display) — optional, cheap
  let masterAgentName: string | null = null;
  if (task.masterAgentId) {
    const [agentRow] = await withTenant(tenantId, async (tx) => {
      return tx
        .select({ name: masterAgents.name })
        .from(masterAgents)
        .where(eq(masterAgents.id, task.masterAgentId as string))
        .limit(1);
    });
    masterAgentName = agentRow?.name ?? null;
  }

  // Mark dispatched + bump counter
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(extensionTasks)
      .set({
        status: 'dispatched',
        sessionId: session.id,
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(eq(extensionTasks.id, task.id));

    counts[key] = used + 1;
    await tx
      .update(extensionSessions)
      .set({
        dailyTasksCount: counts,
        dailyResetAt: needsReset ? now : session.dailyResetAt,
        updatedAt: now,
      })
      .where(eq(extensionSessions.id, session.id));
  });

  // Publish to the extension's Redis channel
  const payload = JSON.stringify({
    type: 'task',
    taskId: task.id,
    site: task.site,
    taskType: task.type,
    params: task.params,
    requestedAt: now.toISOString(),
    masterAgentId: task.masterAgentId ?? null,
    masterAgentName,
  });
  await pubRedis.publish(`extension-dispatch:${session.id}`, payload);

  logger.info({ taskId: task.id, tenantId, sessionId: session.id, site: task.site, type: task.type }, 'Extension task dispatched');
  return true;
}

// ─── Drain on reconnect ─────────────────────────────────────────────────────

export async function drainPending(tenantId: string, sessionId: string): Promise<number> {
  const pending = await withTenant(tenantId, async (tx) => {
    return tx
      .select({ id: extensionTasks.id })
      .from(extensionTasks)
      .where(and(eq(extensionTasks.tenantId, tenantId), eq(extensionTasks.status, 'pending')))
      .orderBy(desc(extensionTasks.priority), asc(extensionTasks.createdAt))
      .limit(50);
  });

  let dispatched = 0;
  for (const row of pending) {
    const ok = await tryDispatch(tenantId, row.id);
    if (ok) dispatched++;
  }
  if (dispatched > 0) {
    logger.info({ tenantId, sessionId, dispatched, total: pending.length }, 'Drained pending extension tasks on reconnect');
  }
  return dispatched;
}

// ─── Task-complete handler ──────────────────────────────────────────────────

type CompletePayload =
  | { status: 'completed'; result: Record<string, unknown> }
  | { status: 'failed'; error: string };

export async function onExtensionTaskComplete(taskId: string, payload: CompletePayload): Promise<void> {
  // Look up the task (without tenant context) to learn tenant
  const [task] = await import('../config/database.js').then(({ db }) =>
    db.select().from(extensionTasks).where(eq(extensionTasks.id, taskId)).limit(1),
  );
  logger.debug(
    { taskId, found: !!task, tenantId: task?.tenantId, site: task?.site, type: task?.type },
    'extension_task_complete_start',
  );
  if (!task) {
    logger.warn({ taskId }, 'Extension task_result for unknown task');
    return;
  }

  // ─── Blocked-by-popup: reset to pending, don't count as a failed attempt ──
  // The extension has paused itself and the user will click Resume after
  // dismissing the LinkedIn modal. We want this exact task to re-dispatch
  // on reconnect, not stay in "failed".
  if (payload.status === 'failed' && payload.error === 'blocked_by_popup') {
    const resetAt = new Date();
    await withTenant(task.tenantId, async (tx) => {
      await tx
        .update(extensionTasks)
        .set({ status: 'pending', error: null, updatedAt: resetAt })
        .where(eq(extensionTasks.id, task.id));
    });
    logger.info(
      { taskId: task.id, tenantId: task.tenantId, site: task.site, type: task.type },
      'Extension task blocked by popup — reset to pending for retry on resume',
    );
    return;
  }

  // ─── Rate-limited (429): reset to pending for retry, don't count as attempt ──
  if (payload.status === 'failed' && payload.error === 'rate_limited_429') {
    const resetAt = new Date();
    await withTenant(task.tenantId, async (tx) => {
      await tx
        .update(extensionTasks)
        .set({ status: 'pending', error: null, updatedAt: resetAt })
        .where(eq(extensionTasks.id, task.id));
    });
    logger.info(
      { taskId: task.id, tenantId: task.tenantId, site: task.site, type: task.type },
      'Extension task rate-limited (429) — reset to pending for retry after backoff',
    );
    return;
  }

  const now = new Date();
  await withTenant(task.tenantId, async (tx) => {
    await tx
      .update(extensionTasks)
      .set({
        status: payload.status,
        result: payload.status === 'completed' ? payload.result : undefined,
        error: payload.status === 'failed' ? payload.error : undefined,
        completedAt: now,
        updatedAt: now,
        attempts: (task.attempts ?? 0) + 1,
      })
      .where(eq(extensionTasks.id, task.id));
  });
  logger.debug({ taskId: task.id, newStatus: payload.status }, 'extension_task_status_updated');

  if (payload.status !== 'completed') return;

  // Ingest results. Track extracted-vs-saved so we can log a clear WARN when
  // a task completed but produced zero saves (the most common silent-failure
  // mode — usually means the site's DOM changed and the adapter selectors
  // need updating).
  try {
    const summary = await ingestResult(task, payload.result);
    if (summary.extracted === 0) {
      logger.warn(
        {
          taskId: task.id,
          tenantId: task.tenantId,
          site: task.site,
          type: task.type,
          resultKeys: Object.keys(payload.result ?? {}),
          resultSample: JSON.stringify(payload.result).slice(0, 500),
        },
        'Extension task completed with ZERO items extracted — likely DOM selectors out of date',
      );
    } else if (summary.saved === 0) {
      logger.warn(
        { taskId: task.id, extracted: summary.extracted },
        'Extension task extracted items but saved zero — all rejected by saveOrUpdateCompanyStatic',
      );
    } else {
      logger.info(
        { taskId: task.id, site: task.site, type: task.type, extracted: summary.extracted, saved: summary.saved },
        'Extension task ingested',
      );
    }
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Failed to ingest extension task result into pipeline');
  }
}

type IngestSummary = { extracted: number; saved: number };

async function ingestResult(task: ExtensionTask, result: Record<string, unknown>): Promise<IngestSummary> {
  const site = task.site as ExtensionSite;
  const type = task.type as ExtensionTaskType;

  logger.debug(
    { taskId: task.id, site, type, resultKeys: Object.keys(result ?? {}) },
    'ingest_start',
  );

  if (site === 'linkedin' && type === 'search_companies') {
    const rawCompanies = (result.companies ?? []) as Array<Record<string, unknown>>;
    logger.info({ taskId: task.id, rawCount: rawCompanies.length }, 'ingest_linkedin_search_companies_raw');
    let saved = 0;
    for (const c of rawCompanies) {
      const name = String(c.name ?? '').trim();
      if (!name || name.length < 2) continue;

      // Dedup by linkedinUrl first. saveOrUpdateCompanyStatic only dedupes by
      // domain/name, and search results rarely carry a domain, so two sessions
      // that return "Acme Corp." and "Acme Corporation" with the same
      // linkedin_url would otherwise produce two rows. Skipping entirely also
      // preserves enriched fields (description, website, funding) that an
      // earlier fetch_company run may already have populated on the existing
      // row — the search-result payload is strictly slimmer.
      const linkedinUrl = typeof c.linkedinUrl === 'string' ? c.linkedinUrl : undefined;
      if (linkedinUrl) {
        const [existing] = await withTenant(task.tenantId, async (tx) => {
          return tx
            .select({ id: companies.id })
            .from(companies)
            .where(
              and(
                eq(companies.tenantId, task.tenantId),
                eq(companies.linkedinUrl, linkedinUrl),
              ),
            )
            .limit(1);
        });
        if (existing) {
          logger.debug(
            { linkedinUrl, existingId: existing.id },
            'Skipped duplicate company from LinkedIn extension (dedup by linkedinUrl)',
          );
          continue;
        }
      }

      try {
        const savedRow = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name,
            domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
            industry: (c.industry as string) ?? undefined,
            size: (c.size as string) ?? undefined,
            linkedinUrl,
            rawData: { source: 'linkedin_extension', ...c },
          },
          task.masterAgentId ?? undefined,
        );
        // Enrichment dispatch moved to fetch_company — search results lack domain
        logger.debug(
          { taskId: task.id, companyId: savedRow.id, name, linkedinUrl },
          'ingest_saved_company',
        );

        // Auto-chain the LinkedIn About-page fetch so enrichment gets a real
        // website/domain instead of having to guess from the name. Runs
        // inside the existing fetch_company daily cap (100); no cap change.
        // companyId threads through so the detail task updates this exact
        // row by id rather than re-running fuzzy domain/name dedup.
        if (linkedinUrl) {
          try {
            await enqueueExtensionTask({
              tenantId: task.tenantId,
              masterAgentId: task.masterAgentId ?? undefined,
              site: 'linkedin',
              type: 'fetch_company',
              params: { linkedinUrl, companyId: savedRow.id },
              priority: 3,
            });
          } catch (err) {
            logger.debug({ err, linkedinUrl }, 'Failed to auto-queue fetch_company (non-fatal)');
          }
        }

        saved++;
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid company from LinkedIn extension');
      }
    }
    return { extracted: rawCompanies.length, saved };
  }

  if (site === 'linkedin' && type === 'fetch_company') {
    const c = result as Record<string, unknown>;
    const name = String(c.name ?? '').trim();
    if (!name) return { extracted: 0, saved: 0 };
    const p = task.params as { linkedinUrl?: string; companyId?: string };
    // When auto-queued by the search_companies branch, params.companyId is
    // set — pass it through so the detail update targets the exact row
    // rather than re-running fuzzy domain/name dedup. If absent (e.g.
    // manual enqueue), saveOrUpdateCompanyStatic falls back to its usual
    // id → domain → name match.
    const savedCompany = await saveOrUpdateCompanyStatic(
      task.tenantId,
      {
        id: p.companyId,
        name,
        domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
        industry: (c.industry as string) ?? undefined,
        size: (c.size as string) ?? undefined,
        linkedinUrl: (c.linkedinUrl as string) ?? p.linkedinUrl,
        description: (c.description as string) ?? undefined,
        rawData: { source: 'linkedin_extension_detail', ...c },
      },
      task.masterAgentId ?? undefined,
    );

    // Dispatch enrichment now that we have the real domain from LinkedIn
    await dispatchJob(task.tenantId, 'enrichment', {
      companyId: savedCompany.id,
      masterAgentId: task.masterAgentId ?? undefined,
      source: 'linkedin_extension',
    });

    // Save people from LinkedIn company /people/ tab as contacts (best-effort, max 10)
    const rawPeople = (c.people ?? []) as Array<{ name: string; title: string; linkedinUrl: string }>;
    for (const person of rawPeople.slice(0, 10)) {
      if (!person.name || person.name.length < 2) continue;
      const nameParts = person.name.split(/\s+/);
      const pFirstName = nameParts[0] || '';
      const pLastName = nameParts.slice(1).join(' ') || '';
      if (!pFirstName || !pLastName) continue;

      try {
        // Dedup by linkedinUrl
        if (person.linkedinUrl) {
          const [existing] = await withTenant(task.tenantId, async (tx) => {
            return tx.select({ id: contacts.id }).from(contacts)
              .where(and(
                eq(contacts.tenantId, task.tenantId),
                eq(contacts.linkedinUrl, person.linkedinUrl),
              )).limit(1);
          });
          if (existing) continue;
        }

        await withTenant(task.tenantId, async (tx) => {
          await tx.insert(contacts).values({
            tenantId: task.tenantId,
            firstName: pFirstName,
            lastName: pLastName,
            title: sanitizeTitle(person.title),
            linkedinUrl: person.linkedinUrl || undefined,
            companyId: savedCompany.id,
            companyName: name,
            source: 'linkedin_profile',
            rawData: { discoverySource: 'linkedin_extension_people', ...person },
          });
        });
      } catch (err) {
        logger.debug({ err, person: person.name }, 'Failed to save LinkedIn person (non-fatal)');
      }
    }

    return { extracted: 1, saved: 1 };
  }

  if (site === 'gmaps') {
    const items = (result.businesses ?? (type === 'fetch_business' ? [result] : [])) as Array<Record<string, unknown>>;
    let saved = 0;
    for (const b of items) {
      const name = String(b.name ?? '').trim();
      if (!name) continue;
      try {
        const savedRow = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name,
            domain: typeof b.website === 'string' ? extractDomain(b.website) : undefined,
            rawData: { source: 'gmaps_extension', ...b },
          },
          task.masterAgentId ?? undefined,
        );
        if (type === 'search_businesses') {
          await dispatchJob(task.tenantId, 'enrichment', {
            companyId: savedRow.id,
            masterAgentId: task.masterAgentId ?? undefined,
            source: 'gmaps_extension',
          });
        }
        saved++;
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid gmaps business');
      }
    }
    return { extracted: items.length, saved };
  }

  if (site === 'crunchbase') {
    const items = (result.companies ?? (type === 'fetch_company' ? [result] : [])) as Array<Record<string, unknown>>;
    let saved = 0;
    for (const c of items) {
      const name = String(c.name ?? '').trim();
      if (!name) continue;
      try {
        const savedRow = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name,
            domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
            description: (c.description as string) ?? undefined,
            rawData: { source: 'crunchbase_extension', ...c },
          },
          task.masterAgentId ?? undefined,
        );
        if (type === 'search_companies') {
          await dispatchJob(task.tenantId, 'enrichment', {
            companyId: savedRow.id,
            masterAgentId: task.masterAgentId ?? undefined,
            source: 'crunchbase_extension',
          });
        }
        saved++;
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid crunchbase company');
      }
    }
    return { extracted: items.length, saved };
  }

  return { extracted: 0, saved: 0 };
}

const JUNK_TITLE_REGEX = /^(status is (online|offline)|message|follow|connect|view profile|see more)$/i;

function sanitizeTitle(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (JUNK_TITLE_REGEX.test(trimmed)) return undefined;
  return trimmed;
}

function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

// ─── Helpers used by the WS endpoint ───────────────────────────────────────

export async function markSessionConnected(sessionId: string, connected: boolean): Promise<void> {
  const { db } = await import('../config/database.js');
  await db
    .update(extensionSessions)
    .set({
      connected,
      lastSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(extensionSessions.id, sessionId));
}

export async function findSessionByApiKeyHash(apiKeyHash: string): Promise<{ id: string; tenantId: string; userId: string } | null> {
  const { db } = await import('../config/database.js');
  const [row] = await db
    .select({
      id: extensionSessions.id,
      tenantId: extensionSessions.tenantId,
      userId: extensionSessions.userId,
    })
    .from(extensionSessions)
    .where(and(eq(extensionSessions.apiKeyHash, apiKeyHash), isNull(extensionSessions.revokedAt)))
    .limit(1);
  return row ?? null;
}

// Returns true iff the tenant currently has ≥1 live (connected, non-revoked)
// extension session. Used by the master-agent to decide whether to skip
// crawler-based discovery when the strategist has marked the mission as
// extension-primary. Scoped by tenantId in the WHERE clause; no RLS helper
// needed because only a boolean leaks.
export async function isExtensionConnected(tenantId: string): Promise<boolean> {
  const { db } = await import('../config/database.js');
  const [row] = await db
    .select({ id: extensionSessions.id })
    .from(extensionSessions)
    .where(
      and(
        eq(extensionSessions.tenantId, tenantId),
        eq(extensionSessions.connected, true),
        isNull(extensionSessions.revokedAt),
      ),
    )
    .limit(1);
  return !!row;
}

