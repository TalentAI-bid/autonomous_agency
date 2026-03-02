import { pgTable, uuid, text, integer, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { conversations } from './conversations.js';

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system']);
export const messageTypeEnum = pgEnum('message_type', ['text', 'file_upload', 'pipeline_proposal', 'pipeline_approved', 'error']);

export const conversationMessages = pgTable('conversation_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: messageRoleEnum('role').notNull(),
  type: messageTypeEnum('type').default('text').notNull(),
  content: text('content').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  proposalData: jsonb('proposal_data').$type<Record<string, unknown>>(),
  orderIndex: integer('order_index').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('conversation_messages_conversation_id_idx').on(t.conversationId),
  index('conversation_messages_order_idx').on(t.conversationId, t.orderIndex),
]);

export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type NewConversationMessage = typeof conversationMessages.$inferInsert;
