export interface OutreachEmail {
  subject: string;
  body: string;
}

export function buildSystemPrompt(tone: string = 'professional'): string {
  return `You are an expert recruiter/business development specialist writing personalized outreach emails.

Tone: ${tone}
Style guidelines:
- Be concise (under 150 words for the body)
- Lead with something specific about the candidate
- Clearly state the opportunity and value proposition
- End with a low-friction call to action
- NO generic phrases like "I hope this finds you well" or "I came across your profile"
- DO reference specific skills, experience, or achievements
- Subject line: punchy, 6-8 words, no clickbait

Always respond with valid JSON containing "subject" and "body" fields.`;
}

export function buildUserPrompt(data: {
  contact: {
    firstName: string;
    title: string;
    companyName: string;
    skills: string[];
    location: string;
  };
  opportunity: {
    title: string;
    company: string;
    valueProposition: string;
    stepNumber: number;
    tone: string;
  };
  senderName?: string;
}): string {
  const topSkills = data.contact.skills.slice(0, 3).join(', ');

  const stepContext = data.opportunity.stepNumber === 1
    ? 'This is the first outreach email.'
    : data.opportunity.stepNumber === 2
      ? 'This is a follow-up to an unanswered first email. Reference that you reached out before, but keep it brief.'
      : 'This is a final follow-up. Keep it very short and graceful.';

  return `Write a personalized outreach email for this candidate.

CANDIDATE:
- First Name: ${data.contact.firstName}
- Current Role: ${data.contact.title} at ${data.contact.companyName}
- Location: ${data.contact.location}
- Key Skills: ${topSkills}

OPPORTUNITY:
- Role: ${data.opportunity.title}
- Company: ${data.opportunity.company}
- Value Proposition: ${data.opportunity.valueProposition}
- Tone: ${data.opportunity.tone}
${data.senderName ? `- Sender: ${data.senderName}` : ''}

CONTEXT: ${stepContext}

Return JSON:
{
  "subject": "Short compelling subject line",
  "body": "Email body text (can use basic HTML like <p>, <br>, <strong>)"
}`;
}
