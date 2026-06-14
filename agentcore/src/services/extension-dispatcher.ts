import { eq, and, asc, desc, gt, isNull, lte, or, exists, inArray, sql } from 'drizzle-orm';
import { db, withTenant } from '../config/database.js';
import { companies, contacts, extensionSessions, extensionTasks, masterAgents } from '../db/schema/index.js';
import { userTenants } from '../db/schema/user-tenants.js';
import type { ExtensionTask } from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import { dispatchJob } from './queue.service.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { enqueueFitScore } from '../queues/fit-score-queues.js';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';
import { logPipelineError, formatRateLimitMessage } from '../utils/pipeline-error.js';
import { logEvent } from './timeline.service.js';
import { ingestGmapsBusiness } from './gmaps-lead.service.js';
import { prospectStages } from '../db/schema/index.js';

// ─── Rate limits (server-authoritative; client mirrors these) ──────────────
//
// Quotas live on the per-user extension_sessions row (dailyTasksCount JSONB).
// After multi-workspace, a user has exactly one extension session regardless
// of how many tenants they're a member of, so the cap is effectively
// per-user — i.e. per LinkedIn account. 80 search-tasks/day is one quota
// across ALL the user's workspaces, not per-workspace; this matches reality
// because the LinkedIn account is shared.

export type ExtensionSite = 'linkedin' | 'gmaps' | 'crunchbase';
export type ExtensionTaskType =
  | 'search_companies'
  | 'fetch_company'
  | 'fetch_company_info'
  | 'fetch_company_team'
  | 'search_businesses'
  | 'fetch_business';

export const EXTENSION_SITE_LIMITS = {
  linkedin: {
    // Mirrors extension/lib/rate-limiter.js. minDelayMs is enforced
    // client-side (server only enforces dailyCap); kept in sync here as
    // documentation. Caps raised after the prior 10-search/100-fetch values
    // bottlenecked multi-agent demo runs (one agent burning 10 starved every
    // other agent on the same session for 24h). 80 search-tasks/day per
    // session covers ~8 strategist runs of 10 search steps each;
    // 400 fetch-tasks/day supports ~200 enriched companies per session.
    search_companies: { dailyCap: 80, minDelayMs: 4000 },
    fetch_company: { dailyCap: 100, minDelayMs: 8000 },
    // Split adapters get the same cap each — together they double the rate
    // of LinkedIn page hits per company. minDelayMs stays at 8s per call so
    // the per-tab pacing matches the legacy combined adapter.
    fetch_company_info: { dailyCap: 400, minDelayMs: 8000 },
    fetch_company_team: { dailyCap: 400, minDelayMs: 8000 },
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

// ─── Defensive enqueue guard ────────────────────────────────────────────────
// fetch_company_info / fetch_company_team REQUIRE a per-company linkedinUrl
// in params. Standalone strategist steps without one fail later inside the
// extension with `invalid linkedinUrl=undefined`, polluting metrics. This
// guard catches the bug at the enqueue boundary and logs the call site via
// stack trace so we can find whoever's calling without a URL.
function looksLikeMissingLinkedInUrl(
  type: ExtensionTaskType,
  params: Record<string, unknown> | undefined,
): boolean {
  if (type !== 'fetch_company_info' && type !== 'fetch_company_team') return false;
  const url = params?.linkedinUrl;
  return typeof url !== 'string' || url.trim().length === 0;
}

function rejectMissingLinkedInUrl(
  callsite: 'single' | 'batch',
  task: { tenantId: string; masterAgentId?: string | null; site: ExtensionSite; type: ExtensionTaskType; params: Record<string, unknown> | undefined },
): void {
  logger.error(
    {
      callsite,
      tenantId: task.tenantId,
      masterAgentId: task.masterAgentId ?? null,
      site: task.site,
      type: task.type,
      paramKeys: Object.keys(task.params ?? {}),
      linkedinUrl: task.params?.linkedinUrl,
      stack: new Error('linkedinUrl_missing_at_enqueue').stack,
    },
    'CRITICAL: enqueueing fetch_company_info/_team task with no linkedinUrl — bug somewhere',
  );
}

// ─── Enqueue ────────────────────────────────────────────────────────────────

export async function enqueueExtensionTask(params: {
  tenantId: string;
  masterAgentId?: string;
  site: ExtensionSite;
  type: ExtensionTaskType;
  params: Record<string, unknown>;
  priority?: number;
  dispatchAfter?: Date;
}): Promise<{ taskId: string }> {
  if (looksLikeMissingLinkedInUrl(params.type, params.params)) {
    rejectMissingLinkedInUrl('single', {
      tenantId: params.tenantId,
      masterAgentId: params.masterAgentId ?? null,
      site: params.site,
      type: params.type,
      params: params.params,
    });
    throw new Error(`enqueueExtensionTask: ${params.type} requires params.linkedinUrl`);
  }

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
        ...(params.dispatchAfter ? { dispatchAfter: params.dispatchAfter } : {}),
      })
      .returning({ id: extensionTasks.id });
  });
  const taskId = row!.id;

  // Fire-and-forget immediate dispatch attempt (don't block the caller).
  // tryDispatch internally bails when dispatchAfter > now; the periodic
  // scheduled-drainer wakes the task up later.
  tryDispatch(params.tenantId, taskId).catch((err) => {
    logger.debug({ err, taskId }, 'Extension task immediate dispatch failed (will retry on reconnect)');
  });

  return { taskId };
}

// ─── Bulk batched enqueue ───────────────────────────────────────────────────

interface BatchTaskInput {
  masterAgentId?: string;
  site: ExtensionSite;
  type: ExtensionTaskType;
  params: Record<string, unknown>;
  priority?: number;
}

/**
 * Insert N tasks at once and stagger their `dispatchAfter` so they are
 * released to the extension in batches of `batchSize` separated by
 * `batchCooldownMs`. Defaults: 10 tasks per batch, 60s cooldown.
 *
 * Rationale: the LinkedIn Jobs scrape can find 100+ companies, and the
 * `search_companies` extension task can return a similar volume. Inserting
 * all of them with `dispatch_after = now()` queued them into the extension
 * back-to-back; the rate-limiter on the extension side serialised them but
 * piled up a long backlog of `pending` rows and reportedly tripped LinkedIn
 * rate-limits on long runs. Server-side staggering makes the queue visibly
 * paced and lets `pause` / `cancel` actually stop the chain mid-fan-out.
 *
 * Tasks within the same batch share the same `dispatchAfter` timestamp;
 * the extension's per-task minDelay still serialises them client-side.
 */
/**
 * Fan out company enrichment to the MODERN split tasks: one `fetch_company_info`
 * per company + one `fetch_company_team` per `teamRoleKeyword`. This makes the
 * extension load the simple `/company/<slug>/people/?keywords=<kw>` page — never
 * the legacy combined `fetch_company` task, which clicks through to LinkedIn's
 * canned `/search/results/people/?currentCompany=…` search.
 *
 * Shared by the `search_companies` auto-chain and the LinkedIn-Jobs (hiring
 * signal) discovery path so both behave identically.
 */
