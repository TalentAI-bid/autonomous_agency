import type { MasterAgent, Contact, Company } from '../db/schema/index.js';

type RecruitmentCtx = {
  requiredSkills?: string[];
  preferredSkills?: string[];
  minExperience?: number;
  experienceLevel?: string;
  companyContext?: string;
};

type SalesProduct = {
  name: string;
  description?: string;
  keyFeatures?: string[];
  painPointsSolved?: string[];
};

export function buildDraftEmailSystemPrompt(
  masterAgent: MasterAgent | null,
  company: Company | null,
): string {
  const config = (masterAgent?.config as Record<string, unknown>) ?? {};
  const useCase = (masterAgent?.useCase ?? 'sales') as string;
  const pipelineCtx = config.pipelineContext as Record<string, unknown> | undefined;
  const targetRoles = (pipelineCtx?.targetRoles as string[]) ?? [];
  const senderCompany =
    (config.companyName as string) ??
    (config.senderCompanyName as string) ??
    (pipelineCtx?.senderCompanyName as string) ??
    '';
  const senderFirstName = (pipelineCtx?.senderFirstName as string) ?? '';
  const senderTitle = (pipelineCtx?.senderTitle as string) ?? '';
  const tone = (pipelineCtx?.emailTone as string) ?? 'professional but conversational';

  if (useCase === 'recruitment') {
    return buildRecruitmentSystemPrompt({
      senderCompany,
      senderFirstName,
      senderTitle,
      tone,
      targetRoles,
      recruitment: (pipelineCtx?.recruitment as RecruitmentCtx | undefined) ?? {},
      jobDescriptionUrl: (pipelineCtx?.jobDescriptionUrl as string) ?? (config.jobDescriptionUrl as string) ?? '',
      compensation: (pipelineCtx?.compensation as string) ?? (config.compensation as string) ?? '',
      remotePolicy: (pipelineCtx?.remotePolicy as string) ?? (config.remotePolicy as string) ?? '',
      perks: (pipelineCtx?.perks as string[]) ?? (config.perks as string[]) ?? [],
      calendlyUrl: (pipelineCtx?.calendlyUrl as string) ?? (config.calendlyUrl as string) ?? '',
    });
  }

  return buildSalesSystemPrompt({
    senderCompany,
    senderFirstName,
    senderTitle,
    tone,
    services: (config.services as string[]) ?? [],
    valueProp:
      (config.valueProp as string) ??
      (config.valueProposition as string) ??
      ((pipelineCtx?.sales as Record<string, unknown>)?.valueProposition as string) ??
      '',
    angles: ((config.salesStrategy as Record<string, unknown>)?.emailStrategy as Record<string, unknown>)?.angles as
      | string[]
      | undefined,
    products: ((pipelineCtx?.sales as Record<string, unknown>)?.products as SalesProduct[]) ?? [],
    calendlyUrl:
      ((pipelineCtx?.sales as Record<string, unknown>)?.calendlyUrl as string) ??
      (config.calendlyUrl as string) ??
      '',
  });
}

function buildSalesSystemPrompt(args: {
  senderCompany: string;
  senderFirstName: string;
  senderTitle: string;
  tone: string;
  services: string[];
  valueProp: string;
  angles?: string[];
  products: SalesProduct[];
  calendlyUrl: string;
}): string {
  let productsSection = '';
  if (args.products.length > 0) {
    const lines = args.products.slice(0, 3).map((p) => {
      const parts = [`  * ${p.name}`];
      if (p.description) parts.push(`: ${p.description}`);
      if (p.keyFeatures?.length) parts.push(`\n    Features: ${p.keyFeatures.slice(0, 3).join(', ')}`);
      if (p.painPointsSolved?.length) parts.push(`\n    Solves: ${p.painPointsSolved.slice(0, 3).join(', ')}`);
      return parts.join('');
    });
    productsSection = `- Products/Services:\n${lines.join('\n')}`;
  }

  return `You are a B2B outreach specialist writing a personalized cold email.

SENDER CONTEXT:
- Company: ${args.senderCompany || 'Not specified'}
${args.senderFirstName ? `- Sender: ${args.senderFirstName}${args.senderTitle ? `, ${args.senderTitle}` : ''}` : ''}
- Services: ${args.services.join(', ') || 'Not specified'}
- Value proposition: ${args.valueProp || 'Not specified'}
${args.angles?.length ? `- Outreach angles: ${args.angles.join('; ')}` : ''}
${productsSection}
${args.calendlyUrl ? `- Booking link: ${args.calendlyUrl}` : ''}

INSTRUCTIONS:
- Write a personalized cold email that references the prospect company's specific pain points, signals, and context
- Use the sender's value proposition naturally — do not be salesy or pushy
- Keep it concise: 3-4 short paragraphs maximum
- End with a clear CTA (book a call, reply to discuss, etc.)
- Tone: ${args.tone}, like a peer reaching out
- Do NOT use generic filler ("I hope this finds you well")
- The body should be plain text (not HTML), with \\n for line breaks

IMPORTANT: Return ONLY the JSON object. No markdown code fences. No preamble. No postamble. Your entire response must be valid JSON: { "subject": "...", "body": "..." }`;
}

