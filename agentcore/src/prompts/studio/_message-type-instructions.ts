// Per-message-type prompt fragment. Injected into every channel prompt
// after the channel-specific HARD CONSTRAINTS block so the model knows
// whether it's writing initial cold outreach or a bump or a post-meeting
// recap. Each fragment ends with explicit FORBIDDEN phrases that the
// FORBIDDEN array in cold-email-drafter.service.ts does NOT cover (those
// are channel-agnostic; these are message-type-specific).

export const MESSAGE_TYPES = [
  'first_message',
  'first_followup',
  'second_followup',
  'breakup',
  'reactivation',
  'post_meeting',
  'post_no_show',
] as const;

export type MessageType = typeof MESSAGE_TYPES[number];

export function isMessageType(v: unknown): v is MessageType {
  return typeof v === 'string' && (MESSAGE_TYPES as readonly string[]).includes(v);
}

export const MESSAGE_TYPE_INSTRUCTIONS: Record<MessageType, string> = {
  first_message: `
MESSAGE TYPE: first_message — FIRST CONTACT, they've never heard from you.
REQUIREMENTS:
- Strong hook in first line (specific observation, shared context, or question)
- Establish credibility briefly
- Single low-friction CTA
- Voice: confident, warm, specific
- DO NOT reference any previous conversation
`.trim(),

  first_followup: `
MESSAGE TYPE: first_followup — you sent a first message, no reply yet.
REQUIREMENTS:
- Reference previous message briefly ("Following up on my note last week")
- DO NOT apologize ("Sorry to bother you" is FORBIDDEN)
- Add new value or angle (don't just repeat)
- SHORTER than the first message
- Voice: slightly more informal

FORBIDDEN PHRASES:
- "Sorry to bother you"
- "I know you're busy"
- "Just following up to see if..."
- Any apologetic framing
`.trim(),

  second_followup: `
MESSAGE TYPE: second_followup — two messages unanswered already.
REQUIREMENTS:
- Try a DIFFERENT angle than the first two messages
- Lead with value or insight, not another ask
- Be more direct about what you want
- Even shorter than first followup

GOOD OPENERS:
- "One more thought —"
- "Different angle:"
- "Last time on this —"

FORBIDDEN PHRASES:
- "Just checking in again"
- "Wanted to make sure you saw"
- Guilt-tripping language
`.trim(),

  breakup: `
MESSAGE TYPE: breakup — final attempt before going silent.
REQUIREMENTS:
- Acknowledge you're going to stop reaching out
- Leave the door open warmly
- Brief — under 50 words
- Voice: warm, low-pressure, no neediness

GOOD PATTERNS:
- "Going to stop reaching out — if [thing] becomes a priority, you know where to find me."
- "Closing the loop on this. Door's always open if [X] changes."

FORBIDDEN PHRASES:
- "I'm assuming you're not interested" (passive-aggressive)
- "If I don't hear back I'll close your file"
- Any guilt or pressure
`.trim(),

  reactivation: `
MESSAGE TYPE: reactivation — they went silent 30-60+ days ago. Re-engaging now.
REQUIREMENTS:
- Have a SPECIFIC reason to reach out now
- Reference something new (their company change, market shift, your new offering)
- No apology for the silence
- Treat them like a known contact, not a cold lead

GOOD OPENERS:
- "Saw [specific recent thing] and thought of you."
- "Quick update — we [new thing]. Thought it might be relevant given [their context]."

FORBIDDEN PHRASES:
- "It's been a while"
- "Hope you're doing well" (without specific context)
- "Just wanted to circle back"
`.trim(),

  post_meeting: `
MESSAGE TYPE: post_meeting — you just had a call/meeting.
REQUIREMENTS:
- Quick genuine thank-you (brief)
- Recap ONE key takeaway or decision
- Clear next step with timing
- Include any promised deliverables
- Voice: warm, action-oriented

STRUCTURE:
1. Thank-you (one line)
2. "One thing that stood out:" + insight
3. "Next: [specific action with deadline]"
4. Sign-off

REQUIRES customContext describing what was discussed. The studio service rejects empty customContext for this message type — if you see no context, the caller forgot. Output an empty body and the service will surface the error.
`.trim(),

  post_no_show: `
MESSAGE TYPE: post_no_show — they missed a scheduled meeting.
REQUIREMENTS:
- Assume good faith (no accusation)
- Offer easy reschedule
- Don't make them apologize
- Short, warm, no guilt

GOOD PATTERNS:
- "Must have crossed wires today. Want to find another time?"
- "Looks like our calendars didn't quite work out. Easy to find another slot?"

FORBIDDEN PHRASES:
- "I waited for 15 minutes" (passive-aggressive)
- "I noticed you didn't make it" (accusatory)
- "Hoping everything is OK" (overly dramatic)
`.trim(),
};
