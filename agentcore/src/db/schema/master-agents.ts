import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, pgEnum, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const useCaseEnum = pgEnum('use_case', ['recruitment', 'sales', 'custom']);
export const masterAgentStatusEnum = pgEnum('master_agent_status', [
  'idle', 'running', 'paused', 'error', 'awaiting_action_plan', 'paused_quota',
]);
export const reviewModeEnum = pgEnum('review_mode', ['auto', 'manual']);

export interface ActionPlanItem {
  key: string;
  question: string;
  required: boolean;
  answer?: string | null;
}
export interface ActionPlan {
  status: 'pending' | 'completed' | 'skipped';
  items: ActionPlanItem[];
  generatedAt?: string;
  completedAt?: string;
}

export const masterAgents = pgTable('master_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  mission: text('mission'),
  useCase: useCaseEnum('use_case').notNull(),
  status: masterAgentStatusEnum('status').default('idle').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>(),
  actionPlan: jsonb('action_plan').$type<ActionPlan>(),
  reviewMode: reviewModeEnum('review_mode').default('manual').notNull(),
  dailyRuntimeBudgetMs: integer('daily_runtime_budget_ms').default(3_600_000).notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('master_agents_tenant_id_idx').on(t.tenantId),
  index('master_agents_tenant_status_idx').on(t.tenantId, t.status),
  index('master_agents_active_idx').on(t.id).where(sql`status = 'running'`),
]);

export type MasterAgent = typeof masterAgents.$inferSelect;
export type NewMasterAgent = typeof masterAgents.$inferInsert;
