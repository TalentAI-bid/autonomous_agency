import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';

export const planEnum = pgEnum('plan', ['free', 'starter', 'pro', 'enterprise']);
export const productTypeEnum = pgEnum('product_type', ['recruitment', 'sales', 'both']);

/**
 * Per-tenant messaging configuration used by the Message Studio (manual
 * composition tool). All fields optional so partial saves work; the studio
 * service rejects generation when value_prop is missing.
 */
export interface MessagingConfig {
  sender_name?: string;
  sender_title?: string;
  sender_location?: string;
  sender_company?: string;
  value_prop?: string;
  target_icp?: string;
  differentiator?: string;
  pricing_summary?: string;
  brand_voice_notes?: string;
  /**
   * Hard whitelist of specific factual claims the Inbox Copilot may quote
   * near-verbatim about the sender / sender's company. Anything specific
   * NOT in this list must be rephrased qualitatively by the model
   * (see ABSOLUTE RULE 0 in reply-generation.prompt.ts). Empty/undefined
   * means qualitative-only — drafts will avoid all past-tense self-claims
   * with numbers, dates, named clients, or specific timelines.
   */
  verified_facts?: string[];
}

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  plan: planEnum('plan').default('free').notNull(),
  productType: productTypeEnum('product_type').default('recruitment').notNull(),
  settings: jsonb('settings').default({}).$type<Record<string, unknown>>(),
  messagingConfig: jsonb('messaging_config').default({}).$type<MessagingConfig>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
