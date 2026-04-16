import { eq, and, asc, desc, isNull } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { extensionSessions, extensionTasks, masterAgents } from '../db/schema/index.js';
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
  if (!task) {
    logger.warn({ taskId }, 'Extension task_result for unknown task');
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

  if (payload.status !== 'completed') return;

  // Ingest results into the existing pipeline
  try {
    await ingestResult(task, payload.result);
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'Failed to ingest extension task result into pipeline');
  }
}

async function ingestResult(task: ExtensionTask, result: Record<string, unknown>): Promise<void> {
  const site = task.site as ExtensionSite;
  const type = task.type as ExtensionTaskType;

  if (site === 'linkedin' && type === 'search_companies') {
    const companies = (result.companies ?? []) as Array<Record<string, unknown>>;
    for (const c of companies) {
      const name = String(c.name ?? '').trim();
      if (!name || name.length < 2) continue;
      try {
        const saved = await saveOrUpdateCompanyStatic(
          task.tenantId,
          {
            name,
            domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
            industry: (c.industry as string) ?? undefined,
            size: (c.size as string) ?? undefined,
            linkedinUrl: (c.linkedinUrl as string) ?? undefined,
            rawData: { source: 'linkedin_extension', ...c },
          },
          task.masterAgentId ?? undefined,
        );
        await dispatchJob(task.tenantId, 'enrichment', {
          companyId: saved.id,
          masterAgentId: task.masterAgentId ?? undefined,
          source: 'linkedin_extension',
        });
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid company from LinkedIn extension');
      }
    }
    return;
  }

  if (site === 'linkedin' && type === 'fetch_company') {
    const c = result as Record<string, unknown>;
    const name = String(c.name ?? '').trim();
    if (!name) return;
    await saveOrUpdateCompanyStatic(
      task.tenantId,
      {
        name,
        domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
        industry: (c.industry as string) ?? undefined,
        size: (c.size as string) ?? undefined,
        linkedinUrl: (c.linkedinUrl as string) ?? (task.params as { linkedinUrl?: string }).linkedinUrl,
        description: (c.description as string) ?? undefined,
        rawData: { source: 'linkedin_extension_detail', ...c },
      },
      task.masterAgentId ?? undefined,
    );
    return;
  }

  if (site === 'gmaps') {
    const items = (result.businesses ?? (type === 'fetch_business' ? [result] : [])) as Array<Record<string, unknown>>;
    for (const b of items) {
      const name = String(b.name ?? '').trim();
      if (!name) continue;
      try {
        const saved = await saveOrUpdateCompanyStatic(
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
            companyId: saved.id,
            masterAgentId: task.masterAgentId ?? undefined,
            source: 'gmaps_extension',
          });
        }
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid gmaps business');
      }
    }
    return;
  }

  if (site === 'crunchbase') {
    const items = (result.companies ?? (type === 'fetch_company' ? [result] : [])) as Array<Record<string, unknown>>;
    for (const c of items) {
      const name = String(c.name ?? '').trim();
      if (!name) continue;
      try {
        const saved = await saveOrUpdateCompanyStatic(
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
            companyId: saved.id,
            masterAgentId: task.masterAgentId ?? undefined,
            source: 'crunchbase_extension',
          });
        }
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid crunchbase company');
      }
    }
  }
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

