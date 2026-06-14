import { eq, and, desc, lt, inArray, sql } from 'drizzle-orm';
import { withTenant, db } from '../config/database.js';
import {
  companies,
  contacts,
  prospectActions,
  crmActivities,
  userTenants,
} from '../db/schema/index.js';
import type {
  Contact,
  Company,
  ProspectActionType,
  ProspectActionPriority,
  TargetAlternative,
} from '../db/schema/index.js';
import { generateStudioMessage } from './message-studio.service.js';
import { generateReplyDraft } from './inbox-copilot.service.js';
import { scanDueSequences } from './followup-engine.service.js';
import logger from '../utils/logger.js';

/**
 * Sales Operations triage — company-centric edition (post-migration 0035).
 *
 * Each of the 13 rules queries the `companies` table as the primary entity.
 * Recommended target contact is picked per-rule (last-touched for follow-ups,
 * inbound sender for hot-reply rules, title-ranked for fresh outreach).
 * Up to 4 other contacts at the same company are surfaced as
 * target_alternatives so the user can retarget within a single action.
 *
 * One pending action per (tenant, company) is enforced by the partial
 * unique index `prospect_actions_one_pending_per_company` — duplicate
 * inserts go to ON CONFLICT DO NOTHING.
 */

// ─── Types ──────────────────────────────────────────────────────────

type RuleId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'M' | 'N';

/** A single rule's match for a company, before dedup + cap + draft. */
interface RuleMatch {
  companyId: string;
  ruleId: RuleId;
  priority: ProspectActionPriority;
  actionType: ProspectActionType;
  whyNow: string;
  channelTarget: string | null;
  /** The rule's chosen target contact at this company. May be null (Rule M). */
  recommendedContactId: string | null;
  triggeredByEventId: string | null;
  /** Hint for draft generation. Null for actions with no contact (Rule M). */
  draftHint: 'first_message' | 'first_followup' | 'second_followup' | 'breakup' | 'reactivation' | 'reply' | null;
  /** Override for priority_reason (default `Rule ${ruleId}`). Rule N uses
   * `FollowupEngine touch N` so the engine can find/advance its own cards. */
  priorityReason?: string;
}

/** Numeric priority used for cross-rule comparison. P0=0 < P1=1 < ... */
const PRIORITY_RANK: Record<ProspectActionPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Per-rule tiebreaker so when two rules at the same priority hit the same company, A/D/E etc. win deterministically. */
const RULE_ORDER: Record<RuleId, number> = {
  A: 1, B: 2, C: 3,
  D: 4, E: 5, F: 6,
  G: 7, H: 8, M: 9,
  I: 10, J: 11, K: 12,
  N: 13,
};

// ─── Helpers ────────────────────────────────────────────────────────

async function resolveTenantUserId(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: userTenants.userId })
    .from(userTenants)
    .where(eq(userTenants.tenantId, tenantId))
    .orderBy(desc(userTenants.isDefault), desc(userTenants.joinedAt))
    .limit(1);
  return row?.userId ?? null;
}

/** Title-rank a contact: lower number = better target. Mirrored in SQL. */
function titleRank(title: string | null): number {
  if (!title) return 5;
  const t = title.toLowerCase();
  if (t.includes('ceo') || t.includes('founder') || t.includes('owner')) return 1;
  if (t.includes('cto') || t.includes('vp engineering') || t.includes('head of engineering')) return 2;
  if (t.includes('cro') || t.includes('vp sales') || t.includes('head of sales')) return 3;
  if (t.includes('director') || t.includes('head of')) return 4;
  return 5;
}

/**
 * For every (companyId) passed in, fetch all non-DNC contacts then rank
 * in-memory by title priority + score. Returns up to 4 best per company
 * (used to pick a recommended target + 3 alternatives).
 */
async function loadTopContactsByCompany(
  tenantId: string,
  companyIds: string[],
): Promise<Map<string, Contact[]>> {
  if (companyIds.length === 0) return new Map();
  const rows = await withTenant(tenantId, async (tx) => {
    return tx
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.tenantId, tenantId),
          eq(contacts.doNotContact, false),
          inArray(contacts.companyId, companyIds),
        ),
      );
  });
  const byCompany = new Map<string, Contact[]>();
  for (const r of rows) {
    if (!r.companyId) continue;
    if (!byCompany.has(r.companyId)) byCompany.set(r.companyId, []);
    byCompany.get(r.companyId)!.push(r);
  }
  for (const [cid, list] of byCompany) {
    list.sort((a, b) => {
      const ra = titleRank(a.title);
      const rb = titleRank(b.title);
      if (ra !== rb) return ra - rb;
      const sa = a.score ?? -1;
      const sb = b.score ?? -1;
      if (sa !== sb) return sb - sa;
      return (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);
    });
    byCompany.set(cid, list.slice(0, 4));
  }
  return byCompany;
}

