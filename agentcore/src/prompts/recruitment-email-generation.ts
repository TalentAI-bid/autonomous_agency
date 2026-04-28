import type { EmailGenerationContext } from './sales-email-generation.js';
import { buildFollowUpStrategy } from './sales-email-generation.js';

// ── Recruitment email prompt builder ─────────────────────────────────────────

export function buildRecruitmentEmailPrompt(ctx: EmailGenerationContext): { system: string; user: string } {
  const rulesSection = ctx.campaign.emailRules?.length
    ? `\n\nMANDATORY EMAIL RULES — you MUST follow these in EVERY email:\n${ctx.campaign.emailRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

  const system = `You are an expert technical recruiter writing peer-to-peer outreach emails. You write like a knowledgeable professional, not a generic recruiter.

RULES:
- Max 120 words body, 6-8 word subject line
- MUST reference a specific skill, project, or achievement from their profile
- Explain WHY their background fits — mention specific technologies, not "your experience is impressive"
- Low-pressure CTA: "Would you be open to a quick chat?" or similar
- No generic openers ("I hope this finds you well", "I came across your profile")
- Output the body as PLAIN TEXT only. Use \n for line breaks and \n\n between paragraphs. Do NOT include any HTML tags, markdown, or special formatting characters. The system will convert paragraphs to HTML at send time.
- Do NOT include a signature or sign-off in the body — the email template adds it automatically
- Do NOT add "Best regards", "Cheers", sender name, or any closing at the end of the body
- Subject line: specific and role-relevant, no clickbait
- Do NOT mention that you are AI or that this is automated${rulesSection}

Always respond with valid JSON containing "subject" and "body" fields.`;

  // Build contact section
  const contactLines = [
    `- First Name: ${ctx.contact.firstName}`,
    ctx.contact.title ? `- Current Role: ${ctx.contact.title}` : null,
    ctx.contact.seniorityLevel ? `- Seniority: ${ctx.contact.seniorityLevel}` : null,
    ctx.contact.location ? `- Location: ${ctx.contact.location}` : null,
    ctx.contact.skills?.length ? `- Key Skills: ${ctx.contact.skills.slice(0, 8).join(', ')}` : null,
    ctx.contact.experience ? `- Years of Experience: ${ctx.contact.experience}` : null,
    ctx.contact.summary ? `- Profile Summary: ${ctx.contact.summary.slice(0, 300)}` : null,
    ctx.contact.linkedinUrl ? `- LinkedIn: ${ctx.contact.linkedinUrl}` : null,
  ].filter(Boolean).join('\n');

  // Build company context (where they currently work)
  const companyLines = [
    ctx.company.name ? `- Current Company: ${ctx.company.name}` : null,
    ctx.company.industry ? `- Industry: ${ctx.company.industry}` : null,
    ctx.company.size ? `- Company Size: ${ctx.company.size}` : null,
    ctx.company.techStack?.length ? `- Company Tech Stack: ${ctx.company.techStack.slice(0, 6).join(', ')}` : null,
  ].filter(Boolean).join('\n');

  // Build opportunity/sender section
  const senderLines = [
    ctx.sender.companyName ? `- Hiring Company: ${ctx.sender.companyName}` : null,
    ctx.sender.companyDescription ? `- About Us: ${ctx.sender.companyDescription}` : null,
    ctx.sender.services?.length ? `- What We Build: ${ctx.sender.services.join(', ')}` : null,
    ctx.sender.differentiators?.length ? `- Why Us: ${ctx.sender.differentiators.join(', ')}` : null,
    ctx.sender.valueProposition ? `- Role Value Prop: ${ctx.sender.valueProposition}` : null,
    ctx.sender.callToAction ? `- Desired CTA: ${ctx.sender.callToAction}` : null,
    ctx.sender.calendlyUrl ? `- Scheduling Link: ${ctx.sender.calendlyUrl}` : null,
    ctx.sender.website ? `- Careers/Website: ${ctx.sender.website}` : null,
    ctx.sender.senderFirstName ? `- Recruiter Name: ${ctx.sender.senderFirstName}` : null,
    ctx.sender.senderTitle ? `- Recruiter Title: ${ctx.sender.senderTitle}` : null,
  ].filter(Boolean).join('\n');

  // Build follow-up strategy
  const followUpStrategy = buildFollowUpStrategy(ctx, 'recruitment');

  const user = `Write a personalized recruitment outreach email.

CANDIDATE:
${contactLines}

CURRENT COMPANY:
${companyLines || '- No company data available'}

OPPORTUNITY:
${senderLines || '- No opportunity context available'}

CAMPAIGN STEP: ${ctx.campaign.stepNumber} of ${ctx.campaign.totalSteps}
TONE: ${ctx.campaign.tone ?? 'professional'}

${followUpStrategy}

Return JSON:
{
  "subject": "Short role-specific subject line (6-8 words)",
  "body": "Email body — plain text, max 120 words, use \\n\\n for paragraph breaks. NO HTML."
}`;

  return { system, user };
}
