import { pgTable, uuid, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';
import { users, userRoleEnum } from './users.js';
import { tenants } from './tenants.js';

export const userTenants = pgTable('user_tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  role: userRoleEnum('role').default('member').notNull(),
  // The user's default workspace. The extension login response uses this as
  // `defaultWorkspaceId`; the dashboard rebind-token flow falls back here when
  // a fresh token is needed without a tenant hint. Enforced unique via a
  // partial index in 0029.
  isDefault: boolean('is_default').default(false).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('user_tenants_user_tenant_uniq').on(t.userId, t.tenantId),
  index('user_tenants_user_id_idx').on(t.userId),
  index('user_tenants_tenant_id_idx').on(t.tenantId),
]);

export type UserTenant = typeof userTenants.$inferSelect;
export type NewUserTenant = typeof userTenants.$inferInsert;