function buildAlternatives(
  contactsRanked: Contact[],
  exclude: string | null,
): TargetAlternative[] {
  return contactsRanked
    .filter((c) => c.id !== exclude)
    .slice(0, 3)
    .map((c) => ({
      contactId: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown',
      title: c.title ?? null,
      channel: c.linkedinUrl
        ? ('linkedin_dm' as const)
        : ('email' as const),
    }));
}

// ─── The 13 rules, each as a SQL query returning RuleMatch[] ────────

/** Rule A — P0 Hot Inbound. Any contact at the company received an
 *  inbound (`event_category='response'`) in the last 24h, and no
 *  outbound has been sent from us to this company since. */
async function runRuleA(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{
      company_id: string;
      contact_id: string;
      event_id: string;
      event_type: string;
    }>(sql`
      WITH recent_inbound AS (
        SELECT DISTINCT ON (co.id)
          co.id AS company_id,
          ca.contact_id,
          ca.id AS event_id,
          ca.type AS event_type,
          ca.occurred_at AS inbound_at
        FROM companies co
        JOIN contacts c ON c.company_id = co.id
        JOIN crm_activities ca ON ca.contact_id = c.id
        WHERE co.tenant_id = ${tenantId}
          AND co.do_not_contact = false
          AND co.current_stage NOT IN ('closed_won','closed_lost','dnc')
          AND ca.event_category = 'response'
          AND ca.occurred_at > now() - interval '24 hours'
        ORDER BY co.id, ca.occurred_at DESC
      )
      SELECT ri.company_id, ri.contact_id, ri.event_id, ri.event_type
      FROM recent_inbound ri
      WHERE NOT EXISTS (
        SELECT 1 FROM crm_activities ca2
        JOIN contacts c2 ON c2.id = ca2.contact_id
        WHERE c2.company_id = ri.company_id
          AND ca2.event_category = 'outreach'
          AND ca2.occurred_at >= ri.inbound_at
      );
    `);
    return (rows.rows as Array<{ company_id: string; contact_id: string; event_id: string; event_type: string }>).map((r) => {
      const isEmail = r.event_type.startsWith('email');
      return {
        companyId: r.company_id,
        ruleId: 'A' as const,
        priority: 'P0' as const,
        actionType: (isEmail ? 'email_reply' : 'linkedin_dm_reply') as ProspectActionType,
        whyNow: 'Replied recently — fast response wins.',
        channelTarget: isEmail ? 'email' : 'linkedin_dm',
        recommendedContactId: r.contact_id,
        triggeredByEventId: r.event_id,
        draftHint: 'reply' as const,
      };
    });
  });
}

/** Rule B — P0 Meeting Today. meeting_scheduled in next 4h. */
async function runRuleB(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string; contact_id: string; event_id: string }>(sql`
      SELECT DISTINCT ON (co.id)
        co.id AS company_id, c.id AS contact_id, ca.id AS event_id
      FROM companies co
      JOIN contacts c ON c.company_id = co.id
      JOIN crm_activities ca ON ca.contact_id = c.id
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND ca.type = 'meeting_scheduled'
        AND (ca.metadata->>'startsAt')::timestamptz BETWEEN now() AND now() + interval '4 hours'
      ORDER BY co.id, ca.occurred_at DESC;
    `);
    return (rows.rows as Array<{ company_id: string; contact_id: string; event_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'B' as const,
      priority: 'P0' as const,
      actionType: 'meeting_prep' as ProspectActionType,
      whyNow: 'Meeting in <4h — review their context.',
      channelTarget: 'meeting',
      recommendedContactId: r.contact_id,
      triggeredByEventId: r.event_id,
      draftHint: null,
    }));
  });
}

