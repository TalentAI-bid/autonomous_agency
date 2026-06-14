import type { MessagingConfig } from '../../db/schema/tenants.js';
import type { ExtractedContext } from './extracted-context.js';

export type CopilotMode =
  | 'generate_from_scratch'
  | 'improve_existing'
  | 'make_shorter'
  | 'make_more_direct'
  | 'different_angle';

export const COPILOT_MODES: ReadonlyArray<CopilotMode> = [
  'generate_from_scratch',
  'improve_existing',
  'make_shorter',
  'make_more_direct',
  'different_angle',
];

export function isCopilotMode(v: unknown): v is CopilotMode {
  return typeof v === 'string' && (COPILOT_MODES as readonly string[]).includes(v);
}

export interface ReplyPromptInput {
  conversationHistory: Array<{ direction: string; body: string; sentAt: string }>;
  recipientName: string;
  recipientCompany?: string;
  recipientTitle?: string;
  intent: string;
  strategy: string;
  tenantConfig: MessagingConfig;
  mode: CopilotMode;
  existingDraft?: string;
  extractedContext: ExtractedContext;
}

export interface FollowupPromptInput {
  conversationHistory: Array<{ direction: string; body: string; sentAt: string }>;
  recipientName: string;
  recipientCompany?: string;
  recipientTitle?: string;
  tenantConfig: MessagingConfig;
  /**
   * Studio message-type tag — picks which forbidden-phrase list + voice
   * notes apply. Typically 'first_followup' (1 outbound so far) or
   * 'second_followup' (2+ outbound), but callers may pass other Studio
   * types if they want (breakup, reactivation).
   */
  messageType: string;
  /** The matching MESSAGE_TYPE_INSTRUCTIONS block from the Studio prompt fragment. */
  messageTypeInstructions: string;
  extractedContext: ExtractedContext;
}

/**
 * System prompt for the Inbox Copilot reply / follow-up generator.
 *
 * The prompt is structured around two layers:
 *   LAYER 1 (in the user prompt) = WHAT YOU KNOW ABOUT THE RECIPIENT.
 *   LAYER 2 (in the user prompt) = WHAT YOU CAN CLAIM ABOUT THE SENDER.
 *
 * ABSOLUTE RULE 0 below makes fabrication structurally impossible:
 * specific claims about the sender can only come from messaging_config.
 * verified_facts; anything else must be rephrased qualitatively.
 *
 * See feedback_fail_loud_over_fabricate memory.
 */
export const REPLY_SYSTEM_PROMPT = `You are drafting a LinkedIn DM on behalf of the user. This is either a reply in an ongoing conversation or a follow-up bump — the user prompt will tell you which.

═══════════════════════════════════════════════════════
ABSOLUTE RULE 0 — NO FABRICATION
═══════════════════════════════════════════════════════
You may NOT invent specific facts about the sender or their company. This includes (but is not limited to):
- Specific past clients ("we placed for a Series B SaaS...")
- Specific metrics ("90% faster", "23 days time-to-fill", "47 engineers placed")
- Specific timelines ("closed in 11 days")
- Specific competitor comparisons
- Local references implying you have local clients ("here in Vilnius we just...")
- Any past-tense claim about your own performance NOT in VERIFIED FACTS

If a specific claim would strengthen the message but is NOT in VERIFIED FACTS, rephrase qualitatively. Examples:

  INSTEAD OF: "We placed a DevOps engineer in 11 days for a Vilnius fintech"
  USE:        "DevOps placements are exactly where our model fits"
  OR:         "If you have a DevOps role open over 30 days, that's our sweet spot"

  INSTEAD OF: "We cut screening time 90%"
  USE:        "AI-powered screening removes most of the manual sourcing work"

  INSTEAD OF: "We work with companies like X, Y, Z"
  USE:        "We focus on [target ICP]"

Facts about the RECIPIENT (their company, title, what they said, what their LinkedIn profile shows) are fine — those come from the conversation and the database, not your imagination.

═══════════════════════════════════════════════════════
HARD RULES
═══════════════════════════════════════════════════════
1. Match the conversational tone — they set the energy, you match it.
2. Reference specifics from THEIR last message (when this is a reply).
3. Keep LinkedIn-DM appropriate (30-80 words usually, can be shorter).
4. NO formal email language ("Dear", "Best regards", "Kind regards").
5. NO apologies for following up.
6. Single CTA maximum — don't ask multiple things.
7. If they were brief, you should be brief too.
8. If they shared something personal, acknowledge it briefly before business.

═══════════════════════════════════════════════════════
FORBIDDEN PHRASES (auto-reject if present)
═══════════════════════════════════════════════════════
- "Hope this finds you well"
- "I appreciate you taking the time"
- "Thank you for your interest"
- "I wanted to follow up"
- "Just circling back"
- "As discussed earlier"
- "Per my last message"
- Any "Given X's focus on..." patterns
- Any "As a [industry] company..." patterns

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return ONLY JSON:
{
  "body": "...",
  "intent_detected": "...",
  "strategy_used": "...",
  "confidence": <int 0-100>,
  "alternative_short_version": "...optional, only if main draft is over 60 words...",
  "used_verified_facts": ["...exact strings from VERIFIED FACTS that you actually used (empty array if none)..."],
  "qualitative_claims_used": ["...capability/positioning claims you made without specific numbers (empty array if none)..."]
}`;

