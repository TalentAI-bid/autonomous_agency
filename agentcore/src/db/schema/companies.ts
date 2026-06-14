import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export type CompanyStage =
  | 'new'
  | 'first_touch_sent'
  | 'awaiting_response'
  | 'engaged'
  | 'qualified'
  | 'meeting_scheduled'
  | 'in_evaluation'
  | 'closed_won'
  | 'closed_lost'
  | 'cold'
  | 'dnc';

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
  painPoints: jsonb('pain_points').$type<Array<{
    type: string; severity: 'high' | 'medium' | 'low';
    description: string; score?: number; issues?: string[]; roles?: string[];
  }>>(),
  websiteStatus: varchar('website_status', { length: 50 }),
  seoScore: integer('seo_score'),
  // Company-level stage tracking — added by migration 0035 for the
  // company-centric triage refactor. The corresponding prospect_stages
  // table stays for contact-level views (contact-detail filters); these
  // columns drive triage rule evaluation.
  doNotContact: boolean('do_not_contact').notNull().default(false),
  currentStage: text('current_stage').$type<CompanyStage>().notNull().default('new'),
  stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull().defaultNow(),
  lastTouchAt: timestamp('last_touch_at', { withTimezone: true }),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  totalOutboundTouches: integer('total_outbound_touches').notNull().default(0),
  totalInboundResponses: integer('total_inbound_responses').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('companies_tenant_id_idx').on(t.tenantId),
  index('companies_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('companies_tech_stack_gin_idx').using('gin', sql`${t.techStack} jsonb_path_ops`),
  index('companies_completeness_idx').on(t.tenantId, t.dataCompleteness),
  index('companies_tenant_stage_idx').on(t.tenantId, t.currentStage),
  index('companies_tenant_score_idx').on(t.tenantId, t.score),
]);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
