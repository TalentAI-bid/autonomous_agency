import { pgTable, uuid, varchar, text, integer, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { agentTypeEnum } from './agent-configs.js';

export const agentActivityLog = pgTable('agent_activity_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  agentType: agentTypeEnum('agent_type').notNull(),
  action: varchar('action', { length: 100 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(), // started, completed, failed, skipped
  inputSummary: text('input_summary'),
  outputSummary: text('output_summary'),
  details: jsonb('details').$type<Record<string, unknown>>(),
  durationMs: integer('duration_ms'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('activity_log_tenant_created_idx').on(t.tenantId, sql`${t.createdAt} DESC`),
  index('activity_log_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('activity_log_tenant_type_idx').on(t.tenantId, t.agentType),
  index('activity_log_tenant_status_idx').on(t.tenantId, t.status),
]);

export type AgentActivityLog = typeof agentActivityLog.$inferSelect;
export type NewAgentActivityLog = typeof agentActivityLog.$inferInsert;
