import { pgTable, uuid, text, timestamp, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { companies } from './companies.js';
import { users } from './users.js';
import { crmActivities } from './crm-activities.js';

/**
 * The daily action queue. Populated by the triage worker.
 * One row = one item the user will execute, skip, or let expire on the
 * /dashboard/queue surface. Company-grained as of migration 0035: the
 * unit of identity is (tenant_id, company_id) with one pending action
 * per company enforced by a partial unique index.
 */
export type ProspectActionType =
  | 'linkedin_connect'
  | 'linkedin_dm_first'
  | 'linkedin_dm_followup'
  | 'linkedin_dm_reply'
  | 'email_first'
  | 'email_followup'
  | 'email_reply'
  | 'whatsapp_send'
  | 'phone_call'
  | 'meeting_prep'
  | 'manual_research'
  | 'manual_followup_task'
  | 'reactivation_outreach'
  | 'breakup_message'
  | 'mark_dead_review'
  | 'research_company_decision_makers';

export type ProspectActionPriority = 'P0' | 'P1' | 'P2' | 'P3';

export type ProspectActionStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'skipped'
  | 'expired'
  | 'superseded';

/** Shape stored in prospect_actions.target_alternatives (jsonb). */
export type TargetAlternative = {
  contactId: string;
  name: string;
  title: string | null;
  channel: 'email' | 'linkedin_dm' | 'linkedin_connection_request';
};

export const prospectActions = pgTable('prospect_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  // contactId is nullable (Rule M actions have no target yet).
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  // companyId is the unit of identity. NOT NULL after 0035 backfill.
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  actionType: text('action_type').$type<ProspectActionType>().notNull(),
  priority: text('priority').$type<ProspectActionPriority>().notNull(),
  priorityReason: text('priority_reason'),
  whyNow: text('why_now'),
  strategyNote: text('strategy_note'),
  scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().default(sql`(now() + interval '48 hours')`),
  draftSubject: text('draft_subject'),
  draftBody: text('draft_body'),
  draftConfidence: integer('draft_confidence'),
  channelTarget: text('channel_target'),
  contextSummary: text('context_summary'),
  // 2-4 other contacts at the same company the user can pick to retarget.
  targetAlternatives: jsonb('target_alternatives').$type<TargetAlternative[]>().notNull().default(sql`'[]'::jsonb`),
  status: text('status').$type<ProspectActionStatus>().notNull().default('pending'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  userOpenedAt: timestamp('user_opened_at', { withTimezone: true }),
  userCompletedAt: timestamp('user_completed_at', { withTimezone: true }),
  userSkippedAt: timestamp('user_skipped_at', { withTimezone: true }),
  skipReason: text('skip_reason'),
  userNotes: text('user_notes'),
  triggeredByEventId: uuid('triggered_by_event_id').references(() => crmActivities.id, { onDelete: 'set null' }),
}, (t) => [
  // Queue lookup: "next pending action for this user, in priority order".
  index('prospect_actions_queue_idx').on(t.userId, t.priority, t.scheduledFor),
  index('prospect_actions_tenant_status_idx').on(t.tenantId, t.status, t.scheduledFor),
  index('prospect_actions_contact_idx').on(t.contactId),
  index('prospect_actions_company_idx').on(t.companyId),
  index('prospect_actions_tenant_company_idx').on(t.tenantId, t.companyId),
]);

export type ProspectAction = typeof prospectActions.$inferSelect;
export type NewProspectAction = typeof prospectActions.$inferInsert;
