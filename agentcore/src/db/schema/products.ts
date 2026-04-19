import { pgTable, uuid, varchar, text, timestamp, jsonb, boolean, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 100 }),
  targetAudience: text('target_audience'),
  painPointsSolved: jsonb('pain_points_solved').$type<string[]>(),
  keyFeatures: jsonb('key_features').$type<string[]>(),
  differentiators: jsonb('differentiators').$type<string[]>(),
  pricingModel: varchar('pricing_model', { length: 50 }),
  pricingDetails: text('pricing_details'),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('products_tenant_id_idx').on(t.tenantId),
  index('products_tenant_active_idx').on(t.tenantId, t.isActive),
]);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
