import { withTenant } from '../config/database.js';
import { agentActivityLog } from '../db/schema/index.js';
import logger from '../utils/logger.js';

/**
 * Subset of fields any "grounded" agent uses to source citations from.
 * Citation strings must appear (case-insensitively) inside this concatenated
 * input text or they are treated as hallucinations.
 */
export interface GroundedInput {
  name: string;
  description?: string | null;
  specialties?: string[] | null;
  rawMeta?: string[] | null;
  openPositions?: Array<{ title?: string | null; description?: string | null }> | null;
}

export interface GroundedPainPointOut {
  claim: string;
  citation: string | null;
}

export interface GroundedOutreachAngleOut {
  angle: string;
  citation: string | null;
}

export interface GroundedOutput {
  painPoints?: Array<GroundedPainPointOut | string> | null;
  outreachAngle?: GroundedOutreachAngleOut | string | null;
  techGapScore?: number | null;
  techGapScoreEvidence?: string | null;
}

export interface GroundedContext {
  tenantId: string;
  masterAgentId?: string | null;
  agentId?: string | null;
  companyId?: string | null;
  promptName: string;
}

interface DroppedField {
  field: 'painPoint' | 'outreachAngle' | 'techGapScore';
  claim: string;
  citation: string | null;
}

function buildInputCorpus(input: GroundedInput): string {
  const parts: string[] = [];
  if (input.description) parts.push(input.description);
  if (input.specialties?.length) parts.push(input.specialties.join(' '));
  if (input.rawMeta?.length) parts.push(input.rawMeta.join(' '));
  if (input.openPositions?.length) {
    for (const p of input.openPositions) {
      if (p?.title) parts.push(p.title);
      if (p?.description) parts.push(p.description);
    }
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * Filter out painPoints / outreachAngle / techGapScore values whose citation
 * is missing or not a substring of the scraped input text. Surviving fields
 * are returned in normalised structured form. Drops are logged at warn AND
 * persisted to agent_activity_log so we can audit prompt quality.
 *
 * The function never throws — a logging failure is swallowed so the caller
 * can still persist the cleaned output.
 */
export function validateGroundedFields(
  input: GroundedInput,
  outputRaw: GroundedOutput,
  context: GroundedContext,
): {
  painPoints: GroundedPainPointOut[];
  outreachAngle: GroundedOutreachAngleOut | null;
  techGapScore: number;
  techGapScoreEvidence: string | null;
} {
  const inputCorpus = buildInputCorpus(input);
  const dropped: DroppedField[] = [];

  // ─── painPoints ─────────────────────────────────────────────────────────
  const incomingPP = Array.isArray(outputRaw.painPoints) ? outputRaw.painPoints : [];
  const painPoints: GroundedPainPointOut[] = [];
  for (const ppRaw of incomingPP) {
    // Backwards compat: treat legacy `string` painPoints as { claim, citation: null }.
    const pp: GroundedPainPointOut = typeof ppRaw === 'string'
      ? { claim: ppRaw, citation: null }
      : { claim: ppRaw?.claim ?? '', citation: ppRaw?.citation ?? null };

    if (!pp.claim) continue;

    if (!pp.citation) {
      dropped.push({ field: 'painPoint', claim: pp.claim, citation: null });
      continue;
    }
    if (!inputCorpus.includes(pp.citation.toLowerCase())) {
      dropped.push({ field: 'painPoint', claim: pp.claim, citation: pp.citation });
      continue;
    }
    painPoints.push(pp);
  }

  // ─── outreachAngle ──────────────────────────────────────────────────────
  let outreachAngle: GroundedOutreachAngleOut | null = null;
  const angleIn = outputRaw.outreachAngle;
  if (angleIn && typeof angleIn === 'object' && 'angle' in angleIn) {
    const candidate = angleIn as GroundedOutreachAngleOut;
    if (!candidate.angle) {
      // Empty angle — drop silently.
    } else if (!candidate.citation || !inputCorpus.includes(candidate.citation.toLowerCase())) {
      dropped.push({ field: 'outreachAngle', claim: candidate.angle, citation: candidate.citation ?? null });
    } else {
      outreachAngle = candidate;
    }
  } else if (typeof angleIn === 'string' && angleIn.trim()) {
    // Legacy string outreachAngle — no citation, so drop.
    dropped.push({ field: 'outreachAngle', claim: angleIn, citation: null });
  }

  // ─── techGapScore ───────────────────────────────────────────────────────
  let techGapScore = Number.isFinite(outputRaw.techGapScore) ? Number(outputRaw.techGapScore) : 0;
  let techGapScoreEvidence = outputRaw.techGapScoreEvidence ?? null;
  if (painPoints.length === 0 && techGapScore > 0) {
    dropped.push({ field: 'techGapScore', claim: String(techGapScore), citation: techGapScoreEvidence });
    techGapScore = 0;
    techGapScoreEvidence = null;
  }

  // ─── Log drops ──────────────────────────────────────────────────────────
  if (dropped.length > 0) {
    logger.warn(
      { company: input.name, dropped, promptName: context.promptName, masterAgentId: context.masterAgentId, companyId: context.companyId },
      'Filtered hallucinated fields',
    );

    void persistDrops(context, input.name, dropped);
  }

  return { painPoints, outreachAngle, techGapScore, techGapScoreEvidence };
}

async function persistDrops(context: GroundedContext, companyName: string, dropped: DroppedField[]): Promise<void> {
  try {
    await withTenant(context.tenantId, async (tx) => {
      await tx.insert(agentActivityLog).values({
        tenantId: context.tenantId,
        masterAgentId: context.masterAgentId ?? null,
        agentType: 'enrichment',
        action: 'hallucination_filtered',
        status: 'completed',
        details: {
          companyId: context.companyId ?? null,
          companyName,
          promptName: context.promptName,
          dropped,
        },
      });
    });
  } catch (err) {
    logger.debug({ err }, 'grounded-validation: failed to write activity log (non-fatal)');
  }
}
