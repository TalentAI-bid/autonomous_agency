import { pgTable, uuid, varchar, text, integer, timestamp, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { contacts } from './contacts.js';

export const redditOpportunityStatusEnum = pgEnum('reddit_opportunity_status', [
  'new', 'processing', 'contacted', 'converted', 'skipped',
]);

export const redditOpportunities = pgTable('reddit_opportunities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  redditPostId: varchar('reddit_post_id', { length: 50 }).notNull(),
  subreddit: varchar('subreddit', { length: 100 }),
  postTitle: text('post_title'),
  postUrl: text('post_url').notNull(),
  authorUsername: varchar('author_username', { length: 100 }),
  buyingIntentScore: integer('buying_intent_score'),
  opportunityType: varchar('opportunity_type', { length: 50 }),
  recommendedAction: varchar('recommended_action', { length: 50 }),
  extractedData: jsonb('extracted_data').$type<Record<string, unknown>>(),
  authorProfileData: jsonb('author_profile_data').$type<Record<string, unknown>>(),
  status: redditOpportunityStatusEnum('status').default('new').notNull(),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('reddit_opp_tenant_post_uniq').on(t.tenantId, t.redditPostId),
  index('reddit_opp_tenant_status_idx').on(t.tenantId, t.status),
  index('reddit_opp_tenant_score_idx').on(t.tenantId, sql`${t.buyingIntentScore} DESC`),
  index('reddit_opp_tenant_master_idx').on(t.tenantId, t.masterAgentId),
]);

export type RedditOpportunity = typeof redditOpportunities.$inferSelect;
export type NewRedditOpportunity = typeof redditOpportunities.$inferInsert;
