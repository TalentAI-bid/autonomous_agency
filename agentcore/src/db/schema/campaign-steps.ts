import { pgTable, uuid, text, integer, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const stepChannelEnum = pgEnum('step_channel', ['email', 'linkedin']);

export const stepDelayBasisEnum = pgEnum('step_delay_basis', ['after_first', 'after_previous']);

export const stepTypeEnum = pgEnum('step_type', [
  'initial', 'followup_short', 'followup_value', 'followup_breakup', 'custom',
]);

export const campaignSteps = pgTable('campaign_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  // stepNumber is the existing column the spec calls "touchNumber"; reused for
  // followup sequences (1 = initial, 2/3/4 = follow-ups). See followup.service.
  stepNumber: integer('step_number').notNull(),
  subject: text('subject'),
  template: text('template'),
  delayDays: integer('delay_days').default(0).notNull(),
  // delayBasis: 'after_first' (each follow-up offset from touch 1's send) is
  // the default the scheduler assumes. 'after_previous' chains from the
  // most recent touch — useful for adaptive sequences.
  delayBasis: stepDelayBasisEnum('delay_basis').default('after_first').notNull(),
  stepType: stepTypeEnum('step_type').default('custom').notNull(),
  active: boolean('active').default(true).notNull(),
  channel: stepChannelEnum('channel').default('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('campaign_steps_campaign_idx').on(t.campaignId),
]);

export type CampaignStep = typeof campaignSteps.$inferSelect;
export type NewCampaignStep = typeof campaignSteps.$inferInsert;
