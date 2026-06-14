import { pgTable, uuid, varchar, text, boolean, integer, timestamp, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { companies } from './companies.js';
import { users } from './users.js';

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
  // IANA timezone string (e.g. "Europe/Vilnius") used by the followup
  // scheduler's sending-window check. Resolved lazily from
  // company.headquarters and cached here.
  timezone: varchar('timezone', { length: 64 }),
  // Permanent unsubscribe — set via the manual /unsubscribe API. When true
  // the followup-scheduler skips the contact and the dashboard hides the
  // sequence buttons. Distinct from the per-sequence stopped_manual state.
  unsubscribed: boolean('unsubscribed').default(false).notNull(),
  // The buyer-fit scorer picks ONE key person per company (the LLM-chosen
  // decision-maker). That contact gets is_primary_contact=true; the existing
  // top-3 LinkedIn-people contacts the team-fetch handler inserts keep the
  // default false. Auto-outreach (when re-enabled) targets the primary;
  // manual outreach defaults to it but the user can pick others.
  isPrimaryContact: boolean('is_primary_contact').default(false).notNull(),
  // enrichmentRetryCount: integer('enrichment_retry_count').default(0), // Disabled — not migrated to production
  // ─── Sales Operations Platform — Stage 1 additions ──────────────────
  // source_type and source_metadata describe how the contact entered the
  // pipeline (vs. the legacy `source` enum, which is kept for back-compat
  // with the auto-discovery code paths). Source-type values include
  // 'ai_discovery' | 'manual_linkedin' | 'referral' | 'extension_capture' |
  // 'imported_csv' | 'manual_other'. Free text; not enforced as an enum so
  // new capture surfaces can introduce their own values without a migration.
  sourceType: text('source_type').notNull().default('ai_discovery'),
  sourceMetadata: jsonb('source_metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  doNotContact: boolean('do_not_contact').notNull().default(false),
  doNotContactReason: text('do_not_contact_reason'),
  doNotContactAt: timestamp('do_not_contact_at', { withTimezone: true }),
  customTags: text('custom_tags').array().notNull().default(sql`ARRAY[]::text[]`),
  headline: text('headline'),
  about: text('about'),
  phone: varchar('phone', { length: 64 }),
  whatsapp: varchar('whatsapp', { length: 64 }),
  twitterUrl: varchar('twitter_url', { length: 500 }),
  intentScore: integer('intent_score').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('contacts_tenant_status_idx').on(t.tenantId, t.status),
  index('contacts_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('contacts_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('contacts_email_gin_idx').using('gin', sql`${t.email} gin_trgm_ops`),
  index('contacts_skills_gin_idx').using('gin', sql`${t.skills} jsonb_path_ops`),
  index('contacts_completeness_idx').on(t.tenantId, t.dataCompleteness),
  // Race-safe dedup on (tenant_id, lower(email)) and (tenant_id, linkedin_url).
  // The capture endpoint relies on these to fail INSERTs that race with
  // each other, then catches and converts to isDuplicate.
  uniqueIndex('contacts_tenant_email_unique')
    .on(t.tenantId, sql`lower(${t.email})`)
    .where(sql`${t.email} IS NOT NULL`),
  uniqueIndex('contacts_tenant_linkedin_unique')
    .on(t.tenantId, t.linkedinUrl)
    .where(sql`${t.linkedinUrl} IS NOT NULL`),
  index('contacts_tenant_tags_gin').using('gin', t.customTags),
]);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
