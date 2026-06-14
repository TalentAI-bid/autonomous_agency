import { eq, and, lte, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import {
  followupSequences,
  deals,
  crmStages,
  contacts,
  prospectStages,
  prospectActions,
  type CrmStage,
} from '../db/schema/index.js';
import {
  getTenantCadence,
  resolveIntervals,
  computeNextDue,
  type CadenceStrategy,
} from './followup-cadence.service.js';
import logger from '../utils/logger.js';

/**
 * CRM-pipeline-driven follow-up engine.
 *
 * Tracks per-deal sequence state (followup_sequences) for leads sitting in
 * follow-up-eligible user-defined stages (crm_stages.follow_up_eligible) and
 * surfaces due follow-ups as Daily Queue cards via triage Rule N.
 *
 * Touch intents: touch 1 = the offer (first_followup), touch 2 = lower-friction
 * ask (second_followup), final touch = polite breakup (breakup).
 *
 * Review-and-send only — the engine never sends anything itself.
 */

export const ENGINE_REASON_PREFIX = 'FollowupEngine';

// ─── Lifecycle ──────────────────────────────────────────────────────

/**
 * Start (or restart) the sequence for a deal that just entered a
 * follow-up-eligible stage. Anchors at the contact's real last touch when
 * known so the first nudge waits the configured interval from that touch.
 */
export async function ensureSequenceForDeal(tenantId: string, dealId: string): Promise<void> {
  const [deal] = await withTenant(tenantId, async (tx) =>
    tx.select({ id: deals.id, contactId: deals.contactId })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.tenantId, tenantId)))
      .limit(1),
  );
  if (!deal) return;

  const [ps] = await withTenant(tenantId, async (tx) =>
    tx.select({ lastTouchAt: prospectStages.lastTouchAt })
      .from(prospectStages)
      .where(eq(prospectStages.contactId, deal.contactId))
      .limit(1),
  );
  const anchor = ps?.lastTouchAt ?? new Date();

  const [existing] = await withTenant(tenantId, async (tx) =>
    tx.select().from(followupSequences).where(eq(followupSequences.dealId, dealId)).limit(1),
  );

  const cadence = await getTenantCadence(tenantId);
  const intervals = resolveIntervals(cadence, existing?.cadenceOverride ?? null);
  const nextDueAt = computeNextDue(anchor, 0, intervals);

  if (existing) {
    if (existing.status === 'active') return; // already running — don't reset progress
    await withTenant(tenantId, async (tx) => {
      await tx.update(followupSequences)
        .set({
          status: 'active',
          touchNumber: 0,
          lastTouchAt: anchor,
          nextDueAt,
          haltReason: null,
          updatedAt: new Date(),
        })
        .where(eq(followupSequences.dealId, dealId));
    });
    logger.info({ tenantId, dealId }, 'followup-engine: sequence reactivated');
    return;
  }

  await withTenant(tenantId, async (tx) => {
    await tx.insert(followupSequences)
      .values({
        dealId,
        tenantId,
        contactId: deal.contactId,
        status: 'active',
        touchNumber: 0,
        lastTouchAt: anchor,
        nextDueAt,
      })
      .onConflictDoNothing({ target: followupSequences.dealId });
  });
  logger.info({ tenantId, dealId, nextDueAt }, 'followup-engine: sequence started');
}

/** Halt the sequence and supersede any pending engine card for the company. */
export async function haltSequenceForDeal(tenantId: string, dealId: string, reason: string): Promise<void> {
  const [seq] = await withTenant(tenantId, async (tx) =>
    tx.update(followupSequences)
      .set({ status: 'halted', haltReason: reason, updatedAt: new Date() })
      .where(and(
        eq(followupSequences.dealId, dealId),
        eq(followupSequences.tenantId, tenantId),
        eq(followupSequences.status, 'active'),
      ))
      .returning({ contactId: followupSequences.contactId }),
  );
  if (!seq) return;
  logger.info({ tenantId, dealId, reason }, 'followup-engine: sequence halted');
  await supersedePendingEngineActions(tenantId, seq.contactId);
}

async function supersedePendingEngineActions(tenantId: string, contactId: string): Promise<void> {
  try {
    const [contact] = await withTenant(tenantId, async (tx) =>
      tx.select({ companyId: contacts.companyId }).from(contacts).where(eq(contacts.id, contactId)).limit(1),
    );
    if (!contact?.companyId) return;
    await withTenant(tenantId, async (tx) => {
      await tx.update(prospectActions)
        .set({ status: 'superseded' })
        .where(and(
          eq(prospectActions.tenantId, tenantId),
          eq(prospectActions.companyId, contact.companyId!),
          eq(prospectActions.status, 'pending'),
          sql`${prospectActions.priorityReason} LIKE ${ENGINE_REASON_PREFIX + '%'}`,
        ));
    });
  } catch (err) {
    logger.warn({ err, tenantId, contactId }, 'followup-engine: failed to supersede pending engine actions');
  }
}