export async function enqueueCompanyEnrichmentFanout(
  tenantId: string,
  masterAgentId: string | undefined,
  companies: Array<{ linkedinUrl: string; companyId?: string }>,
): Promise<void> {
  if (companies.length === 0) return;

  // Keywords come from the strategist's saved sales-strategy
  // (config.salesStrategy.teamRoleKeywords); legacy chat-set keywords on
  // config.teamRoleKeywords are a fallback for agents whose strategy hasn't
  // been regenerated yet. If neither is set, the team fetch is skipped — the
  // user must re-run the strategist to populate them.
  let teamKeywords: string[] = [];
  if (masterAgentId) {
    try {
      const [agentRow] = await withTenant(tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config })
          .from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)))
          .limit(1);
      });
      const cfg = agentRow?.config as Record<string, unknown> | undefined;
      const strategyRaw = (cfg?.salesStrategy as Record<string, unknown> | undefined)?.teamRoleKeywords;
      const legacyRaw = cfg?.teamRoleKeywords;
      const pickFrom = (raw: unknown): string[] =>
        Array.isArray(raw)
          ? raw
              .filter((k): k is string => typeof k === 'string')
              .map((s) => s.trim())
              .filter((s) => s.length > 0 && s.length <= 60)
          : [];
      const strategyKw = pickFrom(strategyRaw);
      const legacyKw = pickFrom(legacyRaw);
      teamKeywords = strategyKw.length > 0 ? strategyKw : legacyKw;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), masterAgentId },
        'Failed to load teamRoleKeywords for fanout — skipping team fetch',
      );
    }
  }

  const fanoutTasks: BatchTaskInput[] = [];
  for (const c of companies) {
    fanoutTasks.push({
      masterAgentId,
      site: 'linkedin',
      type: 'fetch_company_info',
      params: { linkedinUrl: c.linkedinUrl, companyId: c.companyId },
      priority: 3,
    });
    for (const keyword of teamKeywords) {
      fanoutTasks.push({
        masterAgentId,
        site: 'linkedin',
        type: 'fetch_company_team',
        params: { linkedinUrl: c.linkedinUrl, companyId: c.companyId, keyword },
        priority: 3,
      });
    }
  }
  if (teamKeywords.length === 0) {
    logger.info(
      { masterAgentId, companyCount: companies.length },
      'team_fetch_skipped_no_keywords — strategist did not emit config.salesStrategy.teamRoleKeywords; re-run /regenerate-strategy to populate',
    );
  }
  await enqueueExtensionTaskBatch(tenantId, fanoutTasks);
}