/** Rule C — P0 Engagement Spike. 3+ email_opened across all contacts in 48h. */
async function runRuleC(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string }>(sql`
      SELECT co.id AS company_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.current_stage NOT IN ('engaged','qualified','closed_won','closed_lost','dnc')
        AND (
          SELECT COUNT(*) FROM crm_activities ca
          JOIN contacts c ON c.id = ca.contact_id
          WHERE c.company_id = co.id
            AND ca.type = 'email_opened'
            AND ca.occurred_at > now() - interval '48 hours'
        ) >= 3;
    `);
    return (rows.rows as Array<{ company_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'C' as const,
      priority: 'P0' as const,
      actionType: 'email_followup' as ProspectActionType,
      whyNow: 'Opened 3+ times in 48h — hot signal.',
      channelTarget: 'email',
      recommendedContactId: null, // filled in by app code (rank-1 target)
      triggeredByEventId: null,
      draftHint: 'first_followup' as const,
    }));
  });
}

/** Rule D — P1 High-Fit New Company. score≥80, no outreach yet. */
async function runRuleD(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string }>(sql`
      SELECT co.id AS company_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.score >= 80
        AND co.current_stage = 'new'
        AND co.total_outbound_touches = 0
        AND EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = co.id AND c.do_not_contact = false);
    `);
    return (rows.rows as Array<{ company_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'D' as const,
      priority: 'P1' as const,
      actionType: 'email_first' as ProspectActionType, // refined per-target later
      whyNow: 'High-fit lead — haven’t touched anyone here yet.',
      channelTarget: null,
      recommendedContactId: null,
      triggeredByEventId: null,
      draftHint: 'first_message' as const,
    }));
  });
}

/** Rule E — P1 First Followup Window. 4-7d since last touch, no inbound. */
async function runRuleE(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string; last_touched_contact_id: string | null }>(sql`
      SELECT co.id AS company_id,
        (SELECT ca.contact_id FROM crm_activities ca
         JOIN contacts c ON c.id = ca.contact_id
         WHERE c.company_id = co.id AND ca.event_category = 'outreach'
         ORDER BY ca.occurred_at DESC LIMIT 1) AS last_touched_contact_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.current_stage IN ('first_touch_sent','awaiting_response')
        AND co.last_touch_at BETWEEN now() - interval '7 days' AND now() - interval '4 days'
        AND co.last_inbound_at IS NULL
        -- Follow-up engine takes over: skip companies with an active
        -- stage-driven sequence (Rule N owns their cadence).
        AND NOT EXISTS (
          SELECT 1 FROM followup_sequences fs
          JOIN contacts cf ON cf.id = fs.contact_id
          WHERE cf.company_id = co.id AND fs.status = 'active'
        );
    `);
    return (rows.rows as Array<{ company_id: string; last_touched_contact_id: string | null }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'E' as const,
      priority: 'P1' as const,
      actionType: 'email_followup' as ProspectActionType,
      whyNow: 'Optimal follow-up window — 4-7d since first message.',
      channelTarget: 'email',
      recommendedContactId: r.last_touched_contact_id,
      triggeredByEventId: null,
      draftHint: 'first_followup' as const,
    }));
  });
}

/** Rule F — P1 Connection Accepted, No DM Sent Since. */
async function runRuleF(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string; contact_id: string; event_id: string }>(sql`
      SELECT DISTINCT ON (co.id)
        co.id AS company_id, c.id AS contact_id, ca.id AS event_id
      FROM companies co
      JOIN contacts c ON c.company_id = co.id
      JOIN crm_activities ca ON ca.contact_id = c.id
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND ca.type = 'linkedin_connection_accepted'
        AND NOT EXISTS (
          SELECT 1 FROM crm_activities ca2
          JOIN contacts c2 ON c2.id = ca2.contact_id
          WHERE c2.company_id = co.id
            AND ca2.type = 'linkedin_message_sent'
            AND ca2.occurred_at >= ca.occurred_at
        )
      ORDER BY co.id, ca.occurred_at DESC;
    `);
    return (rows.rows as Array<{ company_id: string; contact_id: string; event_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'F' as const,
      priority: 'P1' as const,
      actionType: 'linkedin_dm_first' as ProspectActionType,
      whyNow: 'Connected — open the conversation.',
      channelTarget: 'linkedin_dm',
      recommendedContactId: r.contact_id,
      triggeredByEventId: r.event_id,
      draftHint: 'first_message' as const,
    }));
  });
}

