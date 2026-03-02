import { pgTable, uuid, varchar, text, boolean, integer, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const emailProviderEnum = pgEnum('email_provider', [
  'smtp', 'ses', 'sendgrid', 'custom',
]);

export const emailAccounts = pgTable('email_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  provider: emailProviderEnum('provider').default('smtp').notNull(),
  // SMTP config
  smtpHost: varchar('smtp_host', { length: 255 }),
  smtpPort: integer('smtp_port').default(587),
  smtpUser: varchar('smtp_user', { length: 255 }),
  smtpPass: text('smtp_pass'), // encrypted
  // Identity
  fromEmail: varchar('from_email', { length: 255 }).notNull(),
  fromName: varchar('from_name', { length: 255 }),
  replyTo: varchar('reply_to', { length: 255 }),
  // Quotas
  dailyQuota: integer('daily_quota').default(500).notNull(),
  hourlyQuota: integer('hourly_quota').default(50).notNull(),
  // Warmup
  isWarmup: boolean('is_warmup').default(false).notNull(),
  warmupStartDate: timestamp('warmup_start_date', { withTimezone: true }),
  warmupDaysSent: integer('warmup_days_sent').default(0).notNull(),
  // Priority & status
  priority: integer('priority').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  // Extra config (e.g. SES region, SendGrid API key)
  config: jsonb('config').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('email_accounts_tenant_idx').on(t.tenantId),
  index('email_accounts_tenant_active_idx').on(t.tenantId, t.isActive),
]);

export type EmailAccount = typeof emailAccounts.$inferSelect;
export type NewEmailAccount = typeof emailAccounts.$inferInsert;
