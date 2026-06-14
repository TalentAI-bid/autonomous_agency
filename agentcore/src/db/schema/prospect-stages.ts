import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.js';
import { contacts } from './contacts.js';

/**
 * Pipeline-stage tracking for every contact. One row per contact. Distinct
 * from the legacy `contacts.status` enum so the Sales Operations Platform
 * vocabulary ('new' | 'first_touch_sent' | 'awaiting_response' | …) can
 * evolve without breaking the auto-discovery code paths.
 *
 * Stage 1 only inserts a row at capture time (stage='new') and on DNC
 * (stage='dnc'). Stage 2 wires more transitions from existing pipelines.
 */
export type ProspectStage =
  | 'new'
  | 'first_touch_sent'
  | 'awaiting_response'
  | 'engaged'
  | 'qualified'
  | 'meeting_scheduled'
  | 'in_evaluation'
  | 'closed_won'
  | 'closed_lost'
  | 'cold'
  | 'dnc';

export const prospectStages = pgTable('prospect_stages', {
  contactId: uuid('contact_id').primaryKey().references(() => contacts.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  currentStage: text('current_stage').$type<ProspectStage>().notNull().default('new'),
  stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull().defaultNow(),
  nextActionDue: timestamp('next_action_due', { withTimezone: true }),
  totalTouches: integer('total_touches').notNull().default(0),
  lastTouchAt: timestamp('last_touch_at', { withTimezone: true }),
  lastResponseAt: timestamp('last_response_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('prospect_stages_tenant_stage_idx').on(t.tenantId, t.currentStage),
  index('prospect_stages_next_action_idx').on(t.tenantId, t.nextActionDue),
]);

export type ProspectStageRow = typeof prospectStages.$inferSelect;
export type NewProspectStageRow = typeof prospectStages.$inferInsert;
