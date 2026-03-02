import { pgTable, uuid, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { masterAgents } from './master-agents.js';

export const conversationStatusEnum = pgEnum('conversation_status', ['active', 'completed', 'abandoned']);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  status: conversationStatusEnum('status').default('active').notNull(),
  extractedConfig: jsonb('extracted_config').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('conversations_tenant_id_idx').on(t.tenantId),
  index('conversations_user_id_idx').on(t.userId),
  index('conversations_tenant_status_idx').on(t.tenantId, t.status),
]);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