export async function enqueueExtensionTaskBatch(
  tenantId: string,
  tasks: BatchTaskInput[],
  opts: { batchSize?: number; batchCooldownMs?: number; firstBatchDelayMs?: number } = {},
): Promise<{ taskIds: string[]; batches: number }> {
  if (tasks.length === 0) return { taskIds: [], batches: 0 };

  // Filter out fetch_company_info/_team rows missing linkedinUrl. These
  // would otherwise reach the extension and fail with `invalid linkedinUrl=undefined`,
  // burning a daily-cap slot for nothing. Log each rejection so we can find
  // the upstream code path that's producing them.
  const validTasks = tasks.filter((t) => {
    if (looksLikeMissingLinkedInUrl(t.type, t.params)) {
      rejectMissingLinkedInUrl('batch', {
        tenantId,
        masterAgentId: t.masterAgentId ?? null,
        site: t.site,
        type: t.type,
        params: t.params,
      });
      return false;
    }
    return true;
  });
  if (validTasks.length === 0) return { taskIds: [], batches: 0 };

  const batchSize = opts.batchSize ?? 10;
  const batchCooldownMs = opts.batchCooldownMs ?? 60_000;
  const firstBatchDelayMs = opts.firstBatchDelayMs ?? 0;

  const now = Date.now();
  const values = validTasks.map((t, idx) => {
    const batchIdx = Math.floor(idx / batchSize);
    const dispatchAfter = new Date(now + firstBatchDelayMs + batchIdx * batchCooldownMs);
    return {
      tenantId,
      masterAgentId: t.masterAgentId,
      site: t.site,
      type: t.type,
      params: t.params ?? {},
      priority: t.priority ?? 5,
      status: 'pending' as const,
      dispatchAfter,
    };
  });

  const inserted = await withTenant(tenantId, async (tx) => {
    return tx.insert(extensionTasks).values(values).returning({ id: extensionTasks.id });
  });

  const taskIds = inserted.map((r) => r.id);
  const batches = Math.ceil(validTasks.length / batchSize);
  const rejected = tasks.length - validTasks.length;

  logger.info(
    { tenantId, requested: tasks.length, count: validTasks.length, rejected, batches, batchSize, batchCooldownMs },
    'Enqueued extension tasks in batches',
  );

  // Fire-and-forget dispatch on the first batch only — later batches wake up
  // via the scheduled drainer when their dispatchAfter passes.
  for (let i = 0; i < Math.min(batchSize, taskIds.length); i++) {
    tryDispatch(tenantId, taskIds[i]!).catch((err) => {
      logger.debug({ err, taskId: taskIds[i] }, 'Batch first-wave dispatch attempt failed');
    });
  }

  return { taskIds, batches };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export async function tryDispatch(tenantId: string, taskId: string): Promise<boolean> {
  // Load the task — we always need a fresh row before considering dispatch.
  const task = await withTenant(tenantId, async (tx) => {
    const [t] = await tx
      .select()
      .from(extensionTasks)
      .where(and(eq(extensionTasks.id, taskId), eq(extensionTasks.tenantId, tenantId)))
      .limit(1);
    if (!t || t.status !== 'pending') return null;
    // Skip silently if the task is scheduled for the future — the periodic
    // re-drainer will pick it up at its dispatchAfter timestamp.
    if (t.dispatchAfter && t.dispatchAfter.getTime() > Date.now()) return null;
    return t;
  });
  if (!task) return false;

  // Gate dispatch on the owning master agent's lifecycle. A task that still
  // carries a master_agent_id must not dispatch if that agent has been deleted
  // (row gone) or paused — otherwise queued tasks keep firing at the extension
  // long after the agent is gone, with no way to stop them.
  if (task.masterAgentId) {
    const [agentRow] = await withTenant(tenantId, async (tx) => {
      return tx.select({ status: masterAgents.status })
        .from(masterAgents)
        .where(eq(masterAgents.id, task.masterAgentId as string))
        .limit(1);
    });
    if (!agentRow) {
      // Agent deleted out from under the task — cancel it so the sweep stops retrying.
      await withTenant(tenantId, async (tx) => {
        await tx.update(extensionTasks)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(and(eq(extensionTasks.id, taskId), eq(extensionTasks.tenantId, tenantId)));
      });
      logger.info({ taskId, masterAgentId: task.masterAgentId }, 'Cancelled dispatch — master agent deleted');
      return false;
    }
    if (agentRow.status === 'paused' || agentRow.status === 'paused_quota') {
      logger.info({ taskId, masterAgentId: task.masterAgentId, status: agentRow.status }, 'Skipped dispatch — master agent paused');
      return false;
    }
  }

  // Load ALL eligible (connected, recent heartbeat, non-revoked) sessions
  // that can reach this tenant. The previous .limit(1) most-recent picker
  // stalled the queue whenever the chosen session was at cap — even if a
  // sibling session had headroom. We fall back across sessions in
  // lastSeenAt-desc order so the healthiest one wins first.
  //
  // When ENABLE_MULTI_WORKSPACE_DISPATCH is on, a session is reachable if
  // its USER is a member of the requested tenant via user_tenants — that is
  // the same predicate for both legacy per-tenant sessions and new
  // tenant-less multi-workspace sessions. This is what unblocks shiran
  // without requiring him to re-login: his existing tenant=2a559a80 session
  // becomes eligible for tasks in c0e5f997 because user_tenants lists him
  // as an owner there.
  //
  // With the flag off we preserve the old per-tenant predicate exactly so
  // rollback is a one-env-var flip.
  const tenantMatch = env.ENABLE_MULTI_WORKSPACE_DISPATCH
    ? exists(
        db
          .select({ one: sql<number>`1` })
          .from(userTenants)
          .where(and(
            eq(userTenants.userId, extensionSessions.userId),
            eq(userTenants.tenantId, tenantId),
            inArray(userTenants.role, ['owner', 'admin', 'member']),
          )),
      )
    : eq(extensionSessions.tenantId, tenantId);

  const eligibleSessions = await db
    .select()
    .from(extensionSessions)
    .where(and(
      tenantMatch!,
      eq(extensionSessions.connected, true),
      isNull(extensionSessions.revokedAt),
      gt(extensionSessions.lastSeenAt, sql`NOW() - INTERVAL '90 seconds'`),
    ))
    .orderBy(desc(extensionSessions.lastSeenAt));

  if (eligibleSessions.length === 0) {
    logger.info(
      { taskId, tenantId, masterAgentId: task.masterAgentId, type: task.type },
      'Extension task queued but not dispatched — no connected extension session',
    );
    return false;
  }

  const limit = getLimit(task.site as ExtensionSite, task.type as ExtensionTaskType);
  const key = `${task.site}:${task.type}`;
  const now = new Date();

  // Look up the master-agent name once — used by all dispatch attempts below.
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

  const { hasLiveExtensionSocket } = await import('../websocket/extension.js');

  // Track the most recently-seen at-cap session so we can surface its real
  // dailyResetAt in the rate-limit pipeline error if every session refuses.
  let lastAtCap: { session: typeof eligibleSessions[number]; used: number; cap: number } | null = null;

  for (const session of eligibleSessions) {
    // Even if the DB says connected=true, the in-memory socket map is the
    // source of truth — a crashed/restarted process leaves orphan rows that
    // would otherwise consume dispatches into a dead Redis subscriber.
    if (!hasLiveExtensionSocket(session.id)) {
      await withTenant(tenantId, async (tx) => {
        await tx
          .update(extensionSessions)
          .set({ connected: false, updatedAt: new Date() })
          .where(eq(extensionSessions.id, session.id));
      });
      logger.warn(
        { sessionId: session.id, tenantId },
        'self_healed_orphan_session_no_live_socket',
      );
      continue;
    }

    // Per-session daily-cap check. Reset counters if dailyResetAt older than 24h.
    const resetAt = session.dailyResetAt ? new Date(session.dailyResetAt) : new Date(0);
    const needsReset = now.getTime() - resetAt.getTime() > 24 * 60 * 60 * 1000;
    const counts: Record<string, number> = needsReset
      ? {}
      : { ...((session.dailyTasksCount as Record<string, number>) ?? {}) };
    const used = counts[key] ?? 0;
    if (limit && used >= limit.dailyCap) {
      lastAtCap = { session, used, cap: limit.dailyCap };
      continue;
    }

    // Acquired a slot on this session. Mark dispatched + bump counter.
    counts[key] = used + 1;
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

      await tx
        .update(extensionSessions)
        .set({
          dailyTasksCount: counts,
          dailyResetAt: needsReset ? now : session.dailyResetAt,
          updatedAt: now,
        })
        .where(eq(extensionSessions.id, session.id));
    });

    const payload = JSON.stringify({
      type: 'task',
      taskId: task.id,
      // Carried per-task so multi-workspace sessions can echo it back on
      // task_result and so the popup can attribute work to the right workspace.
      // Result-routing on the server still goes through the DB lookup as a
      // safety net (see onExtensionTaskComplete), so this field is advisory.
      tenantId,
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

  // No session accepted. If at least one was at cap, surface a real-reset
  // pipeline error rather than the misleading static "Pausing for 1 hour".
  if (lastAtCap) {
    const baseResetAt = lastAtCap.session.dailyResetAt
      ? new Date(lastAtCap.session.dailyResetAt)
      : null;
    const nextResetAt = baseResetAt ? new Date(baseResetAt.getTime() + 24 * 60 * 60 * 1000) : null;
    logger.info(
      {
        taskId, tenantId, site: task.site, type: task.type,
        used: lastAtCap.used, cap: lastAtCap.cap,
        sessionCount: eligibleSessions.length,
      },
      'all_sessions_at_cap',
    );
    if (task.site === 'linkedin') {
      await logPipelineError({
        tenantId,
        masterAgentId: task.masterAgentId ?? null,
        step: 'extension.dispatch',
        tool: 'LINKEDIN_EXTENSION',
        errorType: 'linkedin_rate_limit',
        message: formatRateLimitMessage(nextResetAt),
        context: {
          taskId, site: task.site, type: task.type,
          used: lastAtCap.used, cap: lastAtCap.cap,
          sessionCount: eligibleSessions.length,
          nextResetAt: nextResetAt?.toISOString() ?? null,
        },
      });
    }
  }
  return false;
}

// ─── Drain on reconnect ─────────────────────────────────────────────────────

export async function drainPending(tenantId: string, sessionId: string): Promise<number> {
  const pending = await withTenant(tenantId, async (tx) => {
    return tx
      .select({ id: extensionTasks.id })
      .from(extensionTasks)
      .where(and(
        eq(extensionTasks.tenantId, tenantId),
        eq(extensionTasks.status, 'pending'),
        lte(extensionTasks.dispatchAfter, new Date()),
      ))
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

// Multi-workspace drain: pulls the oldest pending tasks across every tenant
// the session's user is a member of and dispatches each one through the
// regular per-tenant tryDispatch (which itself now allows tenant-less
// sessions). One JOIN, fair cross-workspace ordering by created_at.
export async function drainPendingForUser(userId: string, sessionId: string): Promise<number> {
  if (!env.ENABLE_MULTI_WORKSPACE_DISPATCH) {
    // Flag-off rollback: tenant-less sessions can't drain anything in this
    // mode, but they shouldn't exist either (the dispatcher and login code
    // both gate on the same flag in practice). Logged so we notice if it
    // ever happens.
    logger.warn({ sessionId, userId }, 'drainPendingForUser called with multi-workspace flag OFF — no-op');
    return 0;
  }

  const pending = await db
    .select({ id: extensionTasks.id, tenantId: extensionTasks.tenantId })
    .from(extensionTasks)
    .innerJoin(userTenants, eq(userTenants.tenantId, extensionTasks.tenantId))
    .where(and(
      eq(userTenants.userId, userId),
      inArray(userTenants.role, ['owner', 'admin', 'member']),
      eq(extensionTasks.status, 'pending'),
      lte(extensionTasks.dispatchAfter, new Date()),
    ))
    .orderBy(desc(extensionTasks.priority), asc(extensionTasks.createdAt))
    .limit(50);

  let dispatched = 0;
  for (const row of pending) {
    const ok = await tryDispatch(row.tenantId, row.id);
    if (ok) dispatched++;
  }
  if (pending.length > 0) {
    logger.info(
      { userId, sessionId, dispatched, total: pending.length, tenants: [...new Set(pending.map((p) => p.tenantId))].length },
      'Drained pending extension tasks on reconnect (multi-workspace)',
    );
  }
  return dispatched;
}

// ─── Scheduled drainer ──────────────────────────────────────────────────────
// Periodic sweep that picks up tasks whose `dispatch_after` has just passed.
// Without this, tasks staggered across batches would sit `pending` forever
// because the immediate-dispatch path bails for future-scheduled rows.

let scheduledDrainerInterval: NodeJS.Timeout | null = null;

export async function runScheduledDispatchSweep(): Promise<number> {
  // Use the global db (cross-tenant scan). RLS filters via withTenant aren't
  // needed here — the read joins by tenant_id and the dispatch path itself
  // re-loads under tenant context.
  const { db } = await import('../config/database.js');
  const eligible = await db
    .select({ id: extensionTasks.id, tenantId: extensionTasks.tenantId })
    .from(extensionTasks)
    .where(and(
      eq(extensionTasks.status, 'pending'),
      lte(extensionTasks.dispatchAfter, new Date()),
    ))
    .orderBy(desc(extensionTasks.priority), asc(extensionTasks.createdAt))
    .limit(200);

  let dispatched = 0;
  for (const row of eligible) {
    try {
      const ok = await tryDispatch(row.tenantId, row.id);
      if (ok) dispatched++;
    } catch (err) {
      logger.debug({ err, taskId: row.id, tenantId: row.tenantId }, 'Scheduled drainer dispatch failed');
    }
  }
  if (dispatched > 0) {
    logger.info({ dispatched, scanned: eligible.length }, 'Scheduled dispatch sweep dispatched batched tasks');
  }
  return dispatched;
}

export function startScheduledDispatcher(intervalMs = 15_000): void {
  if (scheduledDrainerInterval) return;
  scheduledDrainerInterval = setInterval(() => {
    runScheduledDispatchSweep().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Scheduled dispatcher sweep errored');
    });
  }, intervalMs);
  // Don't keep the event loop alive purely for this timer.
  scheduledDrainerInterval.unref?.();
  logger.info({ intervalMs }, 'Scheduled extension dispatcher started');
}

export function stopScheduledDispatcher(): void {
  if (scheduledDrainerInterval) {
    clearInterval(scheduledDrainerInterval);
    scheduledDrainerInterval = null;
  }
}

// ─── Stuck-dispatched watchdog ──────────────────────────────────────────────
// A task is marked `dispatched` the moment we publish to Redis, but if the
// extension's WS dies between publish and ack, no `task_result` ever comes
// back — the row sits in `dispatched` forever and the queue silently shrinks
// to zero throughput. This watchdog re-pends anything that's been dispatched
// for more than 5 minutes so the next drainer cycle gives it another chance.

let stuckWatchdogInterval: NodeJS.Timeout | null = null;

export async function rePendStuckDispatched(): Promise<number> {
  const cutoff = new Date(Date.now() - 5 * 60_000);
  const { db } = await import('../config/database.js');
  const res = await db
    .update(extensionTasks)
    .set({ status: 'pending', sessionId: null, dispatchedAt: null, updatedAt: new Date() })
    .where(and(eq(extensionTasks.status, 'dispatched'), lte(extensionTasks.dispatchedAt, cutoff)))
    .returning({ id: extensionTasks.id });
  if (res.length > 0) {
    logger.warn({ count: res.length }, 're_pended_stuck_dispatched_tasks');
  }
  return res.length;
}

export function startStuckDispatchedWatchdog(intervalMs = 60_000): void {
  if (stuckWatchdogInterval) return;
  stuckWatchdogInterval = setInterval(() => {
    rePendStuckDispatched().catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Stuck-dispatched watchdog errored');
    });
  }, intervalMs);
  stuckWatchdogInterval.unref?.();
  logger.info({ intervalMs }, 'Stuck-dispatched watchdog started');
}

export function stopStuckDispatchedWatchdog(): void {
  if (stuckWatchdogInterval) {
    clearInterval(stuckWatchdogInterval);
    stuckWatchdogInterval = null;
  }
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
    if (task.site === 'linkedin') {
      await logPipelineError({
        tenantId: task.tenantId,
        masterAgentId: task.masterAgentId ?? null,
        step: 'extension.task',
        tool: 'LINKEDIN_EXTENSION',
        errorType: 'linkedin_popup',
        context: { taskId: task.id, site: task.site, type: task.type },
      });
    }
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
    if (task.site === 'linkedin') {
      await logPipelineError({
        tenantId: task.tenantId,
        masterAgentId: task.masterAgentId ?? null,
        step: 'extension.task',
        tool: 'LINKEDIN_EXTENSION',
        errorType: 'linkedin_rate_limit',
        context: { taskId: task.id, site: task.site, type: task.type },
      });
    }
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

// ─── Server-side post-extraction geo filter ────────────────────────────────
// LinkedIn's `companyHqGeo` URL facet is a SOFT filter — when keyword
// matching is strong (e.g. "neobank digital bank"), LinkedIn surfaces
// globally-relevant companies even when their HQ is outside the requested
// URN list. We confirmed empirically: agent 4c232eb4-... requested EU only
// and got Mumbai/Atlanta/Istanbul rows alongside London/Paris/Amsterdam.
//
// The extension already extracts a `location` string per card. We match it
// against the strategist's `geographyFilter.regions` here. Companies whose
// location does not plausibly belong to any requested region are dropped
// before save. Empty location → pass through (don't drop on missing data;
// `fetch_company_info` will populate `headquarters` and the next pass can
// re-evaluate).
const CITY_TO_COUNTRY: Record<string, string> = {
  // EU
  london: 'united kingdom', manchester: 'united kingdom', edinburgh: 'united kingdom',
  birmingham: 'united kingdom', leeds: 'united kingdom', glasgow: 'united kingdom',
  paris: 'france', lyon: 'france', toulouse: 'france', marseille: 'france',
  berlin: 'germany', munich: 'germany', hamburg: 'germany', frankfurt: 'germany',
  cologne: 'germany', stuttgart: 'germany',
  amsterdam: 'netherlands', rotterdam: 'netherlands', 'the hague': 'netherlands',
  utrecht: 'netherlands', eindhoven: 'netherlands',
  stockholm: 'sweden', gothenburg: 'sweden', malmö: 'sweden', malmo: 'sweden',
  dublin: 'ireland', cork: 'ireland',
  madrid: 'spain', barcelona: 'spain', valencia: 'spain', seville: 'spain',
  milan: 'italy', rome: 'italy', turin: 'italy', naples: 'italy', bologna: 'italy',
  warsaw: 'poland', krakow: 'poland', kraków: 'poland', lublin: 'poland', mokotów: 'poland',
  brussels: 'belgium', antwerp: 'belgium', ghent: 'belgium',
  copenhagen: 'denmark', oslo: 'norway', helsinki: 'finland',
  lisbon: 'portugal', porto: 'portugal',
  vienna: 'austria', zurich: 'switzerland', geneva: 'switzerland', basel: 'switzerland',
  vilnius: 'lithuania', luxembourg: 'luxembourg',
  // MENA
  dubai: 'united arab emirates', 'abu dhabi': 'united arab emirates',
  riyadh: 'saudi arabia', jeddah: 'saudi arabia',
  cairo: 'egypt', alexandria: 'egypt',
  doha: 'qatar', 'kuwait city': 'kuwait',
  casablanca: 'morocco', rabat: 'morocco',
  // NA
  'new york': 'united states', 'san francisco': 'united states', 'palo alto': 'united states',
  miami: 'united states', atlanta: 'united states', somerville: 'united states',
  boston: 'united states', chicago: 'united states', seattle: 'united states',
  'los angeles': 'united states', austin: 'united states', denver: 'united states',
  toronto: 'canada', vancouver: 'canada', montreal: 'canada', ottawa: 'canada',
};

// Region-name aliases LinkedIn occasionally puts in the location string
// (state/country variants beyond the canonical names in geographyFilter).
const REGION_ALIASES: Record<string, string> = {
  uk: 'united kingdom',
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  uae: 'united arab emirates',
  usa: 'united states',
  us: 'united states',
};

export function isLocationInRegions(
  location: string | undefined | null,
  requestedRegions: string[],
): boolean {
  if (!location || !location.trim()) return true; // pass-through on missing data
  if (!requestedRegions.length) return true;
  const loc = location.toLowerCase();
  const wanted = new Set(requestedRegions.map((r) => r.trim().toLowerCase()));

  // Direct country-name substring match — handles "London, England, United Kingdom"
  // and "İstanbul, Şişli" (latter doesn't contain any wanted country → drop).
  for (const w of wanted) {
    if (loc.includes(w)) return true;
  }

  // Alias check (LinkedIn says "England" — strategist says "United Kingdom").
  for (const [alias, canonical] of Object.entries(REGION_ALIASES)) {
    if (wanted.has(canonical) && new RegExp(`\\b${alias}\\b`, 'i').test(loc)) {
      return true;
    }
  }

  // City-level fallback. Tokenise the location string on commas + middle-dot
  // and look up each token in CITY_TO_COUNTRY.
  const tokens = loc
    .split(/[,•·]/g)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    const country = CITY_TO_COUNTRY[tok];
    if (country && wanted.has(country)) return true;
  }

  return false;
}

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
    // No keyword pre-save filter — every company with a name + LinkedIn URL is
    // saved. The buyer-fit scorer (LLM) ranks them downstream; the dashboard
    // sorts by score. See plan: discovery-pipeline refactor PART 1.
    // Collect fetch_company auto-chain tasks and enqueue them in batches of
    // 10 (60s cooldown) at the end of the loop. With a 100-result search this
    // would otherwise queue 100 fetch_company tasks back-to-back into the
    // extension and trip LinkedIn 429s.
    const pendingFetchTasks: Array<{ linkedinUrl: string; companyId: string }> = [];
    const requestedRegions =
      ((task.params as { geographyFilter?: { regions?: string[] } })?.geographyFilter?.regions ?? [])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
    let geoFlagged = 0;
    for (const c of rawCompanies) {
      const name = String(c.name ?? '').trim();
      if (!name || name.length < 2) continue;

      // Geo filter — LinkedIn's `companyHqGeo` is a soft facet that leaks
      // globally-relevant matches when keywords are strong. We no longer DROP
      // mismatches (the search adapter's `location` field is unreliable — it
      // sometimes contains a description snippet rather than a city). Instead
      // we annotate the row so the dashboard can render an "out of region"
      // tag, and let fetch_company_info populate the real headquarters for a
      // post-enrichment pass to re-evaluate.
      let geoMismatch: { expected: string[]; got: string } | null = null;
      if (requestedRegions.length > 0) {
        const cLocation = typeof c.location === 'string' ? c.location : '';
        if (cLocation && !isLocationInRegions(cLocation, requestedRegions)) {
          geoMismatch = { expected: requestedRegions, got: cLocation };
          geoFlagged++;
          logger.info(
            { taskId: task.id, name, location: cLocation, requestedRegions },
            'discovery_geo_mismatch_flagged',
          );
        }
      }

      // Dedup by linkedinUrl first. saveOrUpdateCompanyStatic only dedupes by
      // domain/name, and search results rarely carry a domain, so two sessions
      // that return "Acme Corp." and "Acme Corporation" with the same
      // linkedin_url would otherwise produce two rows. Skipping entirely also
      // preserves enriched fields (description, website, funding) that an
      // earlier fetch_company run may already have populated on the existing
      // row — the search-result payload is strictly slimmer.
      const linkedinUrl = typeof c.linkedinUrl === 'string' && c.linkedinUrl.trim().length > 0
        ? c.linkedinUrl
        : undefined;
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
            rawData: {
              source: 'linkedin_extension',
              ...c,
              ...(geoMismatch ? { geoMismatch } : {}),
            },
          },
          task.masterAgentId ?? undefined,
        );
        // Enrichment dispatch moved to fetch_company — search results lack domain
        logger.debug(
          { taskId: task.id, companyId: savedRow.id, name, linkedinUrl },
          'ingest_saved_company',
        );

        // Auto-chain the LinkedIn About-page fetch so enrichment gets a real
        // website/domain. companyId threads through so the detail task
        // updates this exact row by id rather than re-running fuzzy
        // domain/name dedup. Queued for batched dispatch below.
        if (linkedinUrl) {
          pendingFetchTasks.push({ linkedinUrl, companyId: savedRow.id });
        }

        saved++;
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid company from LinkedIn extension');
      }
    }

    if (pendingFetchTasks.length > 0) {
      // Parallel fanout: per company, enqueue fetch_company_info (about page)
      // + one fetch_company_team per teamRoleKeyword. Shared with the
      // LinkedIn-Jobs path — see enqueueCompanyEnrichmentFanout.
      try {
        await enqueueCompanyEnrichmentFanout(
          task.tenantId,
          task.masterAgentId ?? undefined,
          pendingFetchTasks,
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), count: pendingFetchTasks.length, taskId: task.id },
          'Batched fetch_company info+team auto-chain enqueue failed (non-fatal)',
        );
      }
    }

    logger.info(
      {
        taskId: task.id,
        masterAgentId: task.masterAgentId,
        rawResultCount: rawCompanies.length,
        saved,
        geoFlagged,
        requestedRegions,
      },
      'discovery_saved_summary',
    );

    return { extracted: rawCompanies.length, saved };
  }

  // ─── Parallel-fetch handlers (info + team) ──────────────────────────────
  // The legacy fetch_company adapter is split into two parallel adapters.
  // Each completion handler updates the same company row independently and
  // triggers the fit-score scorer. The legacy fetch_company branch below
  // stays as a backwards-compat shim for in-flight tasks during deploy.

  if (site === 'linkedin' && type === 'fetch_company_info') {
    return handleCompanyInfoComplete(task, result as Record<string, unknown>);
  }

  if (site === 'linkedin' && type === 'fetch_company_team') {
    return handleCompanyTeamComplete(task, result as Record<string, unknown>);
  }

  if (site === 'linkedin' && type === 'fetch_company') {
    // Legacy combined adapter — feed both handlers from a single payload so
    // tasks queued before the parallel split still get processed correctly.
    const r = result as Record<string, unknown>;
    const infoSummary = await handleCompanyInfoComplete(task, r);
    const teamSummary = await handleCompanyTeamComplete(task, r);
    return {
      extracted: infoSummary.extracted + teamSummary.extracted,
      saved: infoSummary.saved + teamSummary.saved,
    };
  }

  if (site === 'gmaps') {
    const items = (result.businesses ?? (type === 'fetch_business' ? [result] : [])) as Array<Record<string, unknown>>;
    const params = (task.params ?? {}) as Record<string, unknown>;
    let saved = 0;
    const detailFanout: BatchTaskInput[] = [];
    for (const b of items) {
      const name = String(b.name ?? '').trim();
      if (!name) continue;
      const mapsUrl = typeof b.mapsUrl === 'string' ? b.mapsUrl : undefined;
      const isDetail = type === 'fetch_business';
      try {
        // Shared with POST /api/extension/gmaps/capture — creates company +
        // business-contact + Lead-stage deal and dispatches enrichment when
        // the business has a website (Maps never shows emails).
        const ingest = await ingestGmapsBusiness(task.tenantId, task.masterAgentId ?? undefined, {
          name,
          category: typeof b.category === 'string' ? b.category : undefined,
          address: typeof b.address === 'string' ? b.address : undefined,
          phone: typeof b.phone === 'string' ? b.phone : undefined,
          website: typeof b.website === 'string' ? b.website : undefined,
          rating: typeof b.rating === 'number' ? b.rating : null,
          reviewCount: typeof b.reviewCount === 'number' ? b.reviewCount : null,
          reviewsCount: typeof b.reviewsCount === 'number' ? b.reviewsCount : null,
          mapsUrl,
          searchQuery: typeof params.query === 'string' ? params.query : undefined,
          location: typeof params.location === 'string' ? params.location : undefined,
          // Place-detail-only fields (present on fetch_business results).
          hours: (typeof b.hours === 'string' || (b.hours && typeof b.hours === 'object'))
            ? (b.hours as string | Record<string, string>) : undefined,
          priceLevel: typeof b.priceLevel === 'string' ? b.priceLevel : undefined,
          description: typeof b.description === 'string' ? b.description : undefined,
          serviceOptions: Array.isArray(b.serviceOptions) ? (b.serviceOptions as string[]) : undefined,
          plusCode: typeof b.plusCode === 'string' ? b.plusCode : undefined,
          coordinates: (b.coordinates && typeof b.coordinates === 'object')
            ? (b.coordinates as { lat: number; lng: number }) : undefined,
          menuLink: typeof b.menuLink === 'string' ? b.menuLink : undefined,
          photoUrls: Array.isArray(b.photoUrls) ? (b.photoUrls as string[]) : undefined,
          pricePerPerson: typeof b.pricePerPerson === 'string' ? b.pricePerPerson : undefined,
          directionsUrl: typeof b.directionsUrl === 'string' ? b.directionsUrl : undefined,
          reviewsHtml: typeof b.reviewsHtml === 'string' ? b.reviewsHtml : undefined,
          ratingDistribution: Array.isArray(b.ratingDistribution)
            ? (b.ratingDistribution as Array<{ label: string }>) : undefined,
          aboutHtml: typeof b.aboutHtml === 'string' ? b.aboutHtml : undefined,
          detailFetched: isDetail,
        });
        saved++;
        // Every business with a place URL gets one place-detail scrape (it has
        // phone/hours/menu the search card lacks). Fan out a fetch_business when
        // ingest reports the row still needs detailing — a fetch_business result
        // has detailFetched=true (needsDetail=false), so it never fans out from
        // itself. The completion re-enters ingest, backfilling the contact and
        // dispatching enrichment for a newly-known website + menu vision.
        if (ingest.needsDetail && mapsUrl) {
          detailFanout.push({
            masterAgentId: task.masterAgentId ?? undefined,
            site: 'gmaps',
            type: 'fetch_business',
            params: { mapsUrl },
            priority: 6,
          });
        }
      } catch (err) {
        logger.debug({ err, name }, 'Skipped invalid gmaps business');
      }
    }
    if (detailFanout.length > 0) {
      try {
        await enqueueExtensionTaskBatch(task.tenantId, detailFanout);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), count: detailFanout.length, taskId: task.id },
          'gmaps fetch_business fanout enqueue failed (non-fatal)',
        );
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

