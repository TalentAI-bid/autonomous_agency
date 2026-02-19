import { pgTable, uuid, varchar, text, timestamp, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { masterAgents } from './master-agents.js';
import { contacts } from './contacts.js';

export const docTypeEnum = pgEnum('doc_type', [
  'job_spec', 'cv', 'whitepaper', 'spec', 'linkedin_profile', 'other',
]);

export const docStatusEnum = pgEnum('doc_status', ['uploaded', 'processing', 'processed', 'error']);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  masterAgentId: uuid('master_agent_id').references(() => masterAgents.id, { onDelete: 'set null' }),
  contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  type: docTypeEnum('type').notNull(),
  fileName: varchar('file_name', { length: 255 }),
  filePath: varchar('file_path', { length: 500 }),
  mimeType: varchar('mime_type', { length: 100 }),
  extractedData: jsonb('extracted_data').$type<Record<string, unknown>>(),
  rawText: text('raw_text'),
  status: docStatusEnum('status').default('uploaded').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('documents_tenant_master_idx').on(t.tenantId, t.masterAgentId),
  index('documents_tenant_created_idx').on(t.tenantId, t.createdAt),
]);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
