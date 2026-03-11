import { pgTable, uuid, varchar, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export const agentMessages = pgTable('agent_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'cascade' }),
  fromAgent: varchar('from_agent', { length: 50 }).notNull(),
  toAgent: varchar('to_agent', { length: 50 }),
  messageType: varchar('message_type', { length: 50 }).notNull(),
  content: jsonb('content').$type<Record<string, unknown>>().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('agent_messages_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('agent_messages_created_idx').on(t.masterAgentId, t.createdAt),
  index('agent_messages_from_agent_idx').on(t.masterAgentId, t.fromAgent),
  index('agent_messages_type_idx').on(t.masterAgentId, t.messageType),
]);

export type AgentMessage = typeof agentMessages.$inferSelect;
export type NewAgentMessage = typeof agentMessages.$inferInsert;
