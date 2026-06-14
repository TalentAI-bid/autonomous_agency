import { eq, and, asc } from 'drizzle-orm';
import { db } from '../config/database.js';
import { crmStages } from '../db/schema/index.js';
import { extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import logger from '../utils/logger.js';

/**
 * AI classification of user-defined CRM stages for the follow-up engine.
 *
 * Pipeline stages are free-form per tenant ("Connection Sent", "Ghosted",
 * "Demo Done", …) so we cannot hardcode which ones warrant follow-up nudges.
 * One LLM call classifies ALL of a tenant's stages at once from their names,
 * order and won/lost markers.
 *
 * Rules:
 *  - A user edit (follow_up_classified_by = 'user') is permanent — the
 *    classifier never overwrites it.
 *  - isWon / isLost stages are forced ineligible regardless of the LLM.
 *  - On LLM failure we log and leave flags untouched (default false =
 *    no follow-ups). Fail-safe, never fabricate.
 */

interface StageClassification {
  stages: Array<{ slug: string; followUpEligible: boolean }>;
}

const SYSTEM_PROMPT = `You classify CRM pipeline stages for an outbound-sales follow-up engine.

A stage is FOLLOW-UP ELIGIBLE when a lead sitting in it is waiting on OUR side to nudge them again — we made a move and they have not responded yet. Examples: "Contacted", "Connection Sent", "Message Sent", "Awaiting Response", "Proposal Sent", "No Reply".

A stage is NOT eligible when:
- the lead already responded and the ball is in an active conversation or later funnel step ("Replied", "In Discussion", "Meeting Booked", "Negotiation");
- it is terminal ("Won", "Lost", "Closed", "Dead", "Do Not Contact");
- the lead has not been touched at all yet ("Lead", "New", "To Contact", "Backlog") — there is nothing to follow up on.

Respond with JSON only:
{"stages":[{"slug":"<slug>","followUpEligible":true|false}]}
Include EVERY stage you were given, exactly once, by slug.`;

export async function classifyStagesForTenant(tenantId: string): Promise<void> {
  const stages = await db
    .select({
      id: crmStages.id,
      name: crmStages.name,
      slug: crmStages.slug,
      position: crmStages.position,
      isWon: crmStages.isWon,
      isLost: crmStages.isLost,
      classifiedBy: crmStages.followUpClassifiedBy,
    })
    .from(crmStages)
    .where(eq(crmStages.tenantId, tenantId))
    .orderBy(asc(crmStages.position));

  if (stages.length === 0) return;

  const stageList = stages
    .map((s) => `- slug: ${s.slug} | name: "${s.name}" | position: ${s.position}${s.isWon ? ' | WON' : ''}${s.isLost ? ' | LOST' : ''}`)
    .join('\n');

  let result: StageClassification;
  try {
    result = await extractJSON<StageClassification>(
      tenantId,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Pipeline stages (in funnel order):\n${stageList}` },
      ],
      2,
      { model: SMART_MODEL, temperature: 0.1 },
    );
  } catch (err) {
    logger.warn({ err, tenantId }, 'stage-classifier: LLM classification failed — leaving flags untouched');
    return;
  }

  const bySlug = new Map<string, boolean>();
  for (const s of result.stages ?? []) {
    if (typeof s?.slug === 'string' && typeof s?.followUpEligible === 'boolean') {
      bySlug.set(s.slug, s.followUpEligible);
    }
  }

  for (const stage of stages) {
    if (stage.classifiedBy === 'user') continue; // user override is permanent
    const llmFlag = bySlug.get(stage.slug);
    if (llmFlag === undefined) continue;
    const eligible = stage.isWon || stage.isLost ? false : llmFlag;
    await db
      .update(crmStages)
      .set({ followUpEligible: eligible, followUpClassifiedBy: 'ai', updatedAt: new Date() })
      .where(and(eq(crmStages.id, stage.id), eq(crmStages.tenantId, tenantId)));
  }

  logger.info(
    {
      tenantId,
      eligible: stages.filter((s) => s.classifiedBy !== 'user' && bySlug.get(s.slug) && !s.isWon && !s.isLost).map((s) => s.slug),
    },
    'stage-classifier: stages classified',
  );
}

/**
 * Fire-and-forget wrapper for stage create/rename hooks — classification must
 * never add latency or failures to stage CRUD.
 */
export function classifyStagesInBackground(tenantId: string): void {
  classifyStagesForTenant(tenantId).catch((err) =>
    logger.warn({ err, tenantId }, 'stage-classifier: background classification failed'),
  );
}