/** Rule G — P2 Second Followup. 8-14d, touches≥2, no inbound. */
async function runRuleG(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string; last_touched_contact_id: string | null }>(sql`
      SELECT co.id AS company_id,
        (SELECT ca.contact_id FROM crm_activities ca
         JOIN contacts c ON c.id = ca.contact_id
         WHERE c.company_id = co.id AND ca.event_category = 'outreach'
         ORDER BY ca.occurred_at DESC LIMIT 1) AS last_touched_contact_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.current_stage = 'awaiting_response'
        AND co.last_touch_at BETWEEN now() - interval '14 days' AND now() - interval '8 days'
        AND co.total_outbound_touches >= 2
        AND co.last_inbound_at IS NULL
        -- Follow-up engine takes over (see Rule E note).
        AND NOT EXISTS (
          SELECT 1 FROM followup_sequences fs
          JOIN contacts cf ON cf.id = fs.contact_id
          WHERE cf.company_id = co.id AND fs.status = 'active'
        );
    `);
    return (rows.rows as Array<{ company_id: string; last_touched_contact_id: string | null }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'G' as const,
      priority: 'P2' as const,
      actionType: 'email_followup' as ProspectActionType,
      whyNow: 'Second follow-up window — try a different angle.',
      channelTarget: 'email',
      recommendedContactId: r.last_touched_contact_id,
      triggeredByEventId: null,
      draftHint: 'second_followup' as const,
    }));
  });
}

/** Rule H — P2 Medium-Fit New Company. */
async function runRuleH(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string }>(sql`
      SELECT co.id AS company_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.score >= 60 AND co.score < 80
        AND co.current_stage = 'new'
        AND co.total_outbound_touches = 0
        AND EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = co.id AND c.do_not_contact = false);
    `);
    return (rows.rows as Array<{ company_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'H' as const,
      priority: 'P2' as const,
      actionType: 'email_first' as ProspectActionType,
      whyNow: 'Medium-fit lead — initiate outreach.',
      channelTarget: null,
      recommendedContactId: null,
      triggeredByEventId: null,
      draftHint: 'first_message' as const,
    }));
  });
}

/** Rule I — P3 Breakup. */
async function runRuleI(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string; last_touched_contact_id: string | null }>(sql`
      SELECT co.id AS company_id,
        (SELECT ca.contact_id FROM crm_activities ca
         JOIN contacts c ON c.id = ca.contact_id
         WHERE c.company_id = co.id AND ca.event_category = 'outreach'
         ORDER BY ca.occurred_at DESC LIMIT 1) AS last_touched_contact_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.current_stage = 'awaiting_response'
        AND co.last_touch_at BETWEEN now() - interval '30 days' AND now() - interval '15 days'
        AND co.total_outbound_touches >= 3
        AND co.last_inbound_at IS NULL
        -- Follow-up engine takes over (see Rule E note).
        AND NOT EXISTS (
          SELECT 1 FROM followup_sequences fs
          JOIN contacts cf ON cf.id = fs.contact_id
          WHERE cf.company_id = co.id AND fs.status = 'active'
        );
    `);
    return (rows.rows as Array<{ company_id: string; last_touched_contact_id: string | null }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'I' as const,
      priority: 'P3' as const,
      actionType: 'breakup_message' as ProspectActionType,
      whyNow: 'Final attempt before going cold.',
      channelTarget: 'email',
      recommendedContactId: r.last_touched_contact_id,
      triggeredByEventId: null,
      draftHint: 'breakup' as const,
    }));
  });
}

/** Rule J — P3 Reactivation. cold + past engagement. */
async function runRuleJ(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string }>(sql`
      SELECT co.id AS company_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.current_stage = 'cold'
        AND co.last_touch_at < now() - interval '60 days'
        AND co.total_inbound_responses > 0;
    `);
    return (rows.rows as Array<{ company_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'J' as const,
      priority: 'P3' as const,
      actionType: 'reactivation_outreach' as ProspectActionType,
      whyNow: 'Past engagement — worth reactivating.',
      channelTarget: 'email',
      recommendedContactId: null,
      triggeredByEventId: null,
      draftHint: 'reactivation' as const,
    }));
  });
}

