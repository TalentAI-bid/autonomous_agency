import { pgTable, uuid, text, varchar, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { linkedinConversations } from './linkedin-conversations.js';

/**
 * Single message in a LinkedIn DM thread — either scraped from the user's
 * inbox (direction = 'inbound' or 'outbound') or a copilot draft
 * (is_copilot_draft = true). Drafts persist even when unused so analytics
 * can measure draft-acceptance rate.
 */
export const linkedinMessages = pgTable('linkedin_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => linkedinConversations.id, { onDelete: 'cascade' }),
  direction: varchar('direction', { length: 16 }).notNull(),
  body: text('body').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
  classifiedIntent: varchar('classified_intent', { length: 32 }),
  classifiedPriority: varchar('classified_priority', { length: 16 }),
  classificationConfidence: integer('classification_confidence'),
  isCopilotDraft: boolean('is_copilot_draft').default(false),
  draftForMessageId: uuid('draft_for_message_id'),
  draftStrategy: text('draft_strategy'),
  draftUsed: boolean('draft_used'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_linkedin_msg_conv').on(t.conversationId, t.sentAt),
]);

export type LinkedinMessage = typeof linkedinMessages.$inferSelect;
export type NewLinkedinMessage = typeof linkedinMessages.$inferInsert;
