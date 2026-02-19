import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { agentTypeEnum } from './agent-configs.js';

export const memoryTypeEnum = pgEnum('memory_type', ['short_term', 'medium_term', 'long_term']);

export const agentMemory = pgTable('agent_memory', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'cascade' }),
  agentType: agentTypeEnum('agent_type').notNull(),
  memoryType: memoryTypeEnum('memory_type').notNull(),
  key: varchar('key', { length: 255 }).notNull(),
  value: jsonb('value').notNull().$type<Record<string, unknown>>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('agent_memory_tenant_agent_idx').on(t.tenantId, t.masterAgentId, t.agentType),
  index('agent_memory_key_idx').on(t.tenantId, t.key),
]);

export type AgentMemory = typeof agentMemory.$inferSelect;
export type NewAgentMemory = typeof agentMemory.$inferInsert;
