import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import {
  campaigns,
  campaignSteps,
  campaignContacts,
  contacts,
  masterAgents,
} from '../db/schema/index.js';
import logger from '../utils/logger.js';

// ─── Default sequence shape ────────────────────────────────────────────────
// Step 1 — initial (delay 0)        — sent by the existing outreach pipeline
// Step 2 — followup_short (+2 days) — brief check-in
// Step 3 — followup_value  (+5 days) — new angle / social proof
// Step 4 — followup_breakup (+10)   — polite close ("if not the right time...")

interface DefaultStep {
  stepNumber: number;
  delayDays: number;
  stepType: 'initial' | 'followup_short' | 'followup_value' | 'followup_breakup' | 'custom';
}

const DEFAULT_SEQUENCE: DefaultStep[] = [
  { stepNumber: 1, delayDays: 0,  stepType: 'initial' },
  { stepNumber: 2, delayDays: 2,  stepType: 'followup_short' },
  { stepNumber: 3, delayDays: 5,  stepType: 'followup_value' },
  { stepNumber: 4, delayDays: 10, stepType: 'followup_breakup' },
];

const FOLLOWUP_CAMPAIGN_NAME = 'Default follow-up sequence';

/**
 * Allow per-agent override via masterAgent.config.followupSequence:
 *   [{ stepNumber: 1, delayDays: 0, stepType: 'initial' }, ...]
 * Falls back to DEFAULT_SEQUENCE when missing or malformed.
 */
function resolveSequence(masterAgentConfig: Record<string, unknown> | null): DefaultStep[] {
  const cfg = (masterAgentConfig?.followupSequence as DefaultStep[] | undefined);
  if (!Array.isArray(cfg) || cfg.length === 0) return DEFAULT_SEQUENCE;
  // Light validation — every entry must have stepNumber + delayDays.
  const valid = cfg.every((s) =>
    typeof s.stepNumber === 'number' &&
    typeof s.delayDays === 'number' &&
    typeof s.stepType === 'string',
  );
  return valid ? cfg : DEFAULT_SEQUENCE;
}

/**
 * Idempotent — returns the campaignId of the default follow-up campaign for
 * this master agent, creating it (with the four default steps) on first call.
 *
 * Convention: the default campaign is keyed by (masterAgentId, name=
 * FOLLOWUP_CAMPAIGN_NAME, type='email'). Any custom campaigns the user
 * creates later live alongside; the followup-scheduler is agnostic to
 * which campaign a campaign_contact belongs to — it just walks active steps.
 */
export async function ensureDefaultCampaign(
  tenantId: string,
  masterAgentId: string,
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(
        eq(campaigns.tenantId, tenantId),
        eq(campaigns.masterAgentId, masterAgentId),
        eq(campaigns.name, FOLLOWUP_CAMPAIGN_NAME),
        eq(campaigns.type, 'email'),
      ))
      .limit(1);

    if (existing) return existing.id;

    const [agent] = await tx
      .select({ config: masterAgents.config })
      .from(masterAgents)
      .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)))
      .limit(1);

    const sequence = resolveSequence((agent?.config ?? {}) as Record<string, unknown>);

    const [created] = await tx.insert(campaigns).values({
      tenantId,
      masterAgentId,
      name: FOLLOWUP_CAMPAIGN_NAME,
      type: 'email',
      status: 'active',
      config: { source: 'auto-default-followup' },
    }).returning({ id: campaigns.id });

    if (!created) throw new Error('ensureDefaultCampaign: insert returned no row');

    await tx.insert(campaignSteps).values(
      sequence.map((s) => ({
        campaignId: created.id,
        stepNumber: s.stepNumber,
        delayDays: s.delayDays,
        delayBasis: 'after_first' as const,
        stepType: s.stepType,
        active: true,
        channel: 'email' as const,
      })),
    );

    logger.info(
      { tenantId, masterAgentId, campaignId: created.id, stepCount: sequence.length },
      'ensureDefaultCampaign: created default sequence',
    );
    return created.id;
  });
}

/**
 * Compute when the next active follow-up should fire, based on the campaign's
 * step list and the basis of the first follow-up step. We use the first
 * follow-up's delayBasis to decide whether to chain off touch 1 (after_first,
 * default) or off lastActionAt (after_previous).
 *
 * Returns null when there is no next active step (sequence complete) — the
 * scheduler treats this as 'completed'.
 */