/** Rule K — P3 Mark Dead. cold 90+d, no engagement. */
async function runRuleK(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string }>(sql`
      SELECT co.id AS company_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.current_stage = 'cold'
        AND co.last_touch_at < now() - interval '90 days';
    `);
    return (rows.rows as Array<{ company_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'K' as const,
      priority: 'P3' as const,
      actionType: 'mark_dead_review' as ProspectActionType,
      whyNow: 'No engagement in 90+ days — confirm dead.',
      channelTarget: 'review',
      recommendedContactId: null,
      triggeredByEventId: null,
      draftHint: null,
    }));
  });
}

/** Rule M — Gap: high-fit company with no decision-maker contact captured. */
async function runRuleM(tenantId: string): Promise<RuleMatch[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.execute<{ company_id: string }>(sql`
      SELECT co.id AS company_id
      FROM companies co
      WHERE co.tenant_id = ${tenantId}
        AND co.do_not_contact = false
        AND co.score >= 70
        AND NOT EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.company_id = co.id
            AND (c.title ILIKE '%CTO%' OR c.title ILIKE '%CEO%' OR c.title ILIKE '%founder%'
                 OR c.title ILIKE '%VP%' OR c.title ILIKE '%Head of%' OR c.title ILIKE '%Director%')
        )
        AND NOT EXISTS (
          SELECT 1 FROM prospect_actions pa
          WHERE pa.company_id = co.id
            AND pa.action_type = 'research_company_decision_makers'
            AND pa.generated_at > now() - interval '7 days'
        );
    `);
    return (rows.rows as Array<{ company_id: string }>).map((r) => ({
      companyId: r.company_id,
      ruleId: 'M' as const,
      priority: 'P2' as const,
      actionType: 'research_company_decision_makers' as ProspectActionType,
      whyNow: 'High-fit company — no decision-maker contact yet.',
      channelTarget: 'research',
      recommendedContactId: null,
      triggeredByEventId: null,
      draftHint: null,
    }));
  });
}

/**
 * Rule N — Stage-driven follow-up engine. Due sequences for deals sitting in
 * follow-up-eligible user-defined CRM stages (see followup-engine.service).
 * P2 for touches 1-2, P3 for the final breakup — hot rules (A/B/C) always
 * outrank a scheduled nudge. Rules E/G/I skip engine-managed companies.
 */
async function runRuleN(tenantId: string): Promise<RuleMatch[]> {
  try {
    const matches = await scanDueSequences(tenantId);
    return matches.map((m) => ({
      companyId: m.companyId,
      ruleId: 'N' as const,
      priority: m.priority,
      actionType: m.actionType as ProspectActionType,
      whyNow: m.whyNow,
      channelTarget: m.channelTarget,
      recommendedContactId: m.contactId,
      triggeredByEventId: null,
      draftHint: m.draftHint,
      priorityReason: m.priorityReason,
    }));
  } catch (err) {
    logger.warn({ err, tenantId }, 'triage: Rule N (follow-up engine) failed');
    return [];
  }
}

// ─── Draft generation ──────────────────────────────────────────────

async function generateDraftFor(args: {
  tenantId: string;
  userId: string;
  contact: Contact;
  match: RuleMatch;
  triggerEvent?: { type: string; metadata: Record<string, unknown> | null } | null;
}): Promise<{ subject?: string; body?: string; confidence?: number }> {
  const { tenantId, userId, contact, match } = args;
  if (!match.draftHint) return {};

  const recipient = {
    name: [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'there',
    company: contact.companyName ?? undefined,
    title: contact.title ?? undefined,
    location: contact.location ?? undefined,
    linkedinUrl: contact.linkedinUrl ?? undefined,
  };

  try {
    if (match.draftHint === 'reply') {
      if (!contact.linkedinUrl) return {};
      // Pull recent conversation history (the contact's own events).
      const history = await withTenant(tenantId, async (tx) => {
        return tx
          .select({
            type: crmActivities.type,
            eventCategory: crmActivities.eventCategory,
            occurredAt: crmActivities.occurredAt,
            metadata: crmActivities.metadata,
          })
          .from(crmActivities)
          .where(and(eq(crmActivities.contactId, contact.id), eq(crmActivities.tenantId, tenantId)))
          .orderBy(desc(crmActivities.occurredAt))
          .limit(10);
      });
      const conversationHistory = history
        .filter((e) => e.eventCategory === 'response' || e.eventCategory === 'outreach')
        .map((e) => ({
          direction: e.eventCategory === 'response' ? ('inbound' as const) : ('outbound' as const),
          body: (e.metadata?.body as string) ?? (e.metadata?.bodyPreview as string) ?? '',
          sentAt: e.occurredAt.toISOString(),
        }))
        .reverse();
      if (conversationHistory.length === 0) return {};
      const result = await generateReplyDraft({
        tenantId,
        userId,
        recipientLinkedinUrl: contact.linkedinUrl,
        recipientName: recipient.name,
        recipientCompany: recipient.company,
        recipientTitle: recipient.title,
        conversationHistory,
      });
      return {
        body: result.draft.body,
        confidence: Math.round((result.draft.confidence ?? 0.5) * 100),
      };
    }

    const channel =
      match.channelTarget === 'linkedin_connection_request' ? 'linkedin_connection_request' :
      match.channelTarget === 'linkedin_dm' ? 'linkedin_dm' :
      'email_cold';
    const messageType: 'first_message' | 'first_followup' | 'second_followup' | 'breakup' | 'reactivation' =
      match.draftHint === 'first_message' ? 'first_message' :
      match.draftHint === 'first_followup' ? 'first_followup' :
      match.draftHint === 'second_followup' ? 'second_followup' :
      match.draftHint === 'breakup' ? 'breakup' :
      'reactivation';
    const studio = await generateStudioMessage({
      tenantId,
      userId,
      channel,
      track: 'sales',
      messageType,
      recipient,
    });
    return { subject: studio.subject, body: studio.body, confidence: 75 };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), contactId: contact.id, rule: match.ruleId },
      'triage: draft generation failed; persisting action without draft',
    );
    return {};
  }
}

