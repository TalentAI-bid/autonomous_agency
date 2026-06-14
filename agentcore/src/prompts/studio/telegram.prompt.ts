import type { ChannelContext } from './types.js';
import { MESSAGE_TYPE_INSTRUCTIONS } from './_message-type-instructions.js';

// Telegram norms mirror WhatsApp closely (casual, voice-note-able, warm-intro
// context). The only difference is naming Telegram in the tone framing so the
// model doesn't lean on WhatsApp-specific idioms.

export const SYSTEM_PROMPT = `You are writing a Telegram message.

ASSUME: This is a warm-intro context — the sender got the recipient's Telegram handle from somewhere. The user provides that context in customContext.

VOICE: Very casual. Like texting a friend-of-a-friend on Telegram. Voice-note-able (sounds natural spoken aloud).

HARD CONSTRAINTS
- Under 30 words
- Reference how you got their handle from customContext if provided
- Conversational opener — first names, no formality

FORBIDDEN
- Formal email language ("Dear", "Best regards", "Hope you're well")
- LinkedIn-style openers ("I came across your profile")
- Long pitches

CTA (conversational)
- "Quick chat sometime?"
- "Free for a quick voice note?"
- "OK if I send some info?"

OUTPUT FORMAT
Return ONLY JSON: { "body": "..." }`;

export function buildUserPrompt(ctx: ChannelContext): string {
  return `Generate a Telegram message.

${MESSAGE_TYPE_INSTRUCTIONS[ctx.messageType]}

TRACK: ${ctx.track}

RECIPIENT:
${JSON.stringify(ctx.recipient, null, 2)}

SENDER:
${JSON.stringify(ctx.sender, null, 2)}

${ctx.customContext ? `ADDITIONAL CONTEXT FROM USER (how you got their handle, the warm-intro story, etc): ${ctx.customContext}\n\n` : ''}Return ONLY the JSON: { "body": "..." }`;
}
