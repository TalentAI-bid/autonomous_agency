import { pgTable, uuid, text, timestamp, jsonb, integer, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { agentTypeEnum } from './agent-configs.js';

export const taskStatusEnum = pgEnum('task_status', [
  'pending', 'processing', 'completed', 'failed', 'cancelled',
]);

export const agentTasks = pgTable('agent_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  agentType: agentTypeEnum('agent_type').notNull(),
  status: taskStatusEnum('status').default('pending').notNull(),
  priority: integer('priority').default(0).notNull(),
  input: jsonb('input').notNull().$type<Record<string, unknown>>(),
  output: jsonb('output').$type<Record<string, unknown>>(),
  error: text('error'),
  retryCount: integer('retry_count').default(0).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('agent_tasks_tenant_status_idx').on(t.tenantId, t.status),
  index('agent_tasks_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('agent_tasks_tenant_master_idx').on(t.tenantId, t.masterAgentId),
]);

export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;
