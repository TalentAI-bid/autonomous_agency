// ── Shared types for intelligent email generation ────────────────────────────

export interface EmailGenerationContext {
  contact: {
    firstName: string;
    lastName?: string;
    title?: string;
    skills?: string[];
    experience?: number;
    linkedinUrl?: string;
    summary?: string;
    seniorityLevel?: string;
    location?: string;
  };
  company: {
    name?: string;
    domain?: string;
    industry?: string;
    size?: string;
    techStack?: string[];
    funding?: string;
    description?: string;
    recentNews?: string[];
    products?: string[];
    foundedYear?: number;
    headquarters?: string;
    competitors?: string[];
    recentFunding?: string;
    keyPeople?: Array<{ name: string; title: string }>;
  };
  sender: {
    companyName?: string;
    companyDescription?: string;
    services?: string[];
    caseStudies?: Array<{ title: string; result: string }>;
    differentiators?: string[];
    valueProposition?: string;
    callToAction?: string;
    calendlyUrl?: string;
    website?: string;
    senderFirstName?: string;
    senderTitle?: string;
    products?: Array<{
      name: string;
      description?: string | null;
      keyFeatures?: string[] | null;
      painPointsSolved?: string[] | null;
    }>;
  };
  campaign: {
    tone?: string;
    useCase?: string;
    emailRules?: string[];
    stepNumber: number;
    totalSteps: number;
  };
  previousEmails?: Array<{
    stepNumber: number;
    subject: string;
    sentAt?: string;
    opened: boolean;
    openedAt?: string;
    replied: boolean;
  }>;
  opportunity?: {
    type: string;
    title: string;
    description?: string;
    buyingIntentScore: number;
    technologies?: string[];
    source?: string;
  };
}

export interface GeneratedEmail {
  subject: string;
  body: string;
}

// ── Sales email prompt builder ───────────────────────────────────────────────

