import { pgTable, uuid, text, integer, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';

export const stepChannelEnum = pgEnum('step_channel', ['email', 'linkedin']);

export const campaignSteps = pgTable('campaign_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  stepNumber: integer('step_number').notNull(),
  subject: text('subject'),
  template: text('template'),
  delayDays: integer('delay_days').default(0).notNull(),
  channel: stepChannelEnum('channel').default('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('campaign_steps_campaign_idx').on(t.campaignId),
]);

export type CampaignStep = typeof campaignSteps.$inferSelect;
export type NewCampaignStep = typeof campaignSteps.$inferInsert;
