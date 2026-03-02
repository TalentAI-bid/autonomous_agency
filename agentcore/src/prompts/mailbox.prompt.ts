export interface EmailAnalysisResult {
  companyName?: string;
  roleTitle?: string;
  budgetOrValue?: string;
  interestSignals: string[];
  objections: string[];
  questions: string[];
  actionItems: string[];
  deadlinesMentioned: string[];
  meetingMentioned: boolean;
  priority: 'high' | 'medium' | 'low';
  suggestedNextAction: string;
}

export interface ThreadSummaryResult {
  summary: string;
  keyInfo: {
    companyName?: string;
    roleTitle?: string;
    interestLevel?: string;
    dealValue?: string;
  };
  suggestedNextAction: string;
}

export function buildEmailAnalysisSystemPrompt(): string {
  return `You are an intelligent email analysis agent for a CRM system. Your job is to extract structured information from an email to update CRM records and suggest next actions.

Analyze the email content and extract:
1. **companyName** — The company name if mentioned
2. **roleTitle** — Any job title or role mentioned
3. **budgetOrValue** — Any budget, value, or monetary amounts mentioned
4. **interestSignals** — Phrases or cues indicating interest (e.g., "let's schedule a call", "sounds great", "interested in learning more")
5. **objections** — Any concerns, objections, or pushback expressed
6. **questions** — Questions asked by the sender that need answers
7. **actionItems** — Specific actions that need to be taken (e.g., "send me a proposal", "schedule a meeting for next week")
8. **deadlinesMentioned** — Any dates or deadlines mentioned
9. **meetingMentioned** — Whether a meeting, call, or demo is mentioned or requested
10. **priority** — Overall priority: "high" if urgent/time-sensitive or strong interest, "medium" for normal follow-up, "low" for informational only
11. **suggestedNextAction** — A brief recommended next step

Always respond with valid JSON matching the EmailAnalysisResult interface.`;
}

export function buildEmailAnalysisUserPrompt(email: {
  subject: string;
  body: string;
  fromEmail: string;
  direction: 'inbound' | 'outbound';
  contactName?: string;
}): string {
  return `Analyze this ${email.direction} email and extract structured information.

From: ${email.fromEmail}${email.contactName ? ` (${email.contactName})` : ''}
Subject: ${email.subject}

Body:
${email.body?.slice(0, 3000) ?? '(empty)'}

Return a JSON object with: companyName, roleTitle, budgetOrValue, interestSignals[], objections[], questions[], actionItems[], deadlinesMentioned[], meetingMentioned (boolean), priority, suggestedNextAction.`;
}

export function buildThreadSummarySystemPrompt(): string {
  return `You are a conversation summarizer for a CRM email system. Given a chronological thread of emails (both sent and received), produce a concise summary and extract key information.

Your summary should:
1. Be 2-3 sentences covering the main topic and current state of the conversation
2. Extract key info: company name, role/title discussed, interest level, and any deal value mentioned
3. Suggest a clear next action based on the conversation state

Always respond with valid JSON matching the ThreadSummaryResult interface.`;
}

export function buildThreadSummaryUserPrompt(messages: Array<{
  direction: 'sent' | 'received';
  fromEmail: string;
  subject: string;
  body: string;
  date: string;
}>): string {
  const formatted = messages.map((m, i) =>
    `[${i + 1}] ${m.direction.toUpperCase()} — ${m.date}\nFrom: ${m.fromEmail}\nSubject: ${m.subject}\n${m.body?.slice(0, 1500) ?? '(empty)'}`,
  ).join('\n\n---\n\n');

  return `Summarize this email thread and extract key information.

EMAIL THREAD (${messages.length} messages):

${formatted}

Return JSON: { "summary": "...", "keyInfo": { "companyName": "...", "roleTitle": "...", "interestLevel": "...", "dealValue": "..." }, "suggestedNextAction": "..." }`;
}
