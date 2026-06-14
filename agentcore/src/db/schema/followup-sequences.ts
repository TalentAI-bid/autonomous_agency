import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { deals } from './deals.js';

/**
 * Follow-up engine sequence state — one row per deal (deals are 1:1 with
 * contacts, and the user-defined pipeline stage lives on the deal).
 *
 * Lifecycle:
 *  - Created/reactivated when a deal enters a follow-up-eligible stage
 *    (crm_stages.follow_up_eligible) via onDealStageChanged.
 *  - `touch_number` counts ONLY engine follow-ups (0..N); it is distinct from
 *    prospect_stages.total_touches which counts every outbound touch.
 *  - `next_due_at = last_touch_at + cadence interval[touch_number]`; the daily
 *    triage scan surfaces rows with next_due_at <= now() as Daily Queue cards.
 *  - Halted when the lead replies (recordResponse) or the deal moves to a
 *    non-eligible stage; completed after the final touch of the cadence.
 */
export type FollowupSequenceStatus = 'active' | 'halted' | 'completed';

export const followupSequences = pgTable('followup_sequences', {
  dealId: uuid('deal_id').primaryKey().references(() => deals.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  status: text('status').$type<FollowupSequenceStatus>().notNull().default('active'),
  touchNumber: integer('touch_number').notNull().default(0),
  lastTouchAt: timestamp('last_touch_at', { withTimezone: true }),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }),
  // Per-lead cadence strategy override; NULL = tenant's global strategy.
  cadenceOverride: text('cadence_override').$type<'fast' | 'mid' | 'slow'>(),
  haltReason: text('halt_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('followup_sequences_due_idx').on(t.tenantId, t.status, t.nextDueAt),
  index('followup_sequences_contact_idx').on(t.contactId),
]);

export type FollowupSequence = typeof followupSequences.$inferSelect;
export type NewFollowupSequence = typeof followupSequences.$inferInsert;
