import { pgTable, uuid, text, varchar, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

/**
 * One row per LinkedIn DM thread the user views via the Inbox Copilot.
 * Indexed by (tenantId, recipient_linkedin_url) so re-opening a thread
 * reuses the existing record. Not linked to outreach pipeline.
 */
export const linkedinConversations = pgTable('linkedin_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  recipientLinkedinUrl: text('recipient_linkedin_url').notNull(),
  recipientName: text('recipient_name'),
  recipientCompany: text('recipient_company'),
  recipientTitle: text('recipient_title'),
  contactId: uuid('contact_id'),
  firstMessageAt: timestamp('first_message_at', { withTimezone: true }),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  totalMessages: integer('total_messages').default(0),
  outboundCount: integer('outbound_count').default(0),
  inboundCount: integer('inbound_count').default(0),
  currentStage: varchar('current_stage', { length: 32 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_linkedin_conv_user').on(t.tenantId, t.userId),
  unique('linkedin_conversations_tenant_url_unique').on(t.tenantId, t.recipientLinkedinUrl),
]);

export type LinkedinConversation = typeof linkedinConversations.$inferSelect;
export type NewLinkedinConversation = typeof linkedinConversations.$inferInsert;