function buildRecruitmentSystemPrompt(args: {
  senderCompany: string;
  senderFirstName: string;
  senderTitle: string;
  tone: string;
  targetRoles: string[];
  recruitment: RecruitmentCtx;
  jobDescriptionUrl: string;
  compensation: string;
  remotePolicy: string;
  perks: string[];
  calendlyUrl: string;
}): string {
  const role = args.targetRoles[0] ?? 'an open role';
  const skillsRequired = args.recruitment.requiredSkills?.slice(0, 5) ?? [];
  const skillsPreferred = args.recruitment.preferredSkills?.slice(0, 5) ?? [];

  return `You are a technical recruiter at ${args.senderCompany || 'the company'} writing a personalized outreach email to a candidate.

THE COMPANY IS HIRING — frame the message that way. The recipient is a CANDIDATE, not a customer. You are pitching them on the role, not selling to them.

ROLE WE ARE HIRING FOR:
- Title: ${role}
${args.targetRoles.length > 1 ? `- Adjacent titles: ${args.targetRoles.slice(1).join(', ')}` : ''}
${skillsRequired.length ? `- Must-have skills: ${skillsRequired.join(', ')}` : ''}
${skillsPreferred.length ? `- Nice-to-have: ${skillsPreferred.join(', ')}` : ''}
${args.recruitment.experienceLevel ? `- Seniority: ${args.recruitment.experienceLevel}` : ''}
${args.recruitment.minExperience ? `- Min years experience: ${args.recruitment.minExperience}` : ''}
${args.compensation ? `- Compensation: ${args.compensation}` : ''}
${args.remotePolicy ? `- Work model: ${args.remotePolicy}` : ''}
${args.perks.length ? `- Perks: ${args.perks.join(', ')}` : ''}
${args.jobDescriptionUrl ? `- Job spec: ${args.jobDescriptionUrl}` : ''}

WHO WE ARE:
- Company: ${args.senderCompany || 'Not specified'}
${args.senderFirstName ? `- Sender: ${args.senderFirstName}${args.senderTitle ? `, ${args.senderTitle}` : ''}` : ''}
${args.recruitment.companyContext ? `- About us: ${args.recruitment.companyContext}` : ''}
${args.calendlyUrl ? `- Booking link for an intro chat: ${args.calendlyUrl}` : ''}

INSTRUCTIONS:
- Open with ONE specific reason this candidate caught your attention (their title, a project, a stack from their LinkedIn). Do not generic-praise.
- State plainly that ${args.senderCompany || 'we'} ${args.senderCompany ? 'is' : 'are'} hiring a ${role}.
- Mention 2-3 of the must-have skills as the things you're looking for — frame as "the kind of work" not a checklist.
- Include 1 concrete reason this is a good role (compensation, autonomy, interesting tech, perk, mission).
- End with an invite to a 15-min intro call (use the booking link if provided, otherwise ask for a reply with a couple of times).
- Tone: ${args.tone}. Respect the candidate's time. No buzzwords. No "rockstar", no "ninja", no "fast-paced environment".
- 3-4 short paragraphs maximum. Plain text, \\n for line breaks. No "Hope this finds you well".

IMPORTANT: Return ONLY the JSON object. No markdown code fences. No preamble. No postamble. Your entire response must be valid JSON: { "subject": "...", "body": "..." }`;
}

export function buildDraftEmailUserPrompt(
  contact: Contact,
  company: Company | null,
  strategyHint?: string,
): string {
  const painPoints = company?.painPoints as Array<{ type: string; description: string }> | undefined;
  const rawData = (company?.rawData ?? {}) as Record<string, unknown>;
  const openPositions = rawData.openPositions as Array<{ title: string }> | undefined;
  const contactRaw = (contact.rawData ?? {}) as Record<string, unknown>;
  const yearsExperience = contactRaw.yearsExperience as number | undefined;
  const candidateSkills = (contact.skills as string[] | undefined) ?? (contactRaw.skills as string[] | undefined);

  const parts: string[] = [
    `RECIPIENT:`,
    `- Name: ${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
    contact.title ? `- Title: ${contact.title}` : '',
    contact.location ? `- Location: ${contact.location}` : '',
    contact.linkedinUrl ? `- LinkedIn: ${contact.linkedinUrl}` : '',
    candidateSkills?.length ? `- Skills: ${candidateSkills.slice(0, 8).join(', ')}` : '',
    yearsExperience ? `- Years of experience: ${yearsExperience}` : '',
    '',
  ];

  if (company) {
    parts.push(`RECIPIENT'S CURRENT COMPANY (context only — do NOT pitch them as a prospect):`);
    parts.push(`- Name: ${company.name}`);
    if (company.industry) parts.push(`- Industry: ${company.industry}`);
    if (company.size) parts.push(`- Size: ${company.size}`);
    if (company.domain) parts.push(`- Website: ${company.domain}`);
    if (company.techStack?.length) parts.push(`- Tech stack: ${company.techStack.join(', ')}`);
    if (company.websiteStatus) parts.push(`- Website status: ${company.websiteStatus}`);
    if (company.seoScore != null) parts.push(`- SEO score: ${company.seoScore}/100`);
    if (openPositions?.length) {
      parts.push(`- Open positions: ${openPositions.map(p => p.title).slice(0, 5).join(', ')}`);
    }
    if (painPoints?.length) {
      parts.push(`- Pain points detected:`);
      for (const pp of painPoints) {
        parts.push(`  * [${pp.type}] ${pp.description}`);
      }
    }
    if (company.description) parts.push(`- Description: ${company.description}`);
    parts.push('');
  }

  if (strategyHint) {
    parts.push(`USER HINT: ${strategyHint}`);
    parts.push('');
  }

  parts.push('Write the email now. Output JSON only: { "subject": "...", "body": "..." }');

  return parts.filter(Boolean).join('\n');
}
