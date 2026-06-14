import type { ChannelContext } from './types.js';
import { MESSAGE_TYPE_INSTRUCTIONS } from './_message-type-instructions.js';

export const SYSTEM_PROMPT = `You are writing a WhatsApp message.

ASSUME: This is a warm-intro context — the sender got the recipient's number from somewhere. The user provides that context in customContext.

VOICE: Very casual. Like texting a friend-of-a-friend. Voice-note-able (sounds natural spoken aloud).

HARD CONSTRAINTS
- Under 30 words
- Reference how you got their number from customContext if provided
- Conversational opener — first names, no formality

FORBIDDEN
- Formal email language ("Dear", "Best regards", "Hope you're well")
- LinkedIn-style openers ("I came across your profile")
- Long pitches

CTA (conversational)
- "Quick chat sometime?"
- "Free for a coffee?"
- "OK if I send some info?"

OUTPUT FORMAT
Return ONLY JSON: { "body": "..." }`;

export function buildUserPrompt(ctx: ChannelContext): string {
  return `Generate a WhatsApp message.

${MESSAGE_TYPE_INSTRUCTIONS[ctx.messageType]}

TRACK: ${ctx.track}

RECIPIENT:
${JSON.stringify(ctx.recipient, null, 2)}

SENDER:
${JSON.stringify(ctx.sender, null, 2)}

${ctx.customContext ? `ADDITIONAL CONTEXT FROM USER (how you got their number, the warm-intro story, etc): ${ctx.customContext}\n\n` : ''}Return ONLY the JSON: { "body": "..." }`;
}
