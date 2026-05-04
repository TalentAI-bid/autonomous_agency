import { pgTable, uuid, integer, text, timestamp, jsonb, pgEnum, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { contacts } from './contacts.js';

// Status values:
//   pending          — enrolled but no touch sent yet (rarely used; we usually
//                      enroll right after queueing touch 1, transitioning to
//                      'in_sequence' immediately)
//   active           — legacy synonym for in_sequence (kept for backwards
//                      compatibility with rows pre-followup-system)
//   in_sequence      — currentStep < total active steps; nextScheduledAt set
//   completed        — all active steps sent
//   stopped_manual   — user clicked "stop sequence" (e.g. they got a reply);
//                      stoppedReason holds the human-readable reason
//   failed           — exhausted retries on a follow-up send; stoppedReason
//                      typically 'smtp_failure_after_retries'
//   replied / bounced / unsubscribed — RESERVED for the deferred auto-pause
//                      work. Manual stops use 'stopped_manual' for now;
//                      auto-pause hooks will switch to these.
export const campaignContactStatusEnum = pgEnum('campaign_contact_status', [
  'pending', 'active', 'replied', 'bounced', 'unsubscribed', 'completed',
  'in_sequence', 'stopped_manual', 'failed',
]);

export const campaignContacts = pgTable('campaign_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  // currentStep is the existing column the spec calls "currentTouchNumber" —
  // incremented after each successful follow-up send (touch 1 = 1, etc.).
  currentStep: integer('current_step').default(0).notNull(),
  status: campaignContactStatusEnum('status').default('pending').notNull(),
  // lastActionAt is the existing column the spec calls "lastSentAt" —
  // updated after each successful send. Reused as-is.
  lastActionAt: timestamp('last_action_at', { withTimezone: true }),
  // When the next follow-up should fire. NULL when the sequence is complete,
  // stopped, or paused outside business hours and waiting for a slot.
  nextScheduledAt: timestamp('next_scheduled_at', { withTimezone: true }),
  // Free-text reason for stopped_manual / failed states. e.g. "replied",
  // "not_interested", "smtp_failure_after_retries".
  stoppedReason: text('stopped_reason'),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }),
  // Per-contact state — angles already used so the LLM doesn't repeat them,
  // plus any per-touch metadata.
  sequenceState: jsonb('sequence_state').$type<{
    touch1Angle?: string;
    anglesUsed?: string[];
  }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('campaign_contacts_campaign_contact_uniq').on(t.campaignId, t.contactId),
  index('campaign_contacts_status_idx').on(t.status),
  // Hot path for the followup-scheduler tick — only scan rows due now.
  index('campaign_contacts_due_idx').on(t.status, t.nextScheduledAt),
]);

export type CampaignContact = typeof campaignContacts.$inferSelect;
export type NewCampaignContact = typeof campaignContacts.$inferInsert;
