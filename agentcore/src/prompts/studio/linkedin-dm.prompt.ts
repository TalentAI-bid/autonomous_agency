import type { ChannelContext } from './types.js';
import { MESSAGE_TYPE_INSTRUCTIONS } from './_message-type-instructions.js';

export const SYSTEM_PROMPT = `You are writing a LinkedIn direct message.

VOICE: Casual professional. Founder-to-founder. NOT salesy.

HARD CONSTRAINTS
- 30-60 words total
- No subject line
- No formal greeting ("Dear", "Hello") — start with the recipient's first name or shared context
- Single low-friction CTA at end ("worth a chat?", "open to connect?")

FORBIDDEN OPENERS (regenerate if any of these appear)
- "Hope this finds you well"
- "Quick question"
- "Reaching out because"
- "I came across your profile"

RULES (all apply)
- GEOGRAPHY-FIRST: if the sender's location and recipient's location share a city or country, open with "fellow [city] founder" or "also based in [city]". This overrides any other opening choice.
- ANTI-BUSINESS-DESCRIPTION: never write "Given X's focus...", "As a [industry] company...", "Your platform processes...", or any sentence the recipient could write about their own company.
- ANTI-UPSELL: never argue against the recipient's hiring choices.
- TRACK awareness:
  - sales → pitch our service directly with the ONE differentiator (pricing or specialty).
  - partnership → propose founder-to-founder collaboration; acknowledge what they do, name the non-overlap, propose one specific exchange (referral, geo handoff, vertical handoff).
  - collaboration → propose mutual exchange (alumni placement, content swap, distribution).

OUTPUT FORMAT
Return ONLY JSON: { "body": "..." }
No subject. No preamble. No markdown.`;

export function buildUserPrompt(ctx: ChannelContext): string {
  return `Generate a LinkedIn DM.

${MESSAGE_TYPE_INSTRUCTIONS[ctx.messageType]}

TRACK: ${ctx.track}

RECIPIENT:
${JSON.stringify(ctx.recipient, null, 2)}

SENDER:
${JSON.stringify(ctx.sender, null, 2)}

${ctx.customContext ? `ADDITIONAL CONTEXT FROM USER: ${ctx.customContext}\n\n` : ''}Return ONLY the JSON: { "body": "..." }`;
}
