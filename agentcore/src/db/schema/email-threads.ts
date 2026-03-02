import { pgTable, uuid, text, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { masterAgents } from './master-agents.js';
import { deals } from './deals.js';

export const threadStatusEnum = pgEnum('email_thread_status', [
  'active', 'archived', 'needs_action', 'waiting',
]);

export const threadPriorityEnum = pgEnum('email_thread_priority', [
  'high', 'medium', 'low',
]);

export const emailThreads = pgTable('email_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  dealId: uuid('deal_id').references(() => deals.id, { onDelete: 'set null' }),
  subject: text('subject'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  messageCount: integer('message_count').default(0).notNull(),
  summary: text('summary'),
  status: threadStatusEnum('status').default('active').notNull(),
  priority: threadPriorityEnum('priority').default('medium').notNull(),
  nextAction: text('next_action'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('email_threads_tenant_idx').on(t.tenantId),
  index('email_threads_tenant_status_idx').on(t.tenantId, t.status),
  index('email_threads_tenant_last_msg_idx').on(t.tenantId, t.lastMessageAt),
  index('email_threads_contact_idx').on(t.contactId),
  index('email_threads_deal_idx').on(t.dealId),
]);

export type EmailThread = typeof emailThreads.$inferSelect;
export type NewEmailThread = typeof emailThreads.$inferInsert;
