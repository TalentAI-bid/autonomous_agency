import { pgTable, uuid, varchar, text, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { masterAgents } from './master-agents.js';
import { campaigns } from './campaigns.js';
import { crmStages } from './crm-stages.js';

export const deals = pgTable('deals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  stageId: uuid('stage_id').notNull().references(() => crmStages.id, { onDelete: 'restrict' }),
  title: varchar('title', { length: 500 }).notNull(),
  value: numeric('value', { precision: 12, scale: 2 }),
  currency: varchar('currency', { length: 3 }).default('USD'),
  notes: text('notes'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  expectedCloseAt: timestamp('expected_close_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('deals_tenant_idx').on(t.tenantId),
  index('deals_tenant_stage_idx').on(t.tenantId, t.stageId),
  index('deals_contact_idx').on(t.contactId),
  index('deals_master_agent_idx').on(t.masterAgentId),
]);

export type Deal = typeof deals.$inferSelect;
export type NewDeal = typeof deals.$inferInsert;