// ─── Main entry point ──────────────────────────────────────────────

/**
 * Tenant-wide batch triage. Runs every rule's SQL, dedupes per company
 * (highest priority + earliest-listed rule wins), caps at `cap` (15),
 * generates drafts, persists with ON CONFLICT DO NOTHING against the
 * partial unique index.
 */
export async function runTriageForTenant(args: {
  tenantId: string;
  cap?: number;
}): Promise<{ created: number; capped: number; expired: number; conflicts: number }> {
  const { tenantId } = args;
  const cap = args.cap ?? 15;

  // 1. Expire stale pending actions.
  const expiredRows = await withTenant(tenantId, async (tx) => {
    return tx
      .update(prospectActions)
      .set({ status: 'expired' })
      .where(
        and(
          eq(prospectActions.tenantId, tenantId),
          eq(prospectActions.status, 'pending'),
          lt(prospectActions.expiresAt, new Date()),
        ),
      )
      .returning({ id: prospectActions.id });
  });

  const userId = await resolveTenantUserId(tenantId);
  if (!userId) {
    logger.warn({ tenantId }, 'runTriageForTenant: no active user found, aborting');
    return { created: 0, capped: 0, expired: expiredRows.length, conflicts: 0 };
  }

  // 2. Run every rule. They're independent — fire in parallel.
  const allMatches: RuleMatch[] = (await Promise.all([
    runRuleA(tenantId),
    runRuleB(tenantId),
    runRuleC(tenantId),
    runRuleD(tenantId),
    runRuleE(tenantId),
    runRuleF(tenantId),
    runRuleG(tenantId),
    runRuleH(tenantId),
    runRuleI(tenantId),
    runRuleJ(tenantId),
    runRuleK(tenantId),
    runRuleM(tenantId),
    runRuleN(tenantId),
  ])).flat();

  // 3. Dedupe per company — pick highest-priority + earliest-listed rule.
  const byCompany = new Map<string, RuleMatch>();
  for (const m of allMatches) {
    const existing = byCompany.get(m.companyId);
    if (!existing) { byCompany.set(m.companyId, m); continue; }
    const a = PRIORITY_RANK[m.priority] * 100 + RULE_ORDER[m.ruleId];
    const b = PRIORITY_RANK[existing.priority] * 100 + RULE_ORDER[existing.ruleId];
    if (a < b) byCompany.set(m.companyId, m);
  }
  const merged = Array.from(byCompany.values());

  // 4. Load company score + contact rankings so we can pick targets and sort.
  const companyIds = merged.map((m) => m.companyId);
  if (companyIds.length === 0) {
    await emitQueueReady(tenantId, 0);
    return { created: 0, capped: 0, expired: expiredRows.length, conflicts: 0 };
  }
  const companyRows = await withTenant(tenantId, async (tx) => {
    return tx
      .select({ id: companies.id, name: companies.name, score: companies.score, stageEnteredAt: companies.stageEnteredAt })
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), inArray(companies.id, companyIds)));
  });
  const companyMap = new Map(companyRows.map((c) => [c.id, c]));

  const topContacts = await loadTopContactsByCompany(tenantId, companyIds);

  // Fill in recommendedContactId for rules that left it null.
  for (const m of merged) {
    if (m.recommendedContactId === null && m.draftHint !== null) {
      const ranked = topContacts.get(m.companyId) ?? [];
      if (ranked.length > 0) {
        m.recommendedContactId = ranked[0].id;
        // Channel hint refinement for fresh outreach.
        if (m.channelTarget === null) {
          m.channelTarget = ranked[0].linkedinUrl ? 'linkedin_connection_request' : 'email';
          if (m.actionType === 'email_first' && ranked[0].linkedinUrl) {
            m.actionType = 'linkedin_connect';
          }
        }
      } else if (m.draftHint !== null) {
        // No targetable contacts; demote to Rule-M-style research action.
        m.actionType = 'research_company_decision_makers';
        m.channelTarget = 'research';
        m.draftHint = null;
      }
    }
  }

  // 5. Rank merged matches: priority asc, then company score desc, then days_in_stage desc.
  const ranked = merged
    .map((m) => {
      const co = companyMap.get(m.companyId);
      const score = co?.score ?? 0;
      const daysInStage = co?.stageEnteredAt ? (Date.now() - co.stageEnteredAt.getTime()) / (24 * 3600 * 1000) : 0;
      return { match: m, score, daysInStage };
    })
    .sort((a, b) => {
      if (a.match.priority !== b.match.priority) {
        return a.match.priority.localeCompare(b.match.priority); // P0 < P1 < P2 < P3
      }
      if (a.score !== b.score) return b.score - a.score;
      return b.daysInStage - a.daysInStage;
    });

  const capped = Math.max(0, ranked.length - cap);
  const winners = ranked.slice(0, cap);

  // 6. Generate drafts (for winners with a contact + draftHint) and insert.
  let created = 0;
  let conflicts = 0;
  for (const { match } of winners) {
    let contact: Contact | undefined;
    if (match.recommendedContactId) {
      const ranked = topContacts.get(match.companyId) ?? [];
      contact = ranked.find((c) => c.id === match.recommendedContactId);
      if (!contact) {
        // Recommended is outside top 4 (e.g. last-touched, low-rank). Pull directly.
        const [row] = await withTenant(tenantId, async (tx) =>
          tx.select().from(contacts).where(eq(contacts.id, match.recommendedContactId!)).limit(1),
        );
        contact = row;
      }
    }
    const draft = contact && match.draftHint
      ? await generateDraftFor({ tenantId, userId, contact, match })
      : {};

    const alternatives = contact
      ? buildAlternatives(topContacts.get(match.companyId) ?? [], contact.id)
      : buildAlternatives(topContacts.get(match.companyId) ?? [], null);

    try {
      const inserted = await withTenant(tenantId, async (tx) => {
        return tx.execute<{ id: string }>(sql`
          INSERT INTO prospect_actions (
            tenant_id, user_id, company_id, contact_id,
            action_type, priority, priority_reason, why_now,
            draft_subject, draft_body, draft_confidence,
            channel_target, triggered_by_event_id, target_alternatives, status
          )
          VALUES (
            ${tenantId}, ${userId}, ${match.companyId}, ${match.recommendedContactId},
            ${match.actionType}, ${match.priority}, ${match.priorityReason ?? `Rule ${match.ruleId}`}, ${match.whyNow},
            ${draft.subject ?? null}, ${draft.body ?? null}, ${draft.confidence ?? null},
            ${match.channelTarget}, ${match.triggeredByEventId},
            ${JSON.stringify(alternatives)}::jsonb, 'pending'
          )
          ON CONFLICT (tenant_id, company_id) WHERE status = 'pending' DO NOTHING
          RETURNING id;
        `);
      });
      if (inserted.rows.length > 0) created++;
      else conflicts++;
    } catch (err) {
      logger.warn({ err, companyId: match.companyId, ruleId: match.ruleId }, 'triage: failed to persist prospect_action');
    }
  }

  await emitQueueReady(tenantId, created);
  return { created, capped, expired: expiredRows.length, conflicts };
}

