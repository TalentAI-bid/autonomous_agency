import { pgTable, uuid, varchar, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'member', 'viewer']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }),
  role: userRoleEnum('role').default('member').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('users_tenant_id_idx').on(t.tenantId),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
