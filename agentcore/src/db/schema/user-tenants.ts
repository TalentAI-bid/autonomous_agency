import { pgTable, uuid, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { users, userRoleEnum } from './users.js';
import { tenants } from './tenants.js';

export const userTenants = pgTable('user_tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  role: userRoleEnum('role').default('member').notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique('user_tenants_user_tenant_uniq').on(t.userId, t.tenantId),
  index('user_tenants_user_id_idx').on(t.userId),
  index('user_tenants_tenant_id_idx').on(t.tenantId),
]);

export type UserTenant = typeof userTenants.$inferSelect;
export type NewUserTenant = typeof userTenants.$inferInsert;
