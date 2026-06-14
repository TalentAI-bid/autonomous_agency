import { COPILOT_INTENTS } from './intent-reply-strategies.js';

/**
 * Classifier prompt that takes the last few turns of a LinkedIn DM
 * conversation and returns both:
 *   1. intent — one of 12 categories (drives reply strategy selection)
 *   2. signals — short arrays of literal phrases from the recipient's
 *      messages (drives the LAYER 1 context block of reply generation)
 *
 * Signal extraction is inlined here so we don't need a separate Kimi call.
 * The arrays MUST quote things literally present in the conversation —
 * the prompt forbids fabrication and tells the model to return [] when a
 * category has nothing.
 */

export const CLASSIFIER_SYSTEM_PROMPT = `You classify the intent of an inbound LinkedIn DM AND extract literal signals from the recipient's messages.

═══════════════════════════════════════════════════════
INTENT — pick exactly ONE
═══════════════════════════════════════════════════════
${COPILOT_INTENTS.map((i) => `- ${i}`).join('\n')}

Rules:
- The conversation history is provided; focus on the LAST inbound message but use earlier context for disambiguation.
- "interested_qualifying" = they're curious or asking general questions ("tell me more", "interesting").
- "meeting_request" = explicit ask for a call / meeting / time slot.
- "pricing_inquiry" = neutral question about pricing or model.
- "objection_*" = pushback. Pick the specific dimension being objected to.
- "info_request" = asking for a specific artifact (brochure, case study, link).
- "polite_decline" = "not interested" / "not a fit" / soft no.
- "hostile" = unsubscribe demands, accusations, anger.
- "casual_chat" = small talk, off-topic friendliness.
- "competitor_intel" = asking how you compare to specific named competitors.

═══════════════════════════════════════════════════════
SIGNALS — extract from the recipient's messages only
═══════════════════════════════════════════════════════
Only quote things literally present in the recipient's messages. NEVER invent. If a category has nothing literal, return [].

- topics_discussed: short topic labels surfaced in the conversation (e.g. "pricing", "DevOps hiring", "AI screening").
- recipient_unanswered_questions: questions THEY asked that haven't been addressed yet.
- sender_unanswered_questions: questions WE (outbound) asked that they haven't answered.
- expressed_interests: positive signals (interest, curiosity, agreement).
- expressed_concerns: objections, hesitations, worries.
- expressed_constraints: budget / timing / authority / scope limits they mentioned.

Keep each array entry short — a phrase, not a paragraph. Cap at ~5 entries per array.

═══════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════
Return ONLY JSON:
{
  "intent": "<one_of_the_above>",
  "confidence": <integer 0-100>,
  "reasoning": "<one sentence>",
  "key_signal": "<short phrase from their message that drove the classification>",
  "topics_discussed": [],
  "recipient_unanswered_questions": [],
  "sender_unanswered_questions": [],
  "expressed_interests": [],
  "expressed_concerns": [],
  "expressed_constraints": []
}
Do not include any other fields.`;

export function buildClassifierUserPrompt(opts: {
  conversationHistory: Array<{ direction: string; body: string; sentAt: string }>;
  recipientName: string;
}): string {
  const lastTurns = opts.conversationHistory.slice(-6);
  const formatted = lastTurns
    .map((m) => `[${m.direction === 'outbound' ? 'YOU' : opts.recipientName}] (${m.sentAt}): ${m.body}`)
    .join('\n\n');
  return `Conversation (oldest first):\n\n${formatted}\n\nClassify the LAST inbound message's intent AND extract literal signals from the recipient's messages. Return ONLY the JSON described in OUTPUT FORMAT.`;
}
