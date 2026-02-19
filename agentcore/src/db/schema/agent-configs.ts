import { pgTable, uuid, text, timestamp, jsonb, boolean, pgEnum, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export const agentTypeEnum = pgEnum('agent_type', [
  'discovery', 'enrichment', 'document', 'scoring', 'outreach', 'reply', 'action',
]);

export const agentConfigs = pgTable('agent_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').notNull().references(() => masterAgents.id, { onDelete: 'cascade' }),
  agentType: agentTypeEnum('agent_type').notNull(),
  systemPrompt: text('system_prompt'),
  tools: jsonb('tools').$type<string[]>(),
  parameters: jsonb('parameters').$type<Record<string, unknown>>(),
  outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
  isEnabled: boolean('is_enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('agent_configs_master_type_uniq').on(t.masterAgentId, t.agentType),
  index('agent_configs_tenant_master_idx').on(t.tenantId, t.masterAgentId),
]);

export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;