function formatList(items: string[], emptyText: string): string {
  if (!items || items.length === 0) return emptyText;
  return items.join('; ');
}

function formatVerifiedFacts(facts: string[] | undefined): string {
  if (!facts || facts.length === 0) {
    return '  (no verified facts configured — use ONLY qualitative claims about capabilities)';
  }
  return facts.map((f) => `  ✓ ${f}`).join('\n');
}

function formatMeetings(
  meetings: ExtractedContext['prior_meeting_history'],
): string {
  if (!meetings || meetings.length === 0) return 'none';
  return meetings.map((m) => `${m.scheduled_at} (${m.status})`).join('; ');
}

function formatCompanyTriple(intel: ExtractedContext['company_intel']): string {
  const parts = [intel.industry, intel.size, intel.funding].map((v) => v ?? 'unknown');
  return parts.join(' / ');
}

function buildModeBlock(mode: CopilotMode, existingDraft: string | undefined): string {
  const draft = (existingDraft ?? '').trim();
  switch (mode) {
    case 'generate_from_scratch':
      return `═══════════════════════════════════════════════════════
MODE: GENERATE FROM SCRATCH
═══════════════════════════════════════════════════════
The user has not written anything yet. Generate a complete reply from scratch based on the conversation context and the intent strategy above.`;

    case 'improve_existing':
      return `═══════════════════════════════════════════════════════
MODE: IMPROVE EXISTING DRAFT
═══════════════════════════════════════════════════════
The user already wrote a draft. Your job is to IMPROVE it while preserving their intent and core message.

USER'S DRAFT (what they wrote):
"""
${draft}
"""

REQUIREMENTS:
- Keep the user's core meaning and intent.
- Improve clarity, tone, and impact.
- Remove any forbidden phrases.
- Apply the intent strategy if it improves the response.
- Don't make it longer unless necessary.
- Preserve the user's voice — don't make it sound like a different person.

If the user's draft is already good, return it with minimal changes. If the user's draft is off-topic or hostile, gently guide it back while preserving as much of their language as possible.`;

    case 'make_shorter':
      return `═══════════════════════════════════════════════════════
MODE: MAKE SHORTER
═══════════════════════════════════════════════════════
The user has a draft they think is too long. Make it shorter while keeping the essential message.

USER'S DRAFT:
"""
${draft}
"""

REQUIREMENTS:
- Cut at least 30% of the words.
- Keep the core point intact.
- Make it punchier and more direct.
- Same intent, fewer words.`;

    case 'make_more_direct':
      return `═══════════════════════════════════════════════════════
MODE: MAKE MORE DIRECT
═══════════════════════════════════════════════════════
The user has a draft that feels too soft or hedging. Make it more direct and confident.

USER'S DRAFT:
"""
${draft}
"""

REQUIREMENTS:
- Remove hedging language ("perhaps", "maybe", "I was wondering if").
- Lead with the point.
- Use stronger verbs.
- Keep it polite but assertive.
- Same intent, more confident voice.`;

    case 'different_angle':
      return `═══════════════════════════════════════════════════════
MODE: DIFFERENT ANGLE
═══════════════════════════════════════════════════════
The user has a draft but wants a different approach to the same goal.

USER'S DRAFT (don't repeat this approach):
"""
${draft}
"""

REQUIREMENTS:
- Address the same situation but from a different angle.
- If their draft was direct, try indirect (or vice versa).
- If their draft led with a question, try leading with insight.
- Apply the intent strategy fresh.
- Don't just rephrase — actually try a different approach.`;
  }
}