export function buildSalesEmailPrompt(ctx: EmailGenerationContext): { system: string; user: string } {
  const rulesSection = ctx.campaign.emailRules?.length
    ? `\n\nMANDATORY EMAIL RULES — you MUST follow these in EVERY email:\n${ctx.campaign.emailRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

  const system = `You are an expert B2B sales copywriter. You write highly personalized cold emails that get replies.

RULES:
- Max 120 words body, 6-8 word subject line
- MUST reference a specific detail about the prospect's company (tech stack, funding, news, industry challenge, or product)
- MUST propose a specific service/solution from the sender's offerings that directly addresses the prospect's situation
- No generic openers ("I hope this finds you well", "I came across your company")
- No markdown formatting in the email body — use plain text with basic HTML (<p>, <br>, <strong>) only
- Do NOT include a signature or sign-off in the body — the email template adds it automatically
- Do NOT add "Best regards", "Cheers", sender name, or any closing at the end of the body
- Subject line: no clickbait, no ALL CAPS, no exclamation marks
- Do NOT mention that you are AI or that this is automated
- If an OPPORTUNITY SIGNAL is provided, you MUST reference it specifically. Tie your proposed service to the observed need. Never send generic "we can help" emails when you have a concrete signal${rulesSection}

Always respond with valid JSON containing "subject" and "body" fields.`;

  // Build contact section
  const contactLines = [
    `- First Name: ${ctx.contact.firstName}`,
    ctx.contact.title ? `- Title: ${ctx.contact.title}` : null,
    ctx.contact.seniorityLevel ? `- Seniority: ${ctx.contact.seniorityLevel}` : null,
    ctx.contact.location ? `- Location: ${ctx.contact.location}` : null,
    ctx.contact.skills?.length ? `- Expertise: ${ctx.contact.skills.slice(0, 5).join(', ')}` : null,
    ctx.contact.summary ? `- Profile Summary: ${ctx.contact.summary.slice(0, 200)}` : null,
  ].filter(Boolean).join('\n');

  // Build company section
  const companyLines = [
    ctx.company.name ? `- Company: ${ctx.company.name}` : null,
    ctx.company.industry ? `- Industry: ${ctx.company.industry}` : null,
    ctx.company.size ? `- Size: ${ctx.company.size}` : null,
    ctx.company.techStack?.length ? `- Tech Stack: ${ctx.company.techStack.slice(0, 8).join(', ')}` : null,
    ctx.company.funding ? `- Funding: ${ctx.company.funding}` : null,
    ctx.company.recentFunding ? `- Recent Funding: ${ctx.company.recentFunding}` : null,
    ctx.company.description ? `- Description: ${ctx.company.description.slice(0, 200)}` : null,
    ctx.company.products?.length ? `- Products: ${ctx.company.products.slice(0, 5).join(', ')}` : null,
    ctx.company.recentNews?.length ? `- Recent News: ${ctx.company.recentNews.slice(0, 3).join('; ')}` : null,
    ctx.company.foundedYear ? `- Founded: ${ctx.company.foundedYear}` : null,
    ctx.company.headquarters ? `- HQ: ${ctx.company.headquarters}` : null,
    ctx.company.competitors?.length ? `- Competitors: ${ctx.company.competitors.slice(0, 4).join(', ')}` : null,
    ctx.company.keyPeople?.length
      ? `- Key People: ${ctx.company.keyPeople.slice(0, 3).map((p) => `${p.name} (${p.title})`).join(', ')}`
      : null,
  ].filter(Boolean).join('\n');

  // Build sender section
  let senderLines = [
    ctx.sender.companyName ? `- Our Company: ${ctx.sender.companyName}` : null,
    ctx.sender.companyDescription ? `- What We Do: ${ctx.sender.companyDescription}` : null,
    ctx.sender.services?.length ? `- Services: ${ctx.sender.services.join(', ')}` : null,
    ctx.sender.caseStudies?.length
      ? `- Case Studies:\n${ctx.sender.caseStudies.map((cs) => `  * ${cs.title}: ${cs.result}`).join('\n')}`
      : null,
    ctx.sender.differentiators?.length ? `- Differentiators: ${ctx.sender.differentiators.join(', ')}` : null,
    ctx.sender.valueProposition ? `- Value Proposition: ${ctx.sender.valueProposition}` : null,
    ctx.sender.callToAction ? `- Desired CTA: ${ctx.sender.callToAction}` : null,
    ctx.sender.calendlyUrl ? `- Scheduling Link: ${ctx.sender.calendlyUrl}` : null,
    ctx.sender.website ? `- Website: ${ctx.sender.website}` : null,
    ctx.sender.senderFirstName ? `- Sender Name: ${ctx.sender.senderFirstName}` : null,
    ctx.sender.senderTitle ? `- Sender Title: ${ctx.sender.senderTitle}` : null,
  ].filter(Boolean).join('\n');

  // Append products to sender context
  if (ctx.sender.products?.length) {
    const productLines = ctx.sender.products.slice(0, 3).map((p) => {
      const parts = [`  * ${p.name}: ${p.description ?? ''}`];
      if (p.keyFeatures?.length) parts.push(`    Features: ${p.keyFeatures.slice(0, 3).join(', ')}`);
      if (p.painPointsSolved?.length) parts.push(`    Solves: ${p.painPointsSolved.slice(0, 3).join(', ')}`);
      return parts.join('\n');
    }).join('\n');
    senderLines += `\n- Products/Services:\n${productLines}`;
  }

  // Build follow-up strategy
  const followUpStrategy = buildFollowUpStrategy(ctx, 'sales');

  const user = `Write a personalized sales outreach email.

PROSPECT:
${contactLines}

COMPANY:
${companyLines || '- No company data available'}

SENDER:
${senderLines || '- No sender context available'}

${ctx.opportunity ? `OPPORTUNITY SIGNAL:
- Type: ${ctx.opportunity.type}
- Signal: ${ctx.opportunity.title}
- Description: ${ctx.opportunity.description ?? 'N/A'}
- Technologies: ${ctx.opportunity.technologies?.join(', ') ?? 'N/A'}
- Buying Intent Score: ${ctx.opportunity.buyingIntentScore}
` : ''}CAMPAIGN STEP: ${ctx.campaign.stepNumber} of ${ctx.campaign.totalSteps}
TONE: ${ctx.campaign.tone ?? 'professional'}

${followUpStrategy}

Return JSON:
{
  "subject": "Short compelling subject line (6-8 words)",
  "body": "Email body (max 120 words, basic HTML)"
}`;

  return { system, user };
}

// ── Follow-up strategy builder (shared) ──────────────────────────────────────

function buildFollowUpStrategy(ctx: EmailGenerationContext, type: 'sales' | 'recruitment'): string {
  const { stepNumber } = ctx.campaign;
  const previousEmails = ctx.previousEmails ?? [];

  if (stepNumber === 1 || previousEmails.length === 0) {
    return `STRATEGY: This is the first outreach email. Make a strong first impression with a specific observation about their ${type === 'sales' ? 'company' : 'background'}.`;
  }

  const lastEmail = previousEmails[previousEmails.length - 1];
  const wasOpened = lastEmail?.opened ?? false;
  const wasReplied = lastEmail?.replied ?? false;

  if (wasReplied) {
    return 'STRATEGY: They replied to a previous email. This should be a natural continuation of the conversation.';
  }

  const prevSubjects = previousEmails.map((e) => `  - Step ${e.stepNumber}: "${e.subject}" ${e.opened ? '(opened)' : '(not opened)'}`).join('\n');

  if (stepNumber === 2) {
    if (wasOpened) {
      return `STRATEGY: Follow-up #1 — they OPENED the previous email but did not reply. They showed interest.
- Reference the previous email subtly (don't say "I see you opened my email")
- Offer a new angle: share a relevant case study, insight, or additional value
- Keep subject line related but different

PREVIOUS EMAILS:
${prevSubjects}`;
    }
    return `STRATEGY: Follow-up #1 — they did NOT open the previous email.
- Use a COMPLETELY different subject line and angle
- Shorter body (max 60 words)
- Try a different hook or value proposition

PREVIOUS EMAILS:
${prevSubjects}`;
  }

  if (stepNumber >= 3) {
    return `STRATEGY: Final follow-up (break-up email).
- Very short (max 50 words)
- Graceful close — "Totally understand if the timing isn't right"
- Low-pressure, give them an easy way to say no or re-engage later
- Different subject line from all previous emails

PREVIOUS EMAILS:
${prevSubjects}`;
  }

  return `STRATEGY: Follow-up email #${stepNumber - 1}.

PREVIOUS EMAILS:
${prevSubjects}`;
}

export { buildFollowUpStrategy };
