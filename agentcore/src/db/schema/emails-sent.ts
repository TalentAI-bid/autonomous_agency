import { pgTable, uuid, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { campaignContacts } from './campaign-contacts.js';
import { campaignSteps } from './campaign-steps.js';

export const emailsSent = pgTable('emails_sent', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignContactId: uuid('campaign_contact_id').references(() => campaignContacts.id, { onDelete: 'cascade' }),
  stepId: uuid('step_id').references(() => campaignSteps.id, { onDelete: 'set null' }),
  fromEmail: varchar('from_email', { length: 255 }),
  toEmail: varchar('to_email', { length: 255 }),
  subject: text('subject'),
  body: text('body'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  clickedAt: timestamp('clicked_at', { withTimezone: true }),
  repliedAt: timestamp('replied_at', { withTimezone: true }),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  messageId: varchar('message_id', { length: 255 }),
  trackingId: varchar('tracking_id', { length: 255 }),
  // Touch number within the campaign sequence (1 = initial, 2/3/4 = follow-ups).
  // Lets the followup-content prompt fetch "previous followups" without
  // joining through campaign_steps for every send.
  touchNumber: integer('touch_number'),
  // RFC 2822 threading headers — set on touches 2/3 so they thread under
  // the original email in the recipient's inbox. Touch 4 may use a fresh
  // subject for higher open rate.
  inReplyTo: varchar('in_reply_to', { length: 998 }),
  references: text('references'),
}, (t) => [
  index('emails_sent_campaign_contact_idx').on(t.campaignContactId),
  index('emails_sent_sent_at_idx').on(t.sentAt),
  index('emails_sent_tracking_id_idx').on(t.trackingId),
]);

export type EmailSent = typeof emailsSent.$inferSelect;
export type NewEmailSent = typeof emailsSent.$inferInsert;
