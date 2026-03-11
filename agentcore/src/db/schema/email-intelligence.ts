import { pgTable, uuid, varchar, text, boolean, integer, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ── Enums ────────────────────────────────────────────────────────────────────

export const emailDiscoveryMethodEnum = pgEnum('email_discovery_method', [
  'generect', 'searxng', 'github', 'domain_pattern', 'mx_guess', 'manual', 'crawl',
]);

export const deliverySignalTypeEnum = pgEnum('delivery_signal_type', [
  'delivered', 'bounced_hard', 'bounced_soft', 'opened', 'replied',
]);

// ── email_intelligence — persistent email discovery cache ────────────────────

export const emailIntelligence = pgTable('email_intelligence', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  firstName: varchar('first_name', { length: 255 }).notNull(),
  lastName: varchar('last_name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 255 }).notNull(),
  confidence: integer('confidence').notNull().default(0),
  method: emailDiscoveryMethodEnum('method'),
  source: text('source'),
  verified: boolean('verified').default(false).notNull(),
  invalidated: boolean('invalidated').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('email_intel_name_domain_uniq').on(t.firstName, t.lastName, t.domain),
  index('email_intel_domain_name_idx').on(t.domain, t.firstName, t.lastName),
  index('email_intel_email_idx').on(t.email),
]);

export type EmailIntelligenceRecord = typeof emailIntelligence.$inferSelect;
export type NewEmailIntelligenceRecord = typeof emailIntelligence.$inferInsert;

// ── domain_patterns — learned email patterns per domain ──────────────────────

export const domainPatterns = pgTable('domain_patterns', {
  id: uuid('id').primaryKey().defaultRandom(),
  domain: varchar('domain', { length: 255 }).notNull(),
  pattern: varchar('pattern', { length: 255 }).notNull(),
  confidence: integer('confidence').notNull().default(0),
  confirmedCount: integer('confirmed_count').notNull().default(0),
  bouncedCount: integer('bounced_count').notNull().default(0),
  isCatchAll: boolean('is_catch_all').default(false).notNull(),
  mxProvider: varchar('mx_provider', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('domain_patterns_domain_pattern_uniq').on(t.domain, t.pattern),
  index('domain_patterns_domain_idx').on(t.domain),
]);

export type DomainPattern = typeof domainPatterns.$inferSelect;
export type NewDomainPattern = typeof domainPatterns.$inferInsert;

// ── delivery_signals — delivery outcome event log ────────────────────────────

export const deliverySignals = pgTable('delivery_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 255 }).notNull(),
  patternUsed: varchar('pattern_used', { length: 255 }),
  signalType: deliverySignalTypeEnum('signal_type').notNull(),
  bounceMessage: text('bounce_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('delivery_signals_domain_idx').on(t.domain),
  index('delivery_signals_email_idx').on(t.email),
]);

export type DeliverySignal = typeof deliverySignals.$inferSelect;
export type NewDeliverySignal = typeof deliverySignals.$inferInsert;
