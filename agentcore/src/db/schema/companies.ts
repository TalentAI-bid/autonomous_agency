import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 255 }),
  industry: varchar('industry', { length: 255 }),
  size: varchar('size', { length: 100 }),
  techStack: jsonb('tech_stack').$type<string[]>(),
  funding: varchar('funding', { length: 255 }),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),
  description: text('description'),
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
  score: integer('score'),
  scoreDetails: jsonb('score_details').$type<Record<string, unknown>>(),
  dataCompleteness: integer('data_completeness').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('companies_tenant_id_idx').on(t.tenantId),
  index('companies_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('companies_tech_stack_gin_idx').using('gin', sql`${t.techStack} jsonb_path_ops`),
  index('companies_completeness_idx').on(t.tenantId, t.dataCompleteness),
]);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