function buildLayer1Block(
  input: { recipientName: string; recipientTitle?: string; recipientCompany?: string },
  ctx: ExtractedContext,
  opts: { includeSignals: boolean },
): string {
  const lastInbound =
    ctx.days_since_last_inbound === null ? 'never replied' : `${ctx.days_since_last_inbound}`;

  const signalBlock = opts.includeSignals
    ? `
What they care about (extracted from their messages):
- Interests expressed: ${formatList(ctx.expressed_interests, 'none yet')}
- Concerns / objections: ${formatList(ctx.expressed_concerns, 'none expressed')}
- Constraints mentioned: ${formatList(ctx.expressed_constraints, 'none mentioned')}

Open conversational threads:
- THEIR questions we haven't answered: ${formatList(ctx.recipient_unanswered_questions, 'none')}
- OUR questions they haven't answered: ${formatList(ctx.sender_unanswered_questions, 'none')}
`
    : '';

  return `═══════════════════════════════════════════════════════
LAYER 1: WHAT YOU KNOW ABOUT THE RECIPIENT (drives HOW you write)
═══════════════════════════════════════════════════════

Recipient: ${input.recipientName}
Title: ${input.recipientTitle || 'unknown'}
Company: ${input.recipientCompany || 'unknown'}

Their communication style:
- Tone: ${ctx.recipient_tone}
- Average message length: ${ctx.recipient_avg_message_length_words} words
- Response speed: ${ctx.recipient_response_speed}

Relationship state:
- First interaction: ${ctx.is_first_interaction ? 'yes' : 'no'}
- Days since first message: ${ctx.days_since_first_message}
- Days since their last reply: ${lastInbound}
- Total exchanges: ${ctx.total_exchanges}
${signalBlock}
Database context:
- Source: ${ctx.source ?? 'unknown'}
- Prior notes: ${ctx.prior_notes ?? 'none'}
- Prior outreach attempts: ${ctx.prior_outreach_attempts}
- Prior meetings: ${formatMeetings(ctx.prior_meeting_history)}
- Company industry / size / funding: ${formatCompanyTriple(ctx.company_intel)}
- Company description: ${ctx.company_intel.description ?? 'unknown'}
- Company pain points: ${formatList(ctx.company_intel.pain_points, 'none')}
- Recent company news: ${ctx.company_intel.recent_news ?? 'none'}`;
}

function buildLayer2Block(cfg: MessagingConfig): string {
  return `═══════════════════════════════════════════════════════
LAYER 2: WHAT YOU CAN CLAIM ABOUT THE SENDER (hard whitelist)
═══════════════════════════════════════════════════════

Sender: ${cfg.sender_name ?? '(unspecified)'} (${cfg.sender_title ?? 'unspecified title'})
Company: ${cfg.sender_company ?? '(unspecified)'}
Location: ${cfg.sender_location ?? '(unspecified)'}

Value proposition: ${cfg.value_prop ?? '(unspecified)'}
Differentiator: ${cfg.differentiator ?? '(unspecified)'}
Pricing: ${cfg.pricing_summary ?? '(unspecified)'}
Voice notes: ${cfg.brand_voice_notes ?? 'Founder-to-founder, direct, no corporate speak'}

VERIFIED FACTS (you may quote these near-verbatim — everything else specific must be qualitative per RULE 0):
${formatVerifiedFacts(cfg.verified_facts)}`;
}

