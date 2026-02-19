import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';

export const planEnum = pgEnum('plan', ['free', 'starter', 'pro', 'enterprise']);
export const productTypeEnum = pgEnum('product_type', ['recruitment', 'sales', 'both']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  plan: planEnum('plan').default('free').notNull(),
  productType: productTypeEnum('product_type').default('recruitment').notNull(),
  settings: jsonb('settings').default({}).$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
