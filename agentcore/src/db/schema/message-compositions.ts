import { pgTable, uuid, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * Single generated message from the Message Studio. Persisted for audit,
 * rate-limit accounting, and future analytics. Not linked to contacts or
 * the outreach pipeline — the studio is copy-paste only.
 */
export const messageCompositions = pgTable('message_compositions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  channel: varchar('channel', { length: 64 }).notNull(),
  track: varchar('track', { length: 32 }).notNull(),
  recipientName: text('recipient_name').notNull(),
  recipientCompany: text('recipient_company'),
  recipientTitle: text('recipient_title'),
  recipientLocation: text('recipient_location'),
  recipientLinkedinUrl: text('recipient_linkedin_url'),
  customContext: text('custom_context'),
  subject: text('subject'),
  body: text('body').notNull(),
  classification: varchar('classification', { length: 32 }),
  messageType: varchar('message_type', { length: 32 }).default('first_message').notNull(),
  characterCount: integer('character_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('message_compositions_tenant_idx').on(t.tenantId, t.createdAt),
  index('message_compositions_tenant_user_idx').on(t.tenantId, t.userId, t.createdAt),
]);

export type MessageComposition = typeof messageCompositions.$inferSelect;
export type NewMessageComposition = typeof messageCompositions.$inferInsert;