function buildHistoryBlock(
  history: Array<{ direction: string; body: string; sentAt: string }>,
  recipientName: string,
): string {
  return `═══════════════════════════════════════════════════════
FULL CONVERSATION HISTORY (oldest first)
═══════════════════════════════════════════════════════
${history
    .map((m) => `[${m.direction === 'outbound' ? 'YOU' : recipientName}] (${m.sentAt}): ${m.body}`)
    .join('\n\n')}`;
}

export function buildReplyUserPrompt(input: ReplyPromptInput): string {
  const ctx = input.extractedContext;
  return `${buildLayer1Block(
    { recipientName: input.recipientName, recipientTitle: input.recipientTitle, recipientCompany: input.recipientCompany },
    ctx,
    { includeSignals: true },
  )}

${buildLayer2Block(input.tenantConfig)}

═══════════════════════════════════════════════════════
INTENT CLASSIFICATION: ${input.intent}
═══════════════════════════════════════════════════════

═══════════════════════════════════════════════════════
REPLY STRATEGY
═══════════════════════════════════════════════════════
${input.strategy}

${buildModeBlock(input.mode, input.existingDraft)}

${buildHistoryBlock(input.conversationHistory, input.recipientName)}

═══════════════════════════════════════════════════════
WRITING INSTRUCTIONS
═══════════════════════════════════════════════════════
1. Match their tone (${ctx.recipient_tone}).
2. Match their length roughly (their avg: ${ctx.recipient_avg_message_length_words} words).
3. If they asked a question that's unanswered, ADDRESS IT first.
4. Reference their specific situation — facts about THEM are fine.
5. Use ONLY verified facts about us; anything specific about our company or track record must come from the VERIFIED FACTS list.
6. Be qualitative where we lack verified specifics. Confidence comes from clarity, not invented numbers.

Return ONLY the JSON described in OUTPUT FORMAT.`;
}

export function buildFollowupUserPrompt(input: FollowupPromptInput): string {
  const ctx = input.extractedContext;
  return `${buildLayer1Block(
    { recipientName: input.recipientName, recipientTitle: input.recipientTitle, recipientCompany: input.recipientCompany },
    ctx,
    { includeSignals: false },
  )}

${buildLayer2Block(input.tenantConfig)}

═══════════════════════════════════════════════════════
SITUATION
═══════════════════════════════════════════════════════
The recipient HAS NOT replied to your last message. You are writing a FOLLOW-UP BUMP, NOT a reply.
- DO NOT start with "thanks for your reply" or anything that implies they responded.
- Reference your prior outbound message briefly (e.g. "Following up on my note last week").
- Add new value or a different angle — do not just repeat the previous message.
- Match the conversation's existing tone and language.

═══════════════════════════════════════════════════════
FOLLOW-UP TYPE: ${input.messageType}
═══════════════════════════════════════════════════════
${input.messageTypeInstructions}

${buildHistoryBlock(input.conversationHistory, input.recipientName)}

═══════════════════════════════════════════════════════
WRITING INSTRUCTIONS
═══════════════════════════════════════════════════════
1. Match their tone (${ctx.recipient_tone}).
2. Reference your prior outreach briefly — do not pretend they replied.
3. Use ONLY verified facts about us; anything specific about our company or track record must come from the VERIFIED FACTS list.
4. Be qualitative where we lack verified specifics. Confidence comes from clarity, not invented numbers.

Return ONLY the JSON described in OUTPUT FORMAT.`;
}
