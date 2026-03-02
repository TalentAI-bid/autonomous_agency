export type InboundClassification =
  | 'inquiry'
  | 'application'
  | 'partnership'
  | 'support_request'
  | 'spam'
  | 'introduction'
  | 'other';

export interface InboundEmailAnalysis {
  classification: InboundClassification;
  sentiment: number; // -1 to 1
  senderName?: string;
  senderCompany?: string;
  senderRole?: string;
  suggestedAction: string;
  priority: 'low' | 'medium' | 'high';
  reasoning: string;
}

export function buildSystemPrompt(context?: {
  useCase?: string;
  description?: string;
  mission?: string;
  valueProposition?: string;
}): string {
  const businessSection = context
    ? `\n\nBusiness context:
- Industry/Use case: ${context.useCase ?? 'general'}
- Description: ${context.description ?? 'N/A'}
- Mission: ${context.mission ?? 'N/A'}
- Value proposition: ${context.valueProposition ?? 'N/A'}

Use this context to classify emails more accurately. For example, if this is a sales company, inbound inquiries about products/services should be classified as "inquiry", not "application".`
    : '';

  return `You are an inbound email classifier for a business automation system. Analyze unsolicited inbound emails and classify them accurately.${businessSection}

Classification definitions:
- inquiry: Someone asking about your services, products, pricing, or capabilities
- application: A job applicant or candidate reaching out about a position
- partnership: A business development or partnership proposal
- support_request: Existing customer or user asking for help or support
- spam: Unsolicited marketing, phishing, or irrelevant automated messages
- introduction: Someone introducing themselves or making a warm intro for networking
- other: Ambiguous or doesn't fit other categories

Sentiment score: -1 (very negative) to 1 (very positive), 0 = neutral.
Priority: low (spam, generic), medium (standard inquiries), high (hot leads, urgent requests).

Extract sender name, company, and role if mentioned in the email.
Suggest a concrete next action (e.g. "Reply with pricing info", "Add to recruitment pipeline", "Ignore - spam").

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  fromEmail: string;
  subject: string;
  body: string;
}): string {
  return `Classify this inbound email.

FROM: ${data.fromEmail}
SUBJECT: ${data.subject}

BODY:
${data.body.slice(0, 3000)}

Return JSON:
{
  "classification": "inquiry|application|partnership|support_request|spam|introduction|other",
  "sentiment": 0.0,
  "senderName": "Optional: sender's name if mentioned",
  "senderCompany": "Optional: sender's company if mentioned",
  "senderRole": "Optional: sender's role/title if mentioned",
  "suggestedAction": "Brief description of recommended next step",
  "priority": "low|medium|high",
  "reasoning": "Brief explanation of classification"
}`;
}
