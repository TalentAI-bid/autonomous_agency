import { pgTable, uuid, varchar, text, boolean, integer, timestamp, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { users } from './users.js';
import { masterAgents } from './master-agents.js';

export const extensionSiteEnum = pgEnum('extension_site', [
  'linkedin', 'gmaps', 'crunchbase',
]);

export const extensionTaskTypeEnum = pgEnum('extension_task_type', [
  'search_companies', 'fetch_company', 'search_businesses', 'fetch_business',
]);

export const extensionTaskStatusEnum = pgEnum('extension_task_status', [
  'pending', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled',
]);

export const extensionSessions = pgTable('extension_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  apiKey: varchar('api_key', { length: 128 }),
  apiKeyHash: varchar('api_key_hash', { length: 128 }).notNull(),
  connected: boolean('connected').default(false).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  dailyTasksCount: jsonb('daily_tasks_count').$type<Record<string, number>>().default({}).notNull(),
  dailyResetAt: timestamp('daily_reset_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('extension_sessions_api_key_hash_idx').on(t.apiKeyHash),
  index('extension_sessions_tenant_user_idx').on(t.tenantId, t.userId),
  index('extension_sessions_tenant_revoked_idx').on(t.tenantId, t.revokedAt),
]);

export const extensionTasks = pgTable('extension_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  sessionId: uuid('session_id').references(() => extensionSessions.id, { onDelete: 'set null' }),
  site: extensionSiteEnum('site').notNull(),
  type: extensionTaskTypeEnum('type').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().default({}).notNull(),
  status: extensionTaskStatusEnum('status').default('pending').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  priority: integer('priority').default(5).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  // Earliest moment this task may be dispatched. Default `now()` keeps
  // immediate-dispatch behaviour. Bulk fan-outs (LinkedIn Jobs scrape,
  // search_companies result) distribute tasks across batches by setting
  // future dispatchAfter so the extension processes them in waves instead
  // of all at once — protects against LinkedIn 429s when 100+ companies
  // would otherwise be queued back-to-back.
  dispatchAfter: timestamp('dispatch_after', { withTimezone: true }).defaultNow().notNull(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('extension_tasks_tenant_status_priority_idx').on(t.tenantId, t.status, t.priority, t.createdAt),
  index('extension_tasks_site_status_idx').on(t.site, t.status),
  index('extension_tasks_session_status_idx').on(t.sessionId, t.status),
  index('extension_tasks_master_agent_idx').on(t.masterAgentId),
  index('extension_tasks_dispatch_after_idx').on(t.tenantId, t.status, t.dispatchAfter),
]);

export type ExtensionSession = typeof extensionSessions.$inferSelect;
export type NewExtensionSession = typeof extensionSessions.$inferInsert;
export type ExtensionTask = typeof extensionTasks.$inferSelect;
export type NewExtensionTask = typeof extensionTasks.$inferInsert;
