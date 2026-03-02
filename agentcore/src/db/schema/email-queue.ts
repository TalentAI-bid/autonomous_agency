import { pgTable, uuid, varchar, text, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { campaignContacts } from './campaign-contacts.js';
import { emailAccounts } from './email-accounts.js';
import { emailThreads } from './email-threads.js';

export const emailQueueStatusEnum = pgEnum('email_queue_status', [
  'queued', 'sending', 'sent', 'failed', 'cancelled',
]);

export const emailQueue = pgTable('email_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  threadId: uuid('thread_id').references(() => emailThreads.id, { onDelete: 'set null' }),
  campaignContactId: uuid('campaign_contact_id').references(() => campaignContacts.id, { onDelete: 'set null' }),
  emailAccountId: uuid('email_account_id').references(() => emailAccounts.id, { onDelete: 'set null' }),
  fromEmail: varchar('from_email', { length: 255 }).notNull(),
  toEmail: varchar('to_email', { length: 255 }).notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  textBody: text('text_body'),
  trackingId: varchar('tracking_id', { length: 255 }),
  status: emailQueueStatusEnum('status').default('queued').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(3).notNull(),
  lastError: text('last_error'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  // Metadata for linking back to email records
  masterAgentId: uuid('master_agent_id'),
  campaignId: uuid('campaign_id'),
  stepId: uuid('step_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('email_queue_tenant_status_idx').on(t.tenantId, t.status),
  index('email_queue_scheduled_idx').on(t.scheduledAt),
  index('email_queue_thread_idx').on(t.threadId),
]);

export type EmailQueueItem = typeof emailQueue.$inferSelect;
export type NewEmailQueueItem = typeof emailQueue.$inferInsert;