/**
 * Stage-change hook (called from moveDealStage). Eligible stage → ensure or
 * reactivate the sequence; anything else (incl. won/lost) → halt.
 */
export async function onDealStageChanged(
  tenantId: string,
  dealId: string,
  newStage: Pick<CrmStage, 'name' | 'followUpEligible' | 'isWon' | 'isLost'>,
): Promise<void> {
  if (newStage.followUpEligible && !newStage.isWon && !newStage.isLost) {
    await ensureSequenceForDeal(tenantId, dealId);
  } else {
    await haltSequenceForDeal(tenantId, dealId, `left eligible stage (now "${newStage.name}")`);
  }
}

/** Reply hook (called from recordResponse) — a reply halts the sequence. */
export async function onReplyDetected(tenantId: string, contactId: string): Promise<void> {
  const rows = await withTenant(tenantId, async (tx) =>
    tx.update(followupSequences)
      .set({ status: 'halted', haltReason: 'lead replied', updatedAt: new Date() })
      .where(and(
        eq(followupSequences.tenantId, tenantId),
        eq(followupSequences.contactId, contactId),
        eq(followupSequences.status, 'active'),
      ))
      .returning({ dealId: followupSequences.dealId }),
  );
  if (rows.length > 0) {
    logger.info({ tenantId, contactId }, 'followup-engine: sequence halted — lead replied');
    await supersedePendingEngineActions(tenantId, contactId);
  }
}

/**
 * Queue-complete hook: the user sent an engine follow-up. Advance the touch
 * counter and schedule the next one (or complete the sequence).
 */
export async function onSequenceTouchCompleted(tenantId: string, contactId: string): Promise<void> {
  const [seq] = await withTenant(tenantId, async (tx) =>
    tx.select().from(followupSequences)
      .where(and(
        eq(followupSequences.tenantId, tenantId),
        eq(followupSequences.contactId, contactId),
        eq(followupSequences.status, 'active'),
      ))
      .limit(1),
  );
  if (!seq) return;

  const cadence = await getTenantCadence(tenantId);
  const intervals = resolveIntervals(cadence, seq.cadenceOverride);
  const now = new Date();
  const newTouchNumber = seq.touchNumber + 1;
  const nextDueAt = computeNextDue(now, newTouchNumber, intervals);

  await withTenant(tenantId, async (tx) => {
    await tx.update(followupSequences)
      .set({
        touchNumber: newTouchNumber,
        lastTouchAt: now,
        nextDueAt,
        status: nextDueAt === null ? 'completed' : 'active',
        updatedAt: now,
      })
      .where(eq(followupSequences.dealId, seq.dealId));
  });
  logger.info(
    { tenantId, contactId, touchNumber: newTouchNumber, nextDueAt, completed: nextDueAt === null },
    'followup-engine: touch completed',
  );
}

// ─── Daily due-scan (consumed by triage Rule N) ─────────────────────

export interface EngineMatch {
  companyId: string;
  contactId: string;
  /** The upcoming follow-up, 1-based. */
  touchNumber: number;
  stageName: string;
  channelTarget: 'linkedin_dm' | 'email';
  actionType: 'linkedin_dm_followup' | 'email_followup' | 'breakup_message';
  draftHint: 'first_followup' | 'second_followup' | 'breakup';
  priority: 'P2' | 'P3';
  whyNow: string;
  priorityReason: string;
}

/**
 * Find every active sequence that is due, self-heal stale ones (replied /
 * stage no longer eligible / no contact channel), and collapse to the single
 * most-overdue deal per company (the Daily Queue allows one pending action
 * per company).
 */
