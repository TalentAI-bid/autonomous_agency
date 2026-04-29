/**
 * Prompt for parsing free-text + OCR'd image content into a structured CRM
 * activity payload, ready for /api/crm/activities.
 *
 * The LLM is told to:
 *  - Pick ONE activity type from a fixed enum (must match crm_activities.type).
 *  - Extract a contact name + optional email if mentioned.
 *  - Write a short title (≤80 chars) and a longer description.
 *  - Suggest a deal-stage transition only when it's clearly implied
 *    ("they want to book a demo" → meeting_booked).
 *
 * Output is strict JSON; no markdown, no commentary.
 */

export const ACTIVITY_TYPES = [
  'note_added',
  'call_logged',
  'meeting_scheduled',
  'manual_email_sent',
  'manual_email_received',
  'linkedin_connection_sent',
  'linkedin_connection_accepted',
  'linkedin_message_sent',
  'linkedin_message_received',
  'linkedin_followup_sent',
] as const;
export type CopilotActivityType = (typeof ACTIVITY_TYPES)[number];

export interface CopilotActivityDraft {
  contactName: string | null;
  contactEmail: string | null;
  type: CopilotActivityType;
  title: string;
  description: string;
  suggestedStageSlug: string | null;
}

export function buildCopilotActivitySystem(): string {
  return `You convert free-form notes and screenshots into structured CRM activity records.

Output STRICT JSON. No prose, no markdown fences. Schema:

{
  "contactName": string | null,            // person's full name if mentioned, else null
  "contactEmail": string | null,           // their email if visible, else null
  "type": one of ${ACTIVITY_TYPES.map((t) => `"${t}"`).join(' | ')},
  "title": string,                         // ≤ 80 chars, action-oriented (e.g. "Sent connection request to Jane Doe")
  "description": string,                   // 1-3 sentences summarising what happened
  "suggestedStageSlug": string | null      // one of: "lead", "contacted", "replied", "meeting-booked", "qualified", "won", "lost" — only set when a stage transition is clearly implied
}

Type-picking rules:
- LinkedIn DM screenshots / "I messaged them on LinkedIn" → linkedin_message_sent
- LinkedIn reply or "they replied on LinkedIn" → linkedin_message_received
- "I sent a connection request" → linkedin_connection_sent
- "They accepted my connection" → linkedin_connection_accepted
- A second LinkedIn touch after the first → linkedin_followup_sent
- "I emailed them from my Gmail" / forwarded email I sent → manual_email_sent
- "They emailed me back" / received email → manual_email_received
- Phone or video call → call_logged
- Calendar invite / scheduled meeting → meeting_scheduled
- Pure note, observation, follow-up reminder → note_added

Stage hints:
- Just sent first message → "contacted"
- They replied → "replied"
- Booked a meeting → "meeting-booked"
- Asked for pricing or signed evaluation → "qualified"

If the input is ambiguous, prefer note_added with a clear title. NEVER invent a contact name; if no name is mentioned, set contactName to null.`;
}

export function buildCopilotActivityUser(args: { text: string; ocrText?: string }): string {
  const parts: string[] = [];
  if (args.text?.trim()) parts.push(`USER NOTE:\n${args.text.trim()}`);
  if (args.ocrText?.trim()) parts.push(`IMAGE OCR (text extracted from a screenshot the user uploaded):\n${args.ocrText.trim()}`);
  if (parts.length === 0) parts.push('(empty)');
  parts.push('\nReturn JSON only.');
  return parts.join('\n\n');
}
