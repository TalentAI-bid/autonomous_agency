import { pgTable, uuid, date, timestamp, jsonb, text, pgEnum, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export const strategyStatusEnum = pgEnum('strategy_status', [
  'pending', 'analyzing', 'executing', 'completed', 'failed',
]);

export const agentDailyStrategy = pgTable('agent_daily_strategy', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').notNull().references(() => masterAgents.id, { onDelete: 'cascade' }),
  strategyDate: date('strategy_date').notNull(),
  performanceAnalysis: jsonb('performance_analysis').$type<Record<string, unknown>>(),
  strategyDecisions: jsonb('strategy_decisions').$type<Record<string, unknown>>(),
  actionPlan: jsonb('action_plan').$type<Record<string, unknown>>(),
  executionStatus: strategyStatusEnum('execution_status').default('pending').notNull(),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('strategy_master_date_uniq').on(t.masterAgentId, t.strategyDate),
  index('strategy_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('strategy_tenant_date_idx').on(t.tenantId, sql`${t.strategyDate} DESC`),
]);

export type AgentDailyStrategy = typeof agentDailyStrategy.$inferSelect;
export type NewAgentDailyStrategy = typeof agentDailyStrategy.$inferInsert;
