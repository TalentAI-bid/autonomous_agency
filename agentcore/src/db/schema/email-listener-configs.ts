import { pgTable, uuid, varchar, text, boolean, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { emailAccounts } from './email-accounts.js';

export const listenerProtocolEnum = pgEnum('listener_protocol', [
  'imap', 'pop3',
]);

export const emailListenerConfigs = pgTable('email_listener_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  emailAccountId: uuid('email_account_id').references(() => emailAccounts.id, { onDelete: 'cascade' }),
  protocol: listenerProtocolEnum('protocol').default('imap').notNull(),
  host: varchar('host', { length: 255 }).notNull(),
  port: integer('port').default(993).notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  password: text('password').notNull(), // encrypted
  useTls: boolean('use_tls').default(true).notNull(),
  mailbox: varchar('mailbox', { length: 255 }).default('INBOX').notNull(),
  pollingIntervalMs: integer('polling_interval_ms').default(60000).notNull(),
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  lastSeenUid: varchar('last_seen_uid', { length: 255 }),
  isActive: boolean('is_active').default(true).notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('email_listener_configs_tenant_idx').on(t.tenantId),
  index('email_listener_configs_active_idx').on(t.tenantId, t.isActive),
]);

export type EmailListenerConfig = typeof emailListenerConfigs.$inferSelect;
export type NewEmailListenerConfig = typeof emailListenerConfigs.$inferInsert;
