import { eq, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { prospectStages, contacts } from '../db/schema/index.js';
import type { ProspectStage } from '../db/schema/index.js';
import { logEvent } from './timeline.service.js';
import { recordCompanyTouch, recordCompanyResponse } from './company-stage.service.js';
import type { CrmActorType } from '../db/schema/index.js';
import logger from '../utils/logger.js';

async function lookupCompanyId(tenantId: string, contactId: string): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    return row?.companyId ?? null;
  });
}

/**
 * Pipeline stage tracking. Wraps prospect_stages mutations + emits stage_change
 * timeline events when a transition actually happens. Every helper is
 * idempotent and never demotes — recordTouch on an already-engaged contact is
 * a no-op for stage, but still bumps total_touches / last_touch_at.
 */

const STAGE_ORDER: Record<ProspectStage, number> = {
  new: 0,
  first_touch_sent: 1,
  awaiting_response: 2,
  engaged: 3,
  qualified: 4,
  meeting_scheduled: 5,
  in_evaluation: 6,
  closed_won: 7,
  closed_lost: 7,
  cold: 1,
  dnc: 9,
};

const TERMINAL: ReadonlySet<ProspectStage> = new Set(['closed_won', 'closed_lost', 'dnc']);

export type TouchChannel = 'email' | 'linkedin_dm' | 'linkedin_connect' | 'whatsapp' | 'phone';

async function getStage(tenantId: string, contactId: string): Promise<ProspectStage | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ stage: prospectStages.currentStage })
      .from(prospectStages)
      .where(eq(prospectStages.contactId, contactId))
      .limit(1);
    return row?.stage ?? null;
  });
}

async function getTenantIdForContact(contactId: string): Promise<string | null> {
  const [row] = await (await import('../config/database.js')).db
    .select({ tenantId: contacts.tenantId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .limit(1);
  return row?.tenantId ?? null;
}

/**
 * Force-transition a contact to a specific stage. Logs stage_change if the
 * stage actually moves. Used by explicit user actions (DNC, mark-dead, etc.)
 * and by reply.agent / inbox-copilot for inbound-driven transitions.
 */
export async function transitionStage(args: {
  tenantId: string;
  contactId: string;
  toStage: ProspectStage;
  reason?: string;
  actorType: CrmActorType;
  actorUserId?: string | null;
}): Promise<{ from: ProspectStage | null; to: ProspectStage; changed: boolean }> {
  const { tenantId, contactId, toStage, reason, actorType, actorUserId } = args;

  const from = await getStage(tenantId, contactId);
  if (from === toStage) return { from, to: toStage, changed: false };

  await withTenant(tenantId, async (tx) => {
    await tx
      .insert(prospectStages)
      .values({
        contactId,
        tenantId,
        currentStage: toStage,
        stageEnteredAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: prospectStages.contactId,
        set: {
          currentStage: toStage,
          stageEnteredAt: new Date(),
          updatedAt: new Date(),
        },
      });
  });

  try {
    await logEvent({
      tenantId,
      contactId,
      type: 'stage_change',
      eventCategory: 'status_change',
      actorType,
      actorUserId: actorUserId ?? undefined,
      title: `Stage ${from ?? 'new'} → ${toStage}`,
      description: reason,
      metadata: { from, to: toStage, reason },
    });
  } catch (err) {
    logger.warn({ err, contactId }, 'transitionStage: failed to log stage_change event');
  }

  return { from, to: toStage, changed: true };
}

/**
 * Record an outbound touch. Increments total_touches + last_touch_at, and
 * auto-promotes stage 'new' → 'first_touch_sent' if applicable. Channel is
 * recorded in metadata only.
 */
export async function recordTouch(args: {
  tenantId: string;
  contactId: string;
  channel: TouchChannel;
  actorUserId?: string | null;
}): Promise<void> {
  const { tenantId, contactId, channel, actorUserId } = args;
  const now = new Date();

  const updated = await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .insert(prospectStages)
      .values({
        contactId,
        tenantId,
        currentStage: 'first_touch_sent',
        stageEnteredAt: now,
        totalTouches: 1,
        lastTouchAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: prospectStages.contactId,
        set: {
          totalTouches: sql`${prospectStages.totalTouches} + 1`,
          lastTouchAt: now,
          updatedAt: now,
          currentStage: sql`CASE
            WHEN ${prospectStages.currentStage} = 'new' THEN 'first_touch_sent'
            ELSE ${prospectStages.currentStage}
          END`,
          stageEnteredAt: sql`CASE
            WHEN ${prospectStages.currentStage} = 'new' THEN ${now}
            ELSE ${prospectStages.stageEnteredAt}
          END`,
        },
      })
      .returning({ currentStage: prospectStages.currentStage });
    return row;
  });

  if (updated?.currentStage === 'first_touch_sent') {
    try {
      await logEvent({
        tenantId,
        contactId,
        type: 'stage_change',
        eventCategory: 'status_change',
        actorType: actorUserId ? 'user' : 'system',
        actorUserId: actorUserId ?? undefined,
        title: 'Stage new → first_touch_sent',
        metadata: { from: 'new', to: 'first_touch_sent', via: channel },
      });
    } catch (err) {
      logger.warn({ err, contactId }, 'recordTouch: failed to log stage_change event');
    }
  }

  // Mirror the touch up to the company level so triage rules (which read
  // companies.{last_touch_at, total_outbound_touches, current_stage}) see it.
  const companyId = await lookupCompanyId(tenantId, contactId);
  if (companyId) {
    await recordCompanyTouch({ tenantId, companyId, channel });
  }
}

