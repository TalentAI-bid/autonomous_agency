import { pgTable, uuid, varchar, text, jsonb, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export const pipelineErrors = pgTable('pipeline_errors', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'cascade' }),
  step: varchar('step', { length: 100 }).notNull(),
  tool: varchar('tool', { length: 50 }).notNull(),
  severity: varchar('severity', { length: 20 }).notNull().default('error'),
  errorType: varchar('error_type', { length: 50 }).notNull(),
  message: text('message').notNull(),
  context: jsonb('context').$type<Record<string, unknown>>(),
  retryable: boolean('retryable').notNull().default(false),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('pipeline_errors_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('pipeline_errors_master_agent_idx').on(t.masterAgentId, t.resolvedAt),
  index('pipeline_errors_type_idx').on(t.tenantId, t.errorType),
]);

export type PipelineError = typeof pipelineErrors.$inferSelect;
export type NewPipelineError = typeof pipelineErrors.$inferInsert;