async function emitQueueReady(tenantId: string, count: number): Promise<void> {
  try {
    const { pubRedis } = await import('../queues/setup.js');
    await pubRedis.publish(
      `agent-events:${tenantId}`,
      JSON.stringify({
        event: 'queue:ready',
        data: { count, etaMinutes: Math.round(count * 1.5) },
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ err, tenantId }, 'triage: failed to publish queue:ready event');
  }
}

/**
 * Inbound-driven micro-triage. Mark any pending action for the contact's
 * company as superseded, then re-run the rules just for that company and
 * insert if anything fires (typically Rule A).
 */
export async function microTriage(args: {
  tenantId: string;
  contactId: string;
  triggerEventId?: string;
}): Promise<void> {
  const { tenantId, contactId } = args;

  const [contact] = await withTenant(tenantId, async (tx) =>
    tx.select({ companyId: contacts.companyId }).from(contacts).where(eq(contacts.id, contactId)).limit(1),
  );
  const companyId = contact?.companyId;
  if (!companyId) return;

  // Supersede any pending action for this company.
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(prospectActions)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(prospectActions.tenantId, tenantId),
          eq(prospectActions.companyId, companyId),
          eq(prospectActions.status, 'pending'),
        ),
      );
  });

  // Re-run all rules for the full tenant — small enough at single-tenant
  // scale, and the partial unique index plus ON CONFLICT guarantees no
  // duplicates. Cap stays at the default 15.
  await runTriageForTenant({ tenantId, cap: 15 });
}

