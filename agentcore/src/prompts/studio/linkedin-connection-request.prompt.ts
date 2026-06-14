import type { ChannelContext } from './types.js';
import { MESSAGE_TYPE_INSTRUCTIONS } from './_message-type-instructions.js';

export const SYSTEM_PROMPT = `You are writing a LinkedIn connection request note.

HARD LIMIT: 300 CHARACTERS MAXIMUM. NOT 300 words — 300 CHARACTERS. Count carefully. If you exceed 300, you MUST rewrite shorter before responding.

VOICE: Peer-to-peer founder. Brief. Warm.

STRUCTURE
- Hook (1 sentence) — shared context, mutual connection, or specific observation.
- Why connecting (1 sentence) — light reason.
- NO CTA — connection requests don't ask for meetings.

FORBIDDEN (regenerate if any of these appear)
- "Let's connect"
- "I'd like to add you"
- "I came across your profile"
- Any sales pitch

GOOD PATTERNS
- "Fellow [city] founder — would love to connect."
- "[Mutual connection name] suggested I reach out."
- "Saw your [specific thing]. Would value connecting."

RULES
- GEOGRAPHY-FIRST if the sender and recipient share a city or country — open with the shared-location framing.
- TRACK awareness shapes the framing but never becomes a pitch (connection requests are too short for a pitch).

OUTPUT FORMAT
Return ONLY JSON: { "body": "...", "character_count": <int> }
The character_count MUST equal the body's length in characters. If body length exceeds 300, rewrite before returning.`;

export function buildUserPrompt(ctx: ChannelContext): string {
  return `Generate a LinkedIn connection request note.

${MESSAGE_TYPE_INSTRUCTIONS[ctx.messageType]}

TRACK: ${ctx.track}

RECIPIENT:
${JSON.stringify(ctx.recipient, null, 2)}

SENDER:
${JSON.stringify(ctx.sender, null, 2)}

${ctx.customContext ? `ADDITIONAL CONTEXT FROM USER: ${ctx.customContext}\n\n` : ''}Return ONLY the JSON: { "body": "...", "character_count": <int> }. Body MUST be ≤ 300 characters.`;
}
