import { pgTable, uuid, text, real, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { emailsSent } from './emails-sent.js';
import { contacts } from './contacts.js';

export const replyClassificationEnum = pgEnum('reply_classification', [
  'interested', 'objection', 'not_now', 'out_of_office', 'unsubscribe', 'bounce', 'other',
]);

export const replies = pgTable('replies', {
  id: uuid('id').primaryKey().defaultRandom(),
  emailSentId: uuid('email_sent_id').references(() => emailsSent.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  body: text('body'),
  classification: replyClassificationEnum('classification'),
  sentiment: real('sentiment'),
  autoResponse: text('auto_response'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('replies_email_sent_idx').on(t.emailSentId),
  index('replies_contact_idx').on(t.contactId),
]);

export type Reply = typeof replies.$inferSelect;
export type NewReply = typeof replies.$inferInsert;