export async function scanDueSequences(tenantId: string): Promise<EngineMatch[]> {
  const now = new Date();
  const rows = await withTenant(tenantId, async (tx) =>
    tx.select({
      dealId: followupSequences.dealId,
      contactId: followupSequences.contactId,
      touchNumber: followupSequences.touchNumber,
      seqLastTouchAt: followupSequences.lastTouchAt,
      nextDueAt: followupSequences.nextDueAt,
      cadenceOverride: followupSequences.cadenceOverride,
      stageName: crmStages.name,
      stageEligible: crmStages.followUpEligible,
      stageWon: crmStages.isWon,
      stageLost: crmStages.isLost,
      companyId: contacts.companyId,
      contactEmail: contacts.email,
      contactLinkedin: contacts.linkedinUrl,
      contactDnc: contacts.doNotContact,
      psLastResponseAt: prospectStages.lastResponseAt,
    })
      .from(followupSequences)
      .innerJoin(deals, eq(deals.id, followupSequences.dealId))
      .innerJoin(crmStages, eq(crmStages.id, deals.stageId))
      .innerJoin(contacts, eq(contacts.id, followupSequences.contactId))
      .leftJoin(prospectStages, eq(prospectStages.contactId, followupSequences.contactId))
      .where(and(
        eq(followupSequences.tenantId, tenantId),
        eq(followupSequences.status, 'active'),
        lte(followupSequences.nextDueAt, now),
      )),
  );

  const cadence = await getTenantCadence(tenantId);
  const candidates: Array<EngineMatch & { overdueMs: number }> = [];

  for (const r of rows) {
    // Self-healing safety net — the lifecycle hooks are primary, this catches
    // anything that slipped through (e.g. stage reclassified, missed hook).
    if (!r.stageEligible || r.stageWon || r.stageLost) {
      await haltSequenceForDeal(tenantId, r.dealId, 'stage no longer follow-up-eligible');
      continue;
    }
    if (r.psLastResponseAt && r.seqLastTouchAt && r.psLastResponseAt > r.seqLastTouchAt) {
      await haltSequenceForDeal(tenantId, r.dealId, 'lead replied');
      continue;
    }
    if (r.contactDnc) {
      await haltSequenceForDeal(tenantId, r.dealId, 'contact marked do-not-contact');
      continue;
    }
    if (!r.contactEmail && !r.contactLinkedin) {
      await haltSequenceForDeal(tenantId, r.dealId, 'no contact channel (no email, no linkedin)');
      continue;
    }
    if (!r.companyId) {
      // The Daily Queue is company-keyed; a contact without a company can't
      // surface there. Leave the sequence active and log — it will surface
      // once the contact gets linked to a company.
      logger.warn({ tenantId, dealId: r.dealId, contactId: r.contactId }, 'followup-engine: due sequence skipped — contact has no company');
      continue;
    }

    const intervals = resolveIntervals(cadence, r.cadenceOverride);
    const upcomingTouch = r.touchNumber + 1;
    const isFinalTouch = upcomingTouch >= intervals.length;
    const channel: 'linkedin_dm' | 'email' = r.contactLinkedin ? 'linkedin_dm' : 'email';
    const daysSince = r.seqLastTouchAt
      ? Math.max(0, Math.round((now.getTime() - r.seqLastTouchAt.getTime()) / (24 * 3600 * 1000)))
      : 0;

    candidates.push({
      companyId: r.companyId,
      contactId: r.contactId,
      touchNumber: upcomingTouch,
      stageName: r.stageName,
      channelTarget: channel,
      actionType: isFinalTouch ? 'breakup_message' : channel === 'linkedin_dm' ? 'linkedin_dm_followup' : 'email_followup',
      draftHint: isFinalTouch ? 'breakup' : upcomingTouch === 1 ? 'first_followup' : 'second_followup',
      priority: isFinalTouch ? 'P3' : 'P2',
      whyNow: `In "${r.stageName}", follow-up #${upcomingTouch} — ${daysSince}d since last touch.`,
      priorityReason: `${ENGINE_REASON_PREFIX} touch ${upcomingTouch}`,
      overdueMs: r.nextDueAt ? now.getTime() - r.nextDueAt.getTime() : 0,
    });
  }

  // One per company — keep the most-overdue deal.
  const byCompany = new Map<string, EngineMatch & { overdueMs: number }>();
  for (const c of candidates) {
    const existing = byCompany.get(c.companyId);
    if (!existing || c.overdueMs > existing.overdueMs) byCompany.set(c.companyId, c);
  }
  return Array.from(byCompany.values()).map(({ overdueMs: _o, ...m }) => m);
}

/** Per-lead cadence override setter (used by deals PATCH). */
export async function setSequenceCadenceOverride(
  tenantId: string,
  dealId: string,
  override: CadenceStrategy | null,
): Promise<void> {
  const [seq] = await withTenant(tenantId, async (tx) =>
    tx.select().from(followupSequences)
      .where(and(eq(followupSequences.dealId, dealId), eq(followupSequences.tenantId, tenantId)))
      .limit(1),
  );
  if (!seq) return;
  const cadence = await getTenantCadence(tenantId);
  const intervals = resolveIntervals(cadence, override);
  const nextDueAt = seq.lastTouchAt ? computeNextDue(seq.lastTouchAt, seq.touchNumber, intervals) : seq.nextDueAt;
  await withTenant(tenantId, async (tx) => {
    await tx.update(followupSequences)
      .set({ cadenceOverride: override, ...(seq.status === 'active' ? { nextDueAt } : {}), updatedAt: new Date() })
      .where(eq(followupSequences.dealId, dealId));
  });
}
