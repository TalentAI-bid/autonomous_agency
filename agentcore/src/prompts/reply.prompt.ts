export type ReplyClassification =
  | 'interested'
  | 'objection'
  | 'not_now'
  | 'out_of_office'
  | 'unsubscribe'
  | 'bounce'
  | 'other';

export interface ReplyAnalysis {
  classification: ReplyClassification;
  sentiment: number; // -1 to 1
  reasoning: string;
  suggestedResponse?: string;
  returnDate?: string; // ISO date for out_of_office
}

export function buildSystemPrompt(): string {
  return `You are an email response classifier for a recruitment/sales automation system. Analyze email replies and classify them accurately.

Classification definitions:
- interested: Positive response, wants to know more, open to conversation, or agrees to meeting
- objection: Has concerns but is not firmly declining (salary, timing, location, role fit)
- not_now: Politely declining but might be open in future ("not looking right now", "happy where I am")
- out_of_office: Automated OOO reply, includes return date if available
- unsubscribe: Explicitly asking to be removed from contact list
- bounce: Email delivery failure, hard bounce, or mailbox full
- other: Ambiguous, needs human review

Sentiment score: -1 (very negative) to 1 (very positive), 0 = neutral.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  replyBody: string;
  originalSubject: string;
  contactName?: string;
}): string {
  return `Classify this email reply.

ORIGINAL EMAIL SUBJECT: ${data.originalSubject}
${data.contactName ? `FROM: ${data.contactName}` : ''}

REPLY:
${data.replyBody.slice(0, 2000)}

Return JSON:
{
  "classification": "interested|objection|not_now|out_of_office|unsubscribe|bounce|other",
  "sentiment": 0.5,
  "reasoning": "Brief explanation of classification",
  "suggestedResponse": "Optional: draft response if objection or other that needs reply",
  "returnDate": "Optional: ISO date string if out_of_office"
}`;
}
