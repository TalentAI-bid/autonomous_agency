import { pgTable, uuid, varchar, text, boolean, integer, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';

export const crmStages = pgTable('crm_stages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull(),
  color: varchar('color', { length: 7 }).default('#6366f1').notNull(),
  position: integer('position').default(0).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  isWon: boolean('is_won').default(false).notNull(),
  isLost: boolean('is_lost').default(false).notNull(),
  // Follow-up engine: whether leads sitting in this stage should receive
  // cadence-driven follow-up nudges in the Daily Queue. Stage names are
  // user-defined, so the flag is set by an LLM classification pass
  // (followUpClassifiedBy='ai') unless the user flips it themselves
  // (followUpClassifiedBy='user' — never overwritten by re-classification).
  followUpEligible: boolean('follow_up_eligible').default(false).notNull(),
  followUpClassifiedBy: text('follow_up_classified_by').$type<'ai' | 'user'>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('crm_stages_tenant_idx').on(t.tenantId),
  index('crm_stages_tenant_position_idx').on(t.tenantId, t.position),
  unique('crm_stages_tenant_slug_unique').on(t.tenantId, t.slug),
]);

export type CrmStage = typeof crmStages.$inferSelect;
export type NewCrmStage = typeof crmStages.$inferInsert;