export async function computeNextScheduledAt(
  tenantId: string,
  campaignId: string,
  fromStepNumber: number,
  reference: { firstSentAt: Date; lastSentAt: Date },
): Promise<{ nextStepNumber: number; nextScheduledAt: Date } | null> {
  return withTenant(tenantId, async (tx) => {
    const steps = await tx
      .select()
      .from(campaignSteps)
      .where(and(
        eq(campaignSteps.campaignId, campaignId),
        eq(campaignSteps.active, true),
      ));
    const ordered = steps
      .filter((s) => s.stepNumber > fromStepNumber)
      .sort((a, b) => a.stepNumber - b.stepNumber);
    const next = ordered[0];
    if (!next) return null;

    const basis = next.delayBasis === 'after_previous' ? reference.lastSentAt : reference.firstSentAt;
    const nextScheduledAt = new Date(basis.getTime() + next.delayDays * 24 * 60 * 60 * 1000);
    return { nextStepNumber: next.stepNumber, nextScheduledAt };
  });
}

/**
 * Enroll a contact in the sequence after touch 1 has been queued/sent.
 * Idempotent — the unique index on (campaignId, contactId) means a duplicate
 * call returns the existing row's id without re-inserting. Returns null when
 * skipped for any reason (existing row, contact unsubscribed, etc.) so the
 * caller's "initial email already sent" path can keep going.
 */
export async function enrollContactInSequence(params: {
  tenantId: string;
  campaignId: string;
  contactId: string;
  touch1Angle?: string | null;
  touch1SentAt?: Date | null;
}): Promise<{ id: string; nextScheduledAt: Date | null; status: string } | null> {
  const { tenantId, campaignId, contactId, touch1Angle, touch1SentAt } = params;

  // Compute when touch 2 should fire (the first non-initial active step).
  const sentAt = touch1SentAt ?? new Date();
  const nextSlot = await computeNextScheduledAt(
    tenantId,
    campaignId,
    1,
    { firstSentAt: sentAt, lastSentAt: sentAt },
  );

  return withTenant(tenantId, async (tx) => {
    // Honor permanent unsubscribe — never enroll an unsubscribed contact.
    const [contactRow] = await tx
      .select({ unsubscribed: contacts.unsubscribed })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (contactRow?.unsubscribed) {
      logger.info({ contactId }, 'enrollContactInSequence: contact unsubscribed, skipping');
      return null;
    }

    // Idempotency check.
    const [existing] = await tx
      .select({ id: campaignContacts.id, status: campaignContacts.status })
      .from(campaignContacts)
      .where(and(
        eq(campaignContacts.campaignId, campaignId),
        eq(campaignContacts.contactId, contactId),
      ))
      .limit(1);

    if (existing) {
      logger.debug(
        { campaignId, contactId, existingId: existing.id, status: existing.status },
        'enrollContactInSequence: already enrolled, skipping',
      );
      return { id: existing.id, nextScheduledAt: null, status: existing.status };
    }

    // No more active steps after touch 1 → enroll as completed.
    const status: 'in_sequence' | 'completed' = nextSlot ? 'in_sequence' : 'completed';
    const nextScheduledAt = nextSlot?.nextScheduledAt ?? null;

    const [inserted] = await tx.insert(campaignContacts).values({
      campaignId,
      contactId,
      currentStep: 1,
      status,
      lastActionAt: sentAt,
      nextScheduledAt,
      sequenceState: {
        touch1Angle: touch1Angle ?? undefined,
        anglesUsed: touch1Angle ? [touch1Angle] : [],
      },
    }).returning({ id: campaignContacts.id });

    if (!inserted) {
      logger.warn({ campaignId, contactId }, 'enrollContactInSequence: insert returned no row');
      return null;
    }

    logger.info(
      { campaignId, contactId, campaignContactId: inserted.id, nextScheduledAt, status },
      'enrollContactInSequence: enrolled',
    );
    return { id: inserted.id, nextScheduledAt, status };
  });
}

/**
 * Find the next active step for a campaign whose stepNumber is greater than
 * the given current step. Returns null when no further active step exists.
 */
export async function findNextActiveStep(
  tenantId: string,
  campaignId: string,
  fromStepNumber: number,
): Promise<{ id: string; stepNumber: number; delayDays: number; delayBasis: 'after_first' | 'after_previous'; stepType: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const steps = await tx
      .select()
      .from(campaignSteps)
      .where(and(
        eq(campaignSteps.campaignId, campaignId),
        eq(campaignSteps.active, true),
      ));
    const ordered = steps
      .filter((s) => s.stepNumber > fromStepNumber)
      .sort((a, b) => a.stepNumber - b.stepNumber);
    const next = ordered[0];
    if (!next) return null;
    return {
      id: next.id,
      stepNumber: next.stepNumber,
      delayDays: next.delayDays,
      delayBasis: next.delayBasis,
      stepType: next.stepType,
    };
  });
}
