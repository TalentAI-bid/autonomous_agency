import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { users } from './users.js';

export const useCaseEnum = pgEnum('use_case', ['recruitment', 'sales', 'custom']);
export const masterAgentStatusEnum = pgEnum('master_agent_status', ['idle', 'running', 'paused', 'error']);

export const masterAgents = pgTable('master_agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  mission: text('mission'),
  useCase: useCaseEnum('use_case').notNull(),
  status: masterAgentStatusEnum('status').default('idle').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>(),
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