/**
 * Record an inbound response. Sets last_response_at and promotes to 'engaged'
 * if current stage is below it (and not terminal).
 */
export async function recordResponse(args: {
  tenantId: string;
  contactId: string;
  channel?: TouchChannel;
}): Promise<void> {
  const { tenantId, contactId } = args;
  const now = new Date();

  const before = await getStage(tenantId, contactId);

  await withTenant(tenantId, async (tx) => {
    await tx
      .insert(prospectStages)
      .values({
        contactId,
        tenantId,
        currentStage: 'engaged',
        stageEnteredAt: now,
        lastResponseAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: prospectStages.contactId,
        set: {
          lastResponseAt: now,
          updatedAt: now,
          currentStage: sql`CASE
            WHEN ${prospectStages.currentStage} IN ('closed_won','closed_lost','dnc','engaged','qualified','meeting_scheduled','in_evaluation')
              THEN ${prospectStages.currentStage}
            ELSE 'engaged'
          END`,
          stageEnteredAt: sql`CASE
            WHEN ${prospectStages.currentStage} IN ('closed_won','closed_lost','dnc','engaged','qualified','meeting_scheduled','in_evaluation')
              THEN ${prospectStages.stageEnteredAt}
            ELSE ${now}
          END`,
        },
      });
  });

  const after = await getStage(tenantId, contactId);
  if (before !== after && after === 'engaged' && !TERMINAL.has(before ?? 'new')) {
    try {
      await logEvent({
        tenantId,
        contactId,
        type: 'stage_change',
        eventCategory: 'status_change',
        actorType: 'recipient',
        title: `Stage ${before ?? 'new'} → engaged`,
        metadata: { from: before, to: 'engaged' },
      });
    } catch (err) {
      logger.warn({ err, contactId }, 'recordResponse: failed to log stage_change event');
    }
  }

  // Mirror the response up to the company level.
  const companyId = await lookupCompanyId(tenantId, contactId);
  if (companyId) {
    await recordCompanyResponse({ tenantId, companyId });
  }

  // Follow-up engine: a reply halts the lead's follow-up sequence.
  try {
    const { onReplyDetected } = await import('./followup-engine.service.js');
    await onReplyDetected(tenantId, contactId);
  } catch (err) {
    logger.warn({ err, contactId }, 'recordResponse: follow-up engine halt failed');
  }
}

export { getStage, getTenantIdForContact, STAGE_ORDER, TERMINAL };
