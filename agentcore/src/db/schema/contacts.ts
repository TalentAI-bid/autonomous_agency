import { pgTable, uuid, varchar, text, boolean, integer, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { companies } from './companies.js';

export const contactSourceEnum = pgEnum('contact_source', [
  'linkedin_search', 'linkedin_profile', 'cv_upload', 'manual', 'web_search', 'inbound', 'reddit',
]);

export const contactStatusEnum = pgEnum('contact_status', [
  'discovered', 'enriched', 'scored', 'contacted', 'replied',
  'qualified', 'interview_scheduled', 'rejected', 'archived',
]);

export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  firstName: varchar('first_name', { length: 255 }),
  lastName: varchar('last_name', { length: 255 }),
  email: varchar('email', { length: 255 }),
  emailVerified: boolean('email_verified').default(false),
  linkedinUrl: varchar('linkedin_url', { length: 500 }),
  title: varchar('title', { length: 255 }),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  companyName: varchar('company_name', { length: 255 }),
  location: varchar('location', { length: 255 }),
  skills: jsonb('skills').$type<string[]>(),
  experience: jsonb('experience').$type<Record<string, unknown>[]>(),
  education: jsonb('education').$type<Record<string, unknown>[]>(),
  score: integer('score'),
  scoreDetails: jsonb('score_details').$type<Record<string, unknown>>(),
  source: contactSourceEnum('source'),
  status: contactStatusEnum('status').default('discovered').notNull(),
  rawData: jsonb('raw_data').$type<Record<string, unknown>>(),
  dataCompleteness: integer('data_completeness').default(0),
  // enrichmentRetryCount: integer('enrichment_retry_count').default(0), // Disabled — not migrated to production
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('contacts_tenant_status_idx').on(t.tenantId, t.status),
  index('contacts_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('contacts_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('contacts_email_gin_idx').using('gin', sql`${t.email} gin_trgm_ops`),
  index('contacts_skills_gin_idx').using('gin', sql`${t.skills} jsonb_path_ops`),
  index('contacts_completeness_idx').on(t.tenantId, t.dataCompleteness),
]);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
