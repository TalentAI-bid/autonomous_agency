import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { deals } from './deals.js';
import { users } from './users.js';
import { masterAgents } from './master-agents.js';

export const activityTypeEnum = pgEnum('crm_activity_type', [
  'email_sent', 'email_opened', 'email_replied', 'email_received', 'email_bounced',
  'stage_change', 'note_added', 'call_logged', 'meeting_scheduled',
  'status_change', 'score_updated', 'agent_action',
  // LinkedIn-channel activities. Logged manually by the user when they
  // perform the action on linkedin.com (the extension can prefill via the
  // dashboard later but the data lives in this same enum).
  'linkedin_connection_sent',
  'linkedin_connection_accepted',
  'linkedin_message_sent',
  'linkedin_message_received',
  'linkedin_followup_sent',
  // Email sent / received outside the app — user logs it after the fact.
  // Distinct from email_sent (which is used by the auto-outreach pipeline)
  // so timeline filters and reply-rate analytics can tell them apart.
  'manual_email_sent',
  'manual_email_received',
  // Sales Operations Platform — Stage 1 capture flow.
  'contact_added',
  'contact_tagged',
  'contact_untagged',
  'contact_marked_dnc',
  'contact_reassigned',
  'duplicate_capture_attempted',
]);

/**
 * Top-level grouping the dashboard timeline filters by. Stored as TEXT so
 * future categories don't need a migration to the enum type. See
 * timeline.service.ts:logEvent for the canonical type-→-category mapping
 * used at call sites that don't pass one explicitly.
 */
export type CrmEventCategory =
  | 'outreach'
  | 'response'
  | 'discovery'
  | 'status_change'
  | 'manual_note'
  | 'meeting'
  | 'system_action';

export type CrmActorType = 'system' | 'user' | 'recipient' | 'integration';

export const crmActivities = pgTable('crm_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  type: activityTypeEnum('type').notNull(),
  // High-level grouping for timeline filters. Backfilled from `type` at
  // migration time; logEvent() fills it on new writes.
  eventCategory: text('event_category').$type<CrmEventCategory>().notNull().default('system_action'),
  // Who caused the event. 'system' = automated pipeline; 'user' = dashboard
  // action; 'recipient' = inbound from the other side (replies, opens);
  // 'integration' = third-party webhook.
  actorType: text('actor_type').$type<CrmActorType>().notNull().default('user'),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('crm_activities_tenant_idx').on(t.tenantId),
  index('crm_activities_contact_idx').on(t.contactId),
  index('crm_activities_deal_idx').on(t.dealId),
  index('crm_activities_occurred_at_idx').on(t.occurredAt),
  index('crm_activities_type_idx').on(t.tenantId, t.type),
  index('crm_activities_contact_occurred_idx').on(t.contactId, t.occurredAt),
]);

export type CrmActivity = typeof crmActivities.$inferSelect;
export type NewCrmActivity = typeof crmActivities.$inferInsert;
