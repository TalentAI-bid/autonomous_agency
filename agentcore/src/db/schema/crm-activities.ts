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
]);

export const crmActivities = pgTable('crm_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  type: activityTypeEnum('type').notNull(),
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
]);

export type CrmActivity = typeof crmActivities.$inferSelect;
export type NewCrmActivity = typeof crmActivities.$inferInsert;
