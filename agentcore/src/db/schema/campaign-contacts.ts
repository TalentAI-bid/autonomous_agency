import { pgTable, uuid, integer, timestamp, pgEnum, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { campaigns } from './campaigns.js';
import { contacts } from './contacts.js';

export const campaignContactStatusEnum = pgEnum('campaign_contact_status', [
  'pending', 'active', 'replied', 'bounced', 'unsubscribed', 'completed',
]);

export const campaignContacts = pgTable('campaign_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  currentStep: integer('current_step').default(0).notNull(),
  status: campaignContactStatusEnum('status').default('pending').notNull(),
  lastActionAt: timestamp('last_action_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex('campaign_contacts_campaign_contact_uniq').on(t.campaignId, t.contactId),
  index('campaign_contacts_status_idx').on(t.status),
]);

export type CampaignContact = typeof campaignContacts.$inferSelect;
export type NewCampaignContact = typeof campaignContacts.$inferInsert;
