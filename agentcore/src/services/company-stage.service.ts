import { eq, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies } from '../db/schema/index.js';
import type { CompanyStage } from '../db/schema/index.js';
import logger from '../utils/logger.js';

/**
 * Company-level stage tracking. Counterpart to prospect-stage.service.ts
 * but at the company grain (one company → many contacts → many touches).
 * Maintained alongside contact-level stages: every contact-level
 * recordTouch/recordResponse call also fires the company-level update
 * via the wrappers in prospect-stage.service.ts.
 *
 * Triage rules read exclusively from companies.{current_stage,
 * total_outbound_touches, last_touch_at, last_inbound_at, total_inbound_responses}.
 */

const TERMINAL: ReadonlySet<CompanyStage> = new Set(['closed_won', 'closed_lost', 'dnc']);

export type TouchChannel = 'email' | 'linkedin_dm' | 'linkedin_connect' | 'whatsapp' | 'phone';

/**
 * Record an outbound touch at the company level. Increments
 * total_outbound_touches + last_touch_at, and auto-promotes stage
 * 'new' → 'first_touch_sent' if applicable. Terminal stages (won/lost/
 * dnc) are never demoted.
 */
export async function recordCompanyTouch(args: {
  tenantId: string;
  companyId: string;
  channel: TouchChannel;
}): Promise<void> {
  const { tenantId, companyId } = args;
  const now = new Date();

  await withTenant(tenantId, async (tx) => {
    await tx
      .update(companies)
      .set({
        totalOutboundTouches: sql`${companies.totalOutboundTouches} + 1`,
        lastTouchAt: now,
        updatedAt: now,
        currentStage: sql`CASE
          WHEN ${companies.currentStage} = 'new' THEN 'first_touch_sent'
          ELSE ${companies.currentStage}
        END`,
        stageEnteredAt: sql`CASE
          WHEN ${companies.currentStage} = 'new' THEN ${now}
          ELSE ${companies.stageEnteredAt}
        END`,
      })
      .where(eq(companies.id, companyId));
  }).catch((err) => {
    logger.warn({ err, companyId }, 'recordCompanyTouch: update failed (non-fatal)');
  });
}

/**
 * Record an inbound response at the company level. Sets last_inbound_at,
 * increments total_inbound_responses, and promotes to 'engaged' unless
 * already in a stage at or beyond engaged (or terminal).
 */
export async function recordCompanyResponse(args: {
  tenantId: string;
  companyId: string;
}): Promise<void> {
  const { tenantId, companyId } = args;
  const now = new Date();

  await withTenant(tenantId, async (tx) => {
    await tx
      .update(companies)
      .set({
        totalInboundResponses: sql`${companies.totalInboundResponses} + 1`,
        lastInboundAt: now,
        updatedAt: now,
        currentStage: sql`CASE
          WHEN ${companies.currentStage} IN ('closed_won','closed_lost','dnc','engaged','qualified','meeting_scheduled','in_evaluation')
            THEN ${companies.currentStage}
          ELSE 'engaged'
        END`,
        stageEnteredAt: sql`CASE
          WHEN ${companies.currentStage} IN ('closed_won','closed_lost','dnc','engaged','qualified','meeting_scheduled','in_evaluation')
            THEN ${companies.stageEnteredAt}
          ELSE ${now}
        END`,
      })
      .where(eq(companies.id, companyId));
  }).catch((err) => {
    logger.warn({ err, companyId }, 'recordCompanyResponse: update failed (non-fatal)');
  });
}

/**
 * Force-transition a company's stage. Used for explicit user actions
 * (mark DNC, mark dead, etc.) and stage-change side effects from
 * higher-level operations (deal won/lost).
 */
export async function transitionCompanyStage(args: {
  tenantId: string;
  companyId: string;
  toStage: CompanyStage;
}): Promise<void> {
  const { tenantId, companyId, toStage } = args;
  const now = new Date();
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(companies)
      .set({ currentStage: toStage, stageEnteredAt: now, updatedAt: now })
      .where(eq(companies.id, companyId));
  });
}

export { TERMINAL as TERMINAL_COMPANY_STAGES };
