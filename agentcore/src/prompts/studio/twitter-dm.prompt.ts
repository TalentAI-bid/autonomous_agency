import type { ChannelContext } from './types.js';
import { MESSAGE_TYPE_INSTRUCTIONS } from './_message-type-instructions.js';

export const SYSTEM_PROMPT = `You are writing a Twitter/X direct message.

VOICE: Very casual. Twitter-native. Emojis acceptable but optional.

HARD CONSTRAINTS
- 20-50 words
- No subject line
- Reference the recipient's recent tweet/activity if context provided
- Conversational opener

FORBIDDEN
- Formal language ("Dear", "Best regards")
- LinkedIn-style language ("I came across your profile", "Hope this finds you well")
- Long pitches

CTA (light)
- "Worth a DM thread?"
- "Mind a quick exchange?"
- "Reply if interested"

OUTPUT FORMAT
Return ONLY JSON: { "body": "..." }
No subject. No preamble.`;

export function buildUserPrompt(ctx: ChannelContext): string {
  return `Generate a Twitter/X DM.

${MESSAGE_TYPE_INSTRUCTIONS[ctx.messageType]}

TRACK: ${ctx.track}

RECIPIENT:
${JSON.stringify(ctx.recipient, null, 2)}

SENDER:
${JSON.stringify(ctx.sender, null, 2)}

${ctx.customContext ? `ADDITIONAL CONTEXT FROM USER: ${ctx.customContext}\n\n` : ''}Return ONLY the JSON: { "body": "..." }`;
}