// Defensive sanitiser for person names coming from the LinkedIn extension.
// LinkedIn's accessibility markup concatenates the visible name with a
// screen-reader span like "View NAME's profile" and `textContent` reads both
// with no separator → "Saurabh KaushikView Saurabh Kaushik's profile".
// We:
//   1. Extract the inner NAME from any embedded "View NAME's profile" pattern.
//   2. Otherwise strip a trailing "View ... profile" suffix.
//   3. Reject anything that still contains "view"/"profile" as a word, or that
//      lacks a sensible first-last shape.
export function sanitizePersonName(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 2) return null;

  // Pattern A: "View NAME('s) profile" embedded → use NAME (the full name).
  // Accept straight, curly, and back-tick apostrophes — LinkedIn's HTML uses
  // U+2019 (right single quotation mark) by default, which the previous
  // ASCII-only `'` class missed entirely.
  const inner = name.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
  if (inner && inner[1]) {
    const candidate = inner[1].trim();
    if (candidate.length >= 2 && candidate.length <= 100) name = candidate;
  } else {
    // Pattern B: trailing "View ... profile" → strip.
    name = name.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
  }

  // Pattern C: bare concatenation residue with no trailing " profile" — strip
  // anything from `View` onward when `View` follows a letter (LinkedIn's
  // visible-name + screen-reader-suffix concat always lower→upper-case
  // boundary like "SeveroView"). Prevents leftover "SeveroView" from passing
  // the `\bView\b` reject below, since `\b` doesn't fire between two
  // word-characters.
  name = name.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();

  // Strip trailing punctuation residue.
  name = name.replace(/[‘’'"`]+\s*$/, '').trim();

  if (name.length < 2 || name.length > 100) return null;
  // Reject any residual screen-reader artefact. `View\b` covers both
  // "SeveroView" (boundary at end of string) and standalone " View …".
  if (/View\b/i.test(name)) return null;
  if (/\bprofile\b/i.test(name)) return null;
  if (/%[0-9A-Fa-f]{2}/.test(name)) return null;
  return name;
}

// Score a job title by how useful the person is for outreach / hiring-signal
// follow-up. Higher = more useful (decision-maker or recruiter). Uses
// substring matching on the lowercased title — LinkedIn titles vary widely
// in punctuation/casing, so word-boundary regex is too brittle.
function scorePersonTitle(title: string | undefined | null): number {
  if (!title) return 0;
  const t = title.toLowerCase();

  // Tier 1 — C-suite / founders / owners (top decision-makers).
  if (/\b(ceo|cto|cfo|coo|cmo|chro|cio|ciso)\b/.test(t)) return 100;
  if (/chief\s+\w+(?:\s+\w+)?\s+officer/.test(t)) return 100;
  if (/\b(founder|co[\s-]?founder|owner|president|managing\s+director|managing\s+partner)\b/.test(t)) return 100;

  // Tier 2 — Talent acquisition / HR / recruiting (literally posting the job).
  if (/\b(talent\s+(acquisition|partner|manager|lead|director))\b/.test(t)) return 90;
  if (/\b(recruit(er|ing|ment)?|sourcer|head\s+of\s+(talent|people|hr))\b/.test(t)) return 90;
  if (/\b(hr\s+(director|manager|partner|lead)|chief\s+people|people\s+(ops|operations|partner))\b/.test(t)) return 85;
  if (/\b(hiring\s+manager)\b/.test(t)) return 85;

  // Tier 3 — VPs and Heads of (functional leadership).
  if (/\bvp\b|vice\s+president/.test(t)) return 75;
  if (/\bhead\s+of\b/.test(t)) return 70;

  // Tier 4 — Directors and Principal-level.
  if (/\b(director|principal)\b/.test(t)) return 55;

  // Tier 5 — Functional managers / leads (engineering manager, team lead).
  if (/\b(engineering|product|design|sales|marketing|operations)\s+(manager|lead|director)\b/.test(t)) return 40;
  if (/\b(tech\s+lead|team\s+lead|staff\s+engineer)\b/.test(t)) return 35;

  // Tier 6 — Generic manager / lead.
  if (/\b(manager|lead)\b/.test(t)) return 25;

  // Tier 7 — Individual contributors (engineers, developers, analysts, etc.)
  return 5;
}

// Rank people by title relevance — pure prioritisation, no filtering. Every
// person LinkedIn returned is preserved; the top 10 by score get saved.
// Decision-makers (CEO/CTO/Founder, recruiters, VPs, directors) bubble to
// the top; engineers and analysts sink to the bottom but still land in the
// list when there's room.
function rankPeopleByTitle<T extends { title: string }>(people: readonly T[]): T[] {
  return [...people].sort((a, b) => scorePersonTitle(b.title) - scorePersonTitle(a.title));
}

/**
 * Merge a new keyword-scoped people batch into the existing
 * companies.rawData. Returns both the per-keyword map and a deduped flat
 * list (by linkedinUrl, falling back to lowercased name) for backwards
 * compatibility with readers that expect `rawData.people` as a flat array.
 */
function mergePeopleByKeyword(
  existingFlat: unknown,
  existingByKeyword: Record<string, unknown>,
  bucketKey: string,
  newPeople: Array<{ name: string; title: string; linkedinUrl: string }>,
): { byKeyword: Record<string, typeof newPeople>; flat: typeof newPeople } {
  const byKeyword: Record<string, typeof newPeople> = {};
  for (const [k, v] of Object.entries(existingByKeyword)) {
    if (Array.isArray(v)) byKeyword[k] = v as typeof newPeople;
  }
  byKeyword[bucketKey] = newPeople;

  // Build a deduped union across all buckets, falling back on the legacy
  // flat list if the byKeyword map is otherwise empty.
  const seen = new Set<string>();
  const flat: typeof newPeople = [];
  const pushUnique = (p: { name: string; title: string; linkedinUrl: string }) => {
    const id = (p.linkedinUrl || '').toLowerCase().trim() || (p.name || '').toLowerCase().trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    flat.push(p);
  };
  for (const list of Object.values(byKeyword)) {
    for (const p of list) pushUnique(p);
  }
  if (flat.length === 0 && Array.isArray(existingFlat)) {
    for (const p of existingFlat as typeof newPeople) pushUnique(p);
  }
  return { byKeyword, flat };
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

// Touch lastSeenAt only — used as a real liveness signal from the WS ping
// handler so stale lastSeenAt actually means the SW is dead, not just that
// no reconnect happened. Caller throttles to ≤1 write per 10s per session.
export async function touchSessionLastSeen(sessionId: string): Promise<void> {
  const { db } = await import('../config/database.js');
  await db
    .update(extensionSessions)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(extensionSessions.id, sessionId));
}

// tenantId is null for multi-workspace sessions (post-0029 migration); the
// dispatcher uses userId + user_tenants to fan out across the user's
// workspaces. Legacy per-tenant sessions still carry a non-null tenantId.
export async function findSessionByApiKeyHash(apiKeyHash: string): Promise<{ id: string; tenantId: string | null; userId: string } | null> {
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

// ─── Parallel-fetch completion handlers ─────────────────────────────────────
//
// These split the legacy fetch_company logic into two independent handlers:
//
//   handleCompanyInfoComplete:
//     Merges about-page fields (industry, size, HQ, description, etc.) into
//     the company row. Sets rawData.infoFetchedAt. Dispatches enrichment
//     (we have the real domain). Triggers the fit scorer.
//
//   handleCompanyTeamComplete:
//     Merges the people array into rawData.people. Sets rawData.teamFetchedAt.
//     Inserts the top-3 ranked people as contacts (preserving existing
//     outreach behaviour). Dispatches per-contact enrichment. Triggers the
//     fit scorer.
//
// Each handler tolerates the other not having run yet — the fit scorer reads
// data_completeness from whichever fetched-at flags are present.

async function handleCompanyInfoComplete(
  task: ExtensionTask,
  c: Record<string, unknown>,
): Promise<{ extracted: number; saved: number }> {
  const name = String(c.name ?? '').trim();
  const p = task.params as { linkedinUrl?: string; companyId?: string };
  if (!name && !p.companyId) {
    logger.debug({ taskId: task.id }, 'fetch_company_info: no name + no companyId, skipping');
    return { extracted: 0, saved: 0 };
  }

  // Merge into companies row. saveOrUpdateCompanyStatic is id → domain → name
  // so passing companyId from the auto-chain hits the exact row.
  const savedCompany = await saveOrUpdateCompanyStatic(
    task.tenantId,
    {
      id: p.companyId,
      name: name || 'unknown',
      domain: typeof c.website === 'string' ? extractDomain(c.website) : undefined,
      industry: (c.industry as string) ?? undefined,
      size: (c.size as string) ?? undefined,
      linkedinUrl: (c.linkedinUrl as string) ?? p.linkedinUrl,
      description: (c.description as string) ?? undefined,
      rawData: { source: 'linkedin_extension_info', infoFetchedAt: new Date().toISOString(), ...c },
    },
    task.masterAgentId ?? undefined,
  );

  // Dispatch enrichment now that we have the real domain.
  await dispatchJob(task.tenantId, 'enrichment', {
    companyId: savedCompany.id,
    masterAgentId: task.masterAgentId ?? undefined,
    source: 'linkedin_extension_info',
  });

  // Trigger fit scorer asynchronously. The worker debounces within 30s so a
  // sibling team_arrived event fired moments later won't double-score.
  if (task.masterAgentId) {
    try {
      await enqueueFitScore({
        tenantId: task.tenantId,
        companyId: savedCompany.id,
        reason: 'info_arrived',
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), companyId: savedCompany.id },
        'enqueueFitScore after info_arrived failed (non-fatal)',
      );
    }
  }

  logger.info(
    { taskId: task.id, companyId: savedCompany.id, name: savedCompany.name },
    'fetch_company_info complete',
  );
  return { extracted: 1, saved: 1 };
}

async function handleCompanyTeamComplete(
  task: ExtensionTask,
  c: Record<string, unknown>,
): Promise<{ extracted: number; saved: number }> {
  const p = task.params as { linkedinUrl?: string; companyId?: string; keyword?: string };
  const rawPeople = (c.people ?? []) as Array<{ name: string; title: string; linkedinUrl: string }>;
  const taskKeyword = (typeof p.keyword === 'string' && p.keyword.trim()) ? p.keyword.trim() : null;
  // Defensive: also accept the extension echoing the keyword back on the
  // result payload — useful if dispatcher → extension param plumbing ever
  // drifts.
  const resultKeyword = (typeof c.keyword === 'string' && c.keyword.trim()) ? c.keyword.trim() : null;
  const keyword = taskKeyword ?? resultKeyword;
  const bucketKey = keyword ?? '__legacy__';

  // Find the target company row. Direct-merge into rawData; we deliberately
  // do NOT go through saveOrUpdateCompanyStatic because that helper requires
  // a name and would clobber the company name if the team handler arrives
  // without one.
  const savedCompany = await withTenant(task.tenantId, async (tx) => {
    let row: typeof companies.$inferSelect | undefined;
    if (p.companyId) {
      [row] = await tx.select().from(companies)
        .where(and(eq(companies.tenantId, task.tenantId), eq(companies.id, p.companyId)))
        .limit(1);
    }
    if (!row && p.linkedinUrl) {
      [row] = await tx.select().from(companies)
        .where(and(eq(companies.tenantId, task.tenantId), eq(companies.linkedinUrl, p.linkedinUrl)))
        .limit(1);
    }
    if (!row) return null;

    const existingRaw = (row.rawData ?? {}) as Record<string, unknown>;
    const existingByKeyword = (existingRaw.peopleByKeyword as Record<string, unknown> | undefined) ?? {};
    const mergedPeople = mergePeopleByKeyword(existingRaw.people, existingByKeyword, bucketKey, rawPeople);

    const [updated] = await tx.update(companies).set({
      rawData: {
        ...existingRaw,
        // Keep `people` populated with the deduped union for backwards
        // compatibility with anything reading the flat list.
        people: mergedPeople.flat,
        peopleByKeyword: mergedPeople.byKeyword,
        teamFetchedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    }).where(eq(companies.id, row.id)).returning();
    return updated;
  });

  if (!savedCompany) {
    logger.warn({ taskId: task.id, companyId: p.companyId, linkedinUrl: p.linkedinUrl, keyword }, 'fetch_company_team: no target company row found');
    return { extracted: rawPeople.length, saved: 0 };
  }

  // With keyword-scoped fetches the candidate pool is already role-filtered,
  // so the title-score ranking is just a tiebreaker. Save up to 5 per
  // keyword fetch (was 3 in the unfiltered world) since each fetch returns
  // intentionally targeted hits.
  const rankedPeople = rankPeopleByTitle(rawPeople);
  let savedCount = 0;
  for (const person of rankedPeople.slice(0, 5)) {
    const cleanName = sanitizePersonName(person.name);
    if (!cleanName) {
      logger.debug({ raw: person.name, linkedinUrl: person.linkedinUrl }, 'Skipping person with corrupted/invalid name');
      continue;
    }
    const nameParts = cleanName.split(/\s+/);
    const pFirstName = nameParts[0] || '';
    const pLastName = nameParts.slice(1).join(' ');
    if (!pFirstName) continue;
    if (/^(view|profile)$/i.test(pFirstName) || (pLastName && /\b(view|profile)\b/i.test(pLastName))) {
      logger.debug({ pFirstName, pLastName }, 'Skipping person — name parts contain view/profile junk');
      continue;
    }

    try {
      if (person.linkedinUrl) {
        const [existing] = await withTenant(task.tenantId, async (tx) => {
          const conds = [
            eq(contacts.tenantId, task.tenantId),
            eq(contacts.linkedinUrl, person.linkedinUrl),
          ];
          if (task.masterAgentId) {
            conds.push(eq(contacts.masterAgentId, task.masterAgentId));
            conds.push(eq(contacts.companyId, savedCompany.id));
          }
          return tx.select({ id: contacts.id }).from(contacts)
            .where(and(...conds))
            .limit(1);
        });
        if (existing) {
          logger.info(
            {
              taskId: task.id,
              personLinkedinUrl: person.linkedinUrl,
              masterAgentId: task.masterAgentId,
              companyId: savedCompany.id,
              existingContactId: existing.id,
            },
            'fetch_company_team: contact dedup matched — skipping insert',
          );
          continue;
        }
      }

      const [inserted] = await withTenant(task.tenantId, async (tx) => {
        return tx.insert(contacts).values({
          tenantId: task.tenantId,
          masterAgentId: task.masterAgentId ?? undefined,
          firstName: pFirstName,
          lastName: pLastName,
          title: sanitizeTitle(person.title),
          linkedinUrl: person.linkedinUrl || undefined,
          companyId: savedCompany.id,
          companyName: savedCompany.name,
          source: 'linkedin_profile',
          // New Sales Operations source-type vocabulary, in parallel with the
          // legacy `source` enum above. New code reads source_type.
          sourceType: 'ai_discovery',
          sourceMetadata: { discoverySource: 'linkedin_extension_people' },
          rawData: { discoverySource: 'linkedin_extension_people', ...person },
        }).returning({ id: contacts.id });
      });

      if (inserted) {
        savedCount++;
        // Mirror the contact to prospect_stages so the Stage 2 detail page +
        // Stage 3 triage worker see a row. Best-effort; failure is non-fatal.
        try {
          await withTenant(task.tenantId, async (tx) => {
            await tx.insert(prospectStages).values({
              contactId: inserted.id,
              tenantId: task.tenantId,
              currentStage: 'new',
            }).onConflictDoNothing();
          });
        } catch (err) {
          logger.debug({ err, contactId: inserted.id }, 'Failed to seed prospect_stages for AI-discovered contact (non-fatal)');
        }
        // Append a timeline event so the contact's history shows where
        // they came from. Best-effort; failure must not abort the dispatch.
        try {
          await logEvent({
            tenantId: task.tenantId,
            contactId: inserted.id,
            type: 'contact_added',
            eventCategory: 'discovery',
            actorType: 'system',
            masterAgentId: task.masterAgentId ?? undefined,
            title: 'Discovered via LinkedIn team scan',
            metadata: {
              sourceType: 'ai_discovery',
              discoverySource: 'linkedin_extension_people',
              companyId: savedCompany.id,
              companyName: savedCompany.name,
              taskId: task.id,
            },
          });
        } catch (err) {
          logger.debug({ err, contactId: inserted.id }, 'Failed to log contact_added event (non-fatal)');
        }
        if (task.masterAgentId) {
          try {
            await dispatchJob(task.tenantId, 'enrichment', {
              contactId: inserted.id,
              masterAgentId: task.masterAgentId,
              source: 'linkedin_extension_people',
            });
          } catch (err) {
            logger.debug({ err, contactId: inserted.id }, 'Failed to dispatch per-contact enrichment (non-fatal)');
          }
        }
      }
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined,
          personName: person.name,
          personLinkedinUrl: person.linkedinUrl,
          taskId: task.id,
          masterAgentId: task.masterAgentId,
          companyId: savedCompany.id,
        },
        'fetch_company_team: contact insert FAILED',
      );
    }
  }

  // Trigger fit scorer asynchronously (debounced; see worker).
  if (task.masterAgentId) {
    try {
      await enqueueFitScore({
        tenantId: task.tenantId,
        companyId: savedCompany.id,
        reason: 'team_arrived',
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), companyId: savedCompany.id },
        'enqueueFitScore after team_arrived failed (non-fatal)',
      );
    }
  }

  if (rawPeople.length > 0 && savedCount === 0) {
    logger.warn(
      {
        taskId: task.id,
        companyId: savedCompany.id,
        peopleScraped: rawPeople.length,
        contactsSaved: savedCount,
        sampleNames: rawPeople.slice(0, 3).map((p) => p.name),
      },
      'fetch_company_team: scraped people but saved 0 contacts (silent drop — investigate sanitizer or dedup)',
    );
  } else {
    logger.info(
      { taskId: task.id, companyId: savedCompany.id, peopleScraped: rawPeople.length, contactsSaved: savedCount },
      'fetch_company_team complete',
    );
  }
  return { extracted: rawPeople.length, saved: savedCount };
}

