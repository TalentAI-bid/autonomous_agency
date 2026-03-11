import { pgTable, uuid, varchar, text, integer, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { companies } from './companies.js';
import { contacts } from './contacts.js';

export const opportunityTypeEnum = pgEnum('opportunity_type', [
  'hiring_signal', 'direct_request', 'recommendation_ask', 'project_announcement',
  'funding_signal', 'technology_adoption', 'tender_rfp', 'conference_signal',
  'pain_point_expressed', 'partnership_signal',
]);

export const opportunityUrgencyEnum = pgEnum('opportunity_urgency', [
  'immediate', 'soon', 'exploring', 'none',
]);

export const opportunityStatusEnum = pgEnum('opportunity_status', [
  'new', 'researching', 'qualified', 'contacted', 'converted', 'skipped',
]);

export const opportunities = pgTable('opportunities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').notNull().references(() => masterAgents.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 500 }).notNull(),
  description: text('description'),
  opportunityType: opportunityTypeEnum('opportunity_type').notNull(),
  source: varchar('source', { length: 500 }),
  sourceUrl: varchar('source_url', { length: 1000 }),
  sourcePlatform: varchar('source_platform', { length: 100 }),
  companyName: varchar('company_name', { length: 255 }),
  companyDomain: varchar('company_domain', { length: 255 }),
  personName: varchar('person_name', { length: 255 }),
  personTitle: varchar('person_title', { length: 255 }),
  technologies: jsonb('technologies').$type<string[]>(),
  budget: varchar('budget', { length: 100 }),
  timeline: varchar('timeline', { length: 100 }),
  location: varchar('location', { length: 255 }),
  rawContent: text('raw_content'),
  buyingIntentScore: integer('buying_intent_score').default(0).notNull(),
  urgency: opportunityUrgencyEnum('urgency').default('none').notNull(),
  status: opportunityStatusEnum('status').default('new').notNull(),
  companyId: uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('opportunities_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('opportunities_tenant_status_idx').on(t.tenantId, t.status),
  index('opportunities_tenant_score_idx').on(t.tenantId, sql`${t.buyingIntentScore} DESC`),
  index('opportunities_tenant_created_idx').on(t.tenantId, sql`${t.createdAt} DESC`),
]);

export type Opportunity = typeof opportunities.$inferSelect;
export type NewOpportunity = typeof opportunities.$inferInsert;
