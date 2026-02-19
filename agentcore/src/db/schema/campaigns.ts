import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';

export const campaignTypeEnum = pgEnum('campaign_type', ['email', 'linkedin', 'multi_channel']);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused', 'completed']);

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: campaignTypeEnum('type').default('email').notNull(),
  status: campaignStatusEnum('status').default('draft').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>(),
  stats: jsonb('stats').$type<{
    sent: number;
    opened: number;
    replied: number;
    meetingsBooked: number;
  }>().default({ sent: 0, opened: 0, replied: 0, meetingsBooked: 0 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('campaigns_tenant_status_idx').on(t.tenantId, t.status),
  index('campaigns_active_idx').on(t.id).where(sql`status = 'active'`),
]);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
