import { pgTable, uuid, varchar, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 255 }),
  industry: varchar('industry', { length: 255 }),
  size: varchar('size', { length: 100 }),
  techStack: jsonb('tech_stack').$type<string[]>(),
  funding: varchar('funding', { length: 255 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),
  description: text('description'),
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('companies_tenant_id_idx').on(t.tenantId),
  index('companies_tech_stack_gin_idx').using('gin', sql`${t.techStack} jsonb_path_ops`),
]);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
