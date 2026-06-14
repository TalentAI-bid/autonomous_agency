// Cold-email drafter — first-touch only. Routes through Bedrock's OpenAI-
// compatible endpoint using the model in env.BEDROCK_EMAIL_MODEL (default
// `moonshotai.kimi-k2.5`). Temperature is intentionally high (0.8 default)
// so hooks vary across prospects rather than producing the templated
// "I noticed X is hiring..." output that prompted this rewrite.
//
// v4 returns a `ColdEmailResult` discriminated by `track`. SKIP is a value,
// not an exception — callers branch on `result.track` rather than catching
// a typed error. See the prompt's OUTPUT FORMAT section for the four
// possible JSON shapes the model emits.
//
// Follow-up touches (sequence step 2/3) are NOT cold and continue to use
// SMART_MODEL via followup-content.service.ts.

import { env } from '../config/env.js';
import { extractJSON, type ChatMessage } from '../tools/together-ai.tool.js';
import {
  COLD_EMAIL_SYSTEM_PROMPT,
  COLD_EMAIL_USER_PROMPT_TEMPLATE,
  type ColdEmailContext,
} from '../prompts/cold-email-drafting.prompt.js';
import logger from '../utils/logger.js';

export type ColdEmailTrack =
  | 'NORMAL_OUTREACH'
  | 'PARTNERSHIP_OUTREACH'
  | 'COLLABORATION_OUTREACH'
  | 'SKIP';

export type ColdEmailClassification =
  | 'POTENTIAL_BUYER'
  | 'DIRECT_COMPETITOR'
  | 'ADJACENT_PARTNER'
  | 'WRONG_FIT';

interface ColdEmailRaw {
  track?: ColdEmailTrack;
  classification?: ColdEmailClassification;

  // Present on NORMAL/PARTNERSHIP/COLLABORATION tracks
  subject?: string;
  body?: string;

  // NORMAL_OUTREACH only
  pattern_used?: 'A' | 'B' | 'C' | 'D';
  hook_source?: string;
  differentiator?: string;

  // PARTNERSHIP_OUTREACH only
  partnership_angle?: string;
  proposed_exchange?: string;

  // COLLABORATION_OUTREACH only
  collaboration_angle?: string;

  // SKIP
  skip?: boolean;
  skip_reason?: string;
}

export interface ColdEmailResult {
  track: ColdEmailTrack;
  classification: ColdEmailClassification;

  // Present unless track === 'SKIP'.
  subject: string;
  body: string;

  // NORMAL_OUTREACH
  patternUsed?: string;
  hookSource?: string;
  differentiator?: string;

  // PARTNERSHIP_OUTREACH
  partnershipAngle?: string;
  proposedExchange?: string;

  // COLLABORATION_OUTREACH
  collaborationAngle?: string;

  // SKIP
  skipReason?: string;

  meta: {
    needsReview?: boolean;
    model: string;
    temperature: number;
  };
}

// Mixed substring + regex list. Strings catch literal phrases the model
// repeats; regex catches generative templates ("Given X's focus on..."
// where X varies). Any hit in subject+body rejects the draft and triggers
// one retry. Only applied to non-SKIP tracks since SKIP has empty body.
export const FORBIDDEN: ReadonlyArray<string | RegExp> = [
  // Literal phrases — substring match
  'i noticed',
  'given the critical nature',
  'we specialize in',
  'ai-driven',
  'would you be open to',
  'schedule a 15-minute',
  "i'd love to discuss",
  'blockchain-verified',
  'pre-vetted',
  'reduce time-to-hire',
  "hope you're well",
  'best regards',
  'looking forward to your response',
  'synergy',
  'leverage',
  'streamline',
  'your platform requires',
  'as a leader in',
  "your team's focus on",
  // Generative templates — regex
  /given\s+\w+'s\s+(focus|emphasis|commitment)/i,
  /as\s+a\s+\w+\s+(company|platform|leader)/i,
];

export function findForbidden(text: string): string | null {
  const lower = text.toLowerCase();
  for (const f of FORBIDDEN) {
    if (typeof f === 'string') {
      if (lower.includes(f)) return f;
    } else {
      const m = text.match(f);
      if (m) return m[0];
    }
  }
  return null;
}

// Role-context signal for Rules 8 + 9 (anti-upsell-against-junior, no-uneconomic-anchor).
// Both flags are derived from the caller's `company.openRoles` array if present;
// when the array is missing/empty the flags are omitted entirely so the model
// falls back to the generic engineering pitch.
const JUNIOR_RX = /\b(junior|jr\.?|intern|graduate|grad|apprentice|trainee|entry[\s-]?level)\b/i;
const SENIOR_RX = /\b(senior|sr\.?|staff|principal|lead|architect|head|director|vp|chief|cto|cfo|coo|cmo)\b/i;

function deriveRoleContext(
  company: unknown,
): { has_junior_only_visible_roles?: boolean; has_senior_roles?: boolean } {
  const roles = (company as { openRoles?: Array<{ title?: string }> } | undefined)?.openRoles;
  if (!roles || roles.length === 0) return {};
  const hasJunior = roles.some((r) => r.title && JUNIOR_RX.test(r.title));
  const hasSenior = roles.some((r) => r.title && SENIOR_RX.test(r.title));
  return {
    has_junior_only_visible_roles: hasJunior && !hasSenior,
    has_senior_roles: hasSenior,
  };
}

function isAccessDenied(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(403|AccessDenied|access denied|not authorized)\b/i.test(msg);
}

