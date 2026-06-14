// Per-intent reply strategies for the Inbox Copilot. Each entry is a
// strategy paragraph the model receives alongside the conversation history
// when drafting a reply. Keep paragraphs tight — the model sees them as
// guidance, not boilerplate.

export const COPILOT_INTENTS = [
  'interested_qualifying',
  'meeting_request',
  'pricing_inquiry',
  'objection_price',
  'objection_timing',
  'objection_solution',
  'objection_authority',
  'info_request',
  'polite_decline',
  'hostile',
  'casual_chat',
  'competitor_intel',
] as const;

export type CopilotIntent = typeof COPILOT_INTENTS[number];

export function isCopilotIntent(v: unknown): v is CopilotIntent {
  return typeof v === 'string' && (COPILOT_INTENTS as readonly string[]).includes(v);
}

export const INTENT_REPLY_STRATEGIES: Record<CopilotIntent, string> = {
  interested_qualifying: `
They expressed mild interest ("interesting", "tell me more", "curious").

STRATEGY:
- Acknowledge their curiosity without overselling
- Provide 1-2 sentences of concrete value (specific to their context)
- REDUCE the ask — offer something low-commitment (1-pager, async info, brief intro)
- Leave control with them

AVOID:
- Immediately pushing for a meeting
- Generic sales pitch
- Long product explanations
`.trim(),

  meeting_request: `
They want to meet ("Can we chat?", "Let's set up a call", "Free this week?").

STRATEGY:
- Say yes warmly
- Propose 2-3 specific time slots OR send calendar link
- Mention 1 thing you'll cover so it's useful for them
- Keep it brief — they already said yes

AVOID:
- Long preamble
- Over-explaining what you'll discuss
- Asking them to suggest times (you suggest)
`.trim(),

  pricing_inquiry: `
They asked about pricing ("How much?", "What does it cost?", "Pricing model?").

STRATEGY:
- Lead with the answer (clear, specific, no hedging)
- Frame the value proposition briefly
- Anticipate the common follow-up ("vs alternative X")
- Soft next step ("happy to share examples" / "want to discuss specifics?")

AVOID:
- Hiding the price ("depends on your needs")
- Long qualification before answering
- Defensive framing
`.trim(),

  objection_price: `
They pushed back on price ("Too expensive", "Out of budget", "Cheaper alternatives").

STRATEGY:
- Acknowledge the concern without apologizing
- Reframe value (ROI, time saved, risk reduced)
- Compare to true alternatives (their current cost of not solving it)
- Offer a smaller/different engagement if appropriate

AVOID:
- Discounting reflexively
- Defensive justification
- Restating the price
`.trim(),

  objection_timing: `
They said timing isn't right ("Not now", "Maybe Q3", "Have other priorities").

STRATEGY:
- Accept the timing gracefully
- Lock in a future touch (specific month or trigger)
- Provide something useful they can read async
- Express continued interest without pressure

AVOID:
- Trying to override their timing
- "Let me know when you're ready" (passive)
- Disappearing entirely
`.trim(),

  objection_solution: `
They have a current solution ("We use X", "We work with Y", "Already covered").

STRATEGY:
- Don't bash their current solution
- Position as complementary or as backup option
- Ask about specific limitations of current solution
- Plant a seed for future ("if X changes, we're here")

AVOID:
- "But our solution is better because..."
- Forcing comparison
- Dismissing their choice
`.trim(),

  objection_authority: `
They aren't the decision-maker ("I'll need to check with...", "Not my call", "Talk to my CTO").

STRATEGY:
- Help them sell it internally (give them ammo)
- Offer to send a brief summary they can forward
- Ask who the right person is to loop in
- Don't bypass them

AVOID:
- "Can you connect me directly with the CTO?"
- Pressuring them
- Pretending you didn't hear
`.trim(),

  info_request: `
They want specific info ("Send me a brochure", "Do you have a case study?", "What's your website?").

STRATEGY:
- Send what they asked for
- Include 1 specific tailored insight
- Brief follow-up question to keep dialogue open

AVOID:
- Long preamble before answering
- Upselling
- Asking them to "hop on a call" first
`.trim(),

  polite_decline: `
They politely declined ("Not interested", "Not a fit", "Thanks but no").

STRATEGY:
- Accept gracefully
- One line acknowledgment
- Leave door open for future (no pressure)
- Wish them well briefly

AVOID:
- Trying to convince
- "Just one more thing..."
- Guilt or persistence
`.trim(),

  hostile: `
They're hostile ("Stop spamming", "Remove me", "How did you get my info?").

STRATEGY:
- Brief, professional apology
- Confirm removal/unsubscribe
- NO further pitch, NO defending
- End conversation

AVOID:
- Defending your outreach
- Asking why
- Trying to recover the relationship
`.trim(),

  casual_chat: `
They engaged casually ("How's Vilnius?", "Cool company name", "Random observation").

STRATEGY:
- Match their casual energy
- Respond authentically and briefly
- Find a natural bridge back to business (only if it feels right)
- It's OK to just be human for one message

AVOID:
- Forcing the conversation back to sales
- Long answers
- Ignoring their casual tone
`.trim(),

  competitor_intel: `
They're probing for competitive info ("How do you compare to X?", "Are you like Mercor?").

STRATEGY:
- Acknowledge the comparison without trashing competitors
- State your specific differentiator clearly
- Reframe the question — "different approach" rather than "better"
- Offer concrete evidence (examples, results)

AVOID:
- Bashing competitors
- Defensiveness
- Generic differentiation claims
`.trim(),
};