/**
 * Single-contact triage trigger. Backward-compatible helper used by older
 * code paths; routes to microTriage which is now company-aware.
 */
export async function runTriageForContact(args: {
  tenantId: string;
  contactId: string;
  userId?: string;
}): Promise<{ created: boolean }> {
  await microTriage({ tenantId: args.tenantId, contactId: args.contactId });
  return { created: true };
}

/**
 * Re-target an existing pending action to a different contact at the same
 * company. Regenerates the draft for the new target. Used by the
 * /api/queue/actions/:id/retarget endpoint.
 */
export async function retargetAction(args: {
  tenantId: string;
  userId: string;
  actionId: string;
  newContactId: string;
}): Promise<{ subject: string | null; body: string | null; confidence: number | null }> {
  const { tenantId, userId, actionId, newContactId } = args;

  const [action] = await withTenant(tenantId, async (tx) =>
    tx.select().from(prospectActions).where(eq(prospectActions.id, actionId)).limit(1),
  );
  if (!action) throw new Error('Action not found');

  const [newContact] = await withTenant(tenantId, async (tx) =>
    tx.select().from(contacts).where(eq(contacts.id, newContactId)).limit(1),
  );
  if (!newContact) throw new Error('Target contact not found');
  if (newContact.companyId !== action.companyId) {
    throw new Error('Target contact is not at this action\'s company');
  }

  // Reconstruct a RuleMatch-shaped object so we can reuse generateDraftFor.
  const draftHint =
    action.actionType === 'email_reply' || action.actionType === 'linkedin_dm_reply' ? ('reply' as const) :
    action.actionType === 'email_followup' ? ('first_followup' as const) :
    action.actionType === 'email_first' || action.actionType === 'linkedin_connect' || action.actionType === 'linkedin_dm_first' ? ('first_message' as const) :
    action.actionType === 'breakup_message' ? ('breakup' as const) :
    action.actionType === 'reactivation_outreach' ? ('reactivation' as const) :
    null;

  const fakeMatch: RuleMatch = {
    companyId: action.companyId,
    ruleId: 'A',
    priority: action.priority,
    actionType: action.actionType,
    whyNow: action.whyNow ?? '',
    channelTarget: action.channelTarget ?? null,
    recommendedContactId: newContactId,
    triggeredByEventId: action.triggeredByEventId ?? null,
    draftHint,
  };

  const draft = await generateDraftFor({ tenantId, userId, contact: newContact, match: fakeMatch });

  await withTenant(tenantId, async (tx) => {
    await tx
      .update(prospectActions)
      .set({
        contactId: newContactId,
        draftSubject: draft.subject ?? null,
        draftBody: draft.body ?? null,
        draftConfidence: draft.confidence ?? null,
      })
      .where(eq(prospectActions.id, actionId));
  });

  return { subject: draft.subject ?? null, body: draft.body ?? null, confidence: draft.confidence ?? null };
}