async function callKimi(
  tenantId: string,
  messages: ChatMessage[],
): Promise<ColdEmailRaw> {
  try {
    return await extractJSON<ColdEmailRaw>(tenantId, messages, 2, {
      model: env.BEDROCK_EMAIL_MODEL,
      temperature: env.BEDROCK_EMAIL_TEMPERATURE,
      max_tokens: 600,
    });
  } catch (err) {
    if (isAccessDenied(err)) {
      throw new Error(
        `Cold-email model not accessible. Enable "${env.BEDROCK_EMAIL_MODEL}" in AWS Bedrock Model Access (AWS Console → Bedrock → Model access) for region "${env.AWS_BEDROCK_REGION}".`,
      );
    }
    throw err;
  }
}

// The model may emit only `skip:true` without `track:'SKIP'` (legacy v2/v3
// shape) or only `track:'SKIP'` (v4). Treat either as SKIP.
function isSkipRaw(raw: ColdEmailRaw): boolean {
  return raw.skip === true || raw.track === 'SKIP';
}

// Defensive: if classification missing, derive from track.
function deriveClassification(raw: ColdEmailRaw): ColdEmailClassification {
  if (raw.classification) return raw.classification;
  switch (raw.track) {
    case 'PARTNERSHIP_OUTREACH': return 'DIRECT_COMPETITOR';
    case 'COLLABORATION_OUTREACH': return 'ADJACENT_PARTNER';
    case 'SKIP': return 'WRONG_FIT';
    default: return 'POTENTIAL_BUYER';
  }
}

/**
 * Generate a cold-email draft for a specific prospect. The caller is
 * responsible for HTML-stripping the body (the manual draft route already
 * does this at routes/contact.routes.ts).
 *
 * Returns a ColdEmailResult on every classification — SKIP is a value, not
 * an exception. Throws only on actual errors (API failure, persistent
 * non-JSON output).
 */
export async function draftColdEmail(
  tenantId: string,
  ctx: ColdEmailContext,
  opts: { hint?: string } = {},
): Promise<ColdEmailResult> {
  // Enrich the company payload with derived role flags (Rules 8 + 9) without
  // mutating the caller's input. Caller controls `openRoles`; we layer the
  // booleans on top so the LLM sees them alongside the source data.
  const enrichedCtx: ColdEmailContext = {
    ...ctx,
    company: { ...(ctx.company as object), ...deriveRoleContext(ctx.company) },
  };
  const userPrompt = opts.hint
    ? `${COLD_EMAIL_USER_PROMPT_TEMPLATE(enrichedCtx)}\n\nADDITIONAL USER HINT: ${opts.hint}`
    : COLD_EMAIL_USER_PROMPT_TEMPLATE(enrichedCtx);

  const messages: ChatMessage[] = [
    { role: 'system', content: COLD_EMAIL_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  // First attempt.
  let raw = await callKimi(tenantId, messages);

  // SKIP path: return immediately as a value, no forbidden-phrase scan
  // (body is empty).
  if (isSkipRaw(raw)) {
    const reason = (raw.skip_reason || 'No reason provided').trim();
    logger.info({ tenantId, reason }, 'cold_email_skipped');
    return buildSkipResult(reason);
  }

  let subject = (raw.subject ?? '').trim();
  let body = (raw.body ?? '').trim();

  let needsReview = false;
  let hit = findForbidden(`${subject}\n${body}`);

  if (hit) {
    logger.warn(
      { tenantId, forbiddenPhrase: hit, subject: subject.slice(0, 80) },
      'cold_email_forbidden_phrase: regenerating once',
    );
    // Retry once with an explicit correction in the conversation. We pass
    // the offending assistant turn back so the model sees what it produced.
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: JSON.stringify(raw) },
      {
        role: 'user',
        content: `Your previous draft tripped a forbidden pattern: "${hit}". Rewrite the email without that phrase or anything matching the same template (see HARD RULES). Return ONLY the JSON object.`,
      },
    ];
    raw = await callKimi(tenantId, retryMessages);

    // Regenerated draft is also allowed to skip.
    if (isSkipRaw(raw)) {
      const reason = (raw.skip_reason || 'No reason provided').trim();
      logger.info({ tenantId, reason }, 'cold_email_skipped (on retry)');
      return buildSkipResult(reason);
    }

    subject = (raw.subject ?? '').trim();
    body = (raw.body ?? '').trim();
    hit = findForbidden(`${subject}\n${body}`);
    if (hit) {
      needsReview = true;
      logger.warn(
        { tenantId, forbiddenPhrase: hit, subject: subject.slice(0, 80) },
        'cold_email_forbidden_phrase_after_retry: returning with needsReview flag',
      );
    }
  }

  // Default track when the model omits it (legacy v2/v3 shape).
  const track: Exclude<ColdEmailTrack, 'SKIP'> =
    raw.track === 'PARTNERSHIP_OUTREACH' || raw.track === 'COLLABORATION_OUTREACH'
      ? raw.track
      : 'NORMAL_OUTREACH';
  const classification = deriveClassification(raw);

  return {
    track,
    classification,
    subject,
    body,
    patternUsed: raw.pattern_used,
    hookSource: raw.hook_source,
    differentiator: raw.differentiator,
    partnershipAngle: raw.partnership_angle,
    proposedExchange: raw.proposed_exchange,
    collaborationAngle: raw.collaboration_angle,
    meta: {
      needsReview: needsReview || undefined,
      model: env.BEDROCK_EMAIL_MODEL,
      temperature: env.BEDROCK_EMAIL_TEMPERATURE,
    },
  };
}

function buildSkipResult(reason: string): ColdEmailResult {
  return {
    track: 'SKIP',
    classification: 'WRONG_FIT',
    subject: '',
    body: '',
    skipReason: reason,
    meta: {
      model: env.BEDROCK_EMAIL_MODEL,
      temperature: env.BEDROCK_EMAIL_TEMPERATURE,
    },
  };
}
