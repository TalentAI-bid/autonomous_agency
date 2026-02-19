import { pgTable, uuid, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';
import { masterAgents } from './master-agents.js';

export const interviewStatusEnum = pgEnum('interview_status', [
  'scheduled', 'completed', 'cancelled', 'no_show',
]);

export const interviews = pgTable('interviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  status: interviewStatusEnum('status').default('scheduled').notNull(),
  meetingUrl: varchar('meeting_url', { length: 500 }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('interviews_tenant_id_idx').on(t.tenantId),
  index('interviews_contact_idx').on(t.contactId),
]);

export type Interview = typeof interviews.$inferSelect;
export type NewInterview = typeof interviews.$inferInsert;
