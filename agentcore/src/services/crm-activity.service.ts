import { eq, and, asc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { crmActivities, crmStages, deals, contacts } from '../db/schema/index.js';
import type { NewCrmActivity, CrmStage } from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

export interface LogActivityOpts {
  tenantId: string;
  contactId?: string;
  dealId?: string;
  userId?: string;
  masterAgentId?: string;
  type: NewCrmActivity['type'];
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log a CRM activity and emit a WebSocket event.
 */
export async function logActivity(opts: LogActivityOpts): Promise<{ id: string }> {
  const [activity] = await withTenant(opts.tenantId, async (tx) => {
    return tx.insert(crmActivities).values({
      tenantId: opts.tenantId,
      contactId: opts.contactId,
      dealId: opts.dealId,
      userId: opts.userId,
      masterAgentId: opts.masterAgentId,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      metadata: opts.metadata,
      occurredAt: new Date(),
    }).returning({ id: crmActivities.id });
  });

  // Emit real-time event
  try {
    await pubRedis.publish(
      `tenant:${opts.tenantId}`,
      JSON.stringify({
        event: 'crm:activity',
        data: { activityId: activity!.id, type: opts.type, title: opts.title, contactId: opts.contactId, dealId: opts.dealId },
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to publish CRM activity event');
  }

  return { id: activity!.id };
}

/** Default CRM pipeline stages */
const DEFAULT_STAGES: Array<{ name: string; slug: string; color: string; position: number; isDefault?: boolean; isWon?: boolean; isLost?: boolean }> = [
  { name: 'Lead', slug: 'lead', color: '#6b7280', position: 0, isDefault: true },
  { name: 'Contacted', slug: 'contacted', color: '#3b82f6', position: 1 },
  { name: 'Replied', slug: 'replied', color: '#8b5cf6', position: 2 },
  { name: 'Meeting Booked', slug: 'meeting-booked', color: '#f59e0b', position: 3 },
  { name: 'Qualified', slug: 'qualified', color: '#10b981', position: 4 },
  { name: 'Won', slug: 'won', color: '#22c55e', position: 5, isWon: true },
  { name: 'Lost', slug: 'lost', color: '#ef4444', position: 6, isLost: true },
];

/**
 * Seed default CRM stages for a tenant if none exist.
 */
export async function seedDefaultStages(tenantId: string): Promise<CrmStage[]> {
  const existing = await withTenant(tenantId, async (tx) => {
    return tx.select().from(crmStages).where(eq(crmStages.tenantId, tenantId)).limit(1);
  });

  if (existing.length > 0) {
    return withTenant(tenantId, async (tx) => {
      return tx.select().from(crmStages)
        .where(eq(crmStages.tenantId, tenantId))
        .orderBy(asc(crmStages.position));
    });
  }

  const stages = await withTenant(tenantId, async (tx) => {
    return tx.insert(crmStages).values(
      DEFAULT_STAGES.map((s) => ({
        tenantId,
        name: s.name,
        slug: s.slug,
        color: s.color,
        position: s.position,
        isDefault: s.isDefault ?? false,
        isWon: s.isWon ?? false,
        isLost: s.isLost ?? false,
      })),
    ).returning();
  });

  return stages;
}

/**
 * Get the default stage for a tenant (seeds if needed).
 */
export async function getDefaultStage(tenantId: string): Promise<CrmStage> {
  const stages = await seedDefaultStages(tenantId);
  return stages.find((s) => s.isDefault) ?? stages[0]!;
}

/**
 * Ensure a deal exists for a contact. Creates one at the default stage if none exists.
 */
export async function ensureDeal(opts: {
  tenantId: string;
  contactId: string;
  masterAgentId?: string;
  campaignId?: string;
}): Promise<{ id: string; created: boolean }> {
  // Check for existing deal
  const existing = await withTenant(opts.tenantId, async (tx) => {
    return tx.select().from(deals)
      .where(and(eq(deals.tenantId, opts.tenantId), eq(deals.contactId, opts.contactId)))
      .limit(1);
  });

  if (existing.length > 0) {
    return { id: existing[0]!.id, created: false };
  }

  // Get contact name for deal title
  const [contact] = await withTenant(opts.tenantId, async (tx) => {
    return tx.select({ firstName: contacts.firstName, lastName: contacts.lastName })
      .from(contacts)
      .where(eq(contacts.id, opts.contactId))
      .limit(1);
  });

  const contactName = [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || 'Unknown';
  const defaultStage = await getDefaultStage(opts.tenantId);

  const [deal] = await withTenant(opts.tenantId, async (tx) => {
    return tx.insert(deals).values({
      tenantId: opts.tenantId,
      contactId: opts.contactId,
      masterAgentId: opts.masterAgentId,
      campaignId: opts.campaignId,
      stageId: defaultStage.id,
      title: `Deal: ${contactName}`,
    }).returning({ id: deals.id });
  });

  return { id: deal!.id, created: true };
}

/**
 * Move a deal to a new stage. Logs a stage_change activity.
 */
export async function moveDealStage(opts: {
  tenantId: string;
  dealId: string;
  newStageId: string;
  userId?: string;
  masterAgentId?: string;
}): Promise<void> {
  // Get the old stage for the activity log
  const [deal] = await withTenant(opts.tenantId, async (tx) => {
    return tx.select().from(deals).where(eq(deals.id, opts.dealId)).limit(1);
  });
  if (!deal) return;

  const [oldStage] = await withTenant(opts.tenantId, async (tx) => {
    return tx.select().from(crmStages).where(eq(crmStages.id, deal.stageId)).limit(1);
  });
  const [newStage] = await withTenant(opts.tenantId, async (tx) => {
    return tx.select().from(crmStages).where(eq(crmStages.id, opts.newStageId)).limit(1);
  });

  // Check if the new stage is won/lost and set closedAt accordingly
  const closedAt = newStage?.isWon || newStage?.isLost ? new Date() : null;

  await withTenant(opts.tenantId, async (tx) => {
    await tx.update(deals)
      .set({ stageId: opts.newStageId, closedAt, updatedAt: new Date() })
      .where(eq(deals.id, opts.dealId));
  });

  await logActivity({
    tenantId: opts.tenantId,
    contactId: deal.contactId,
    dealId: opts.dealId,
    userId: opts.userId,
    masterAgentId: opts.masterAgentId,
    type: 'stage_change',
    title: `Deal moved from ${oldStage?.name ?? 'unknown'} to ${newStage?.name ?? 'unknown'}`,
    metadata: {
      oldStageId: deal.stageId,
      newStageId: opts.newStageId,
      oldStageName: oldStage?.name,
      newStageName: newStage?.name,
    },
  });
}

/**
 * Find a stage by slug for a tenant.
 */
export async function findStageBySlug(tenantId: string, slug: string): Promise<CrmStage | undefined> {
  await seedDefaultStages(tenantId);
  const [stage] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(crmStages)
      .where(and(eq(crmStages.tenantId, tenantId), eq(crmStages.slug, slug)))
      .limit(1);
  });
  return stage;
}
