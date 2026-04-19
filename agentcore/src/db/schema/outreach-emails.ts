import { pgTable, uuid, text, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { contacts } from './contacts.js';

export const outreachEmails = pgTable('outreach_emails', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  messageId: text('message_id'),
  status: varchar('status', { length: 20 }).default('sent').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  repliedAt: timestamp('replied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('outreach_emails_tenant_idx').on(t.tenantId),
  index('outreach_emails_contact_idx').on(t.contactId),
  index('outreach_emails_tenant_contact_idx').on(t.tenantId, t.contactId),
]);

export type OutreachEmail = typeof outreachEmails.$inferSelect;
export type NewOutreachEmail = typeof outreachEmails.$inferInsert;
