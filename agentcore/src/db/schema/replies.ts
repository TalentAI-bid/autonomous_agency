import { pgTable, uuid, varchar, text, boolean, real, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { emailsSent } from './emails-sent.js';
import { contacts } from './contacts.js';
import { emailThreads } from './email-threads.js';

export const replyClassificationEnum = pgEnum('reply_classification', [
  'interested', 'objection', 'not_now', 'out_of_office', 'unsubscribe', 'bounce', 'other',
  'inquiry', 'application', 'partnership', 'support_request', 'spam', 'introduction',
]);

export const replies = pgTable('replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  threadId: uuid('thread_id').references(() => emailThreads.id, { onDelete: 'set null' }),
  emailSentId: uuid('email_sent_id').references(() => emailsSent.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  body: text('body'),
  fromEmail: varchar('from_email', { length: 255 }),
  subject: text('subject'),
  isInbound: boolean('is_inbound').default(false),
  classification: replyClassificationEnum('classification'),
  sentiment: real('sentiment'),
  autoResponse: text('auto_response'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('replies_email_sent_idx').on(t.emailSentId),
  index('replies_contact_idx').on(t.contactId),
  index('replies_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('replies_thread_idx').on(t.threadId),
]);

export type Reply = typeof replies.$inferSelect;
export type NewReply = typeof replies.$inferInsert;
