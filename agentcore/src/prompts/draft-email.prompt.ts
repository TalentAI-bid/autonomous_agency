import type { MasterAgent, Contact, Company } from '../db/schema/index.js';

export function buildDraftEmailSystemPrompt(
  masterAgent: MasterAgent | null,
  company: Company | null,
): string {
  const config = (masterAgent?.config as Record<string, unknown>) ?? {};
  const senderCompany = (config.companyName as string) ?? (config.senderCompanyName as string) ?? '';
  const services = (config.services as string[]) ?? [];
  const valueProp = (config.valueProp as string) ?? (config.valueProposition as string) ?? '';
  const strategy = config.salesStrategy as Record<string, unknown> | undefined;
  const angles = (strategy?.emailStrategy as Record<string, unknown>)?.angles as string[] | undefined;
  const pipelineCtx = config.pipelineContext as Record<string, unknown> | undefined;
  const salesCtx = pipelineCtx?.sales as Record<string, unknown> | undefined;
  const products = (salesCtx?.products as Array<{ name: string; description?: string; keyFeatures?: string[]; painPointsSolved?: string[] }>) ?? [];

  let productsSection = '';
  if (products.length > 0) {
    const lines = products.slice(0, 3).map((p) => {
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
- Company: ${senderCompany || 'Not specified'}
- Services: ${services.join(', ') || 'Not specified'}
- Value proposition: ${valueProp || 'Not specified'}
${angles?.length ? `- Outreach angles: ${angles.join('; ')}` : ''}
${productsSection}

INSTRUCTIONS:
- Write a personalized cold email that references the prospect company's specific pain points, signals, and context
- Use the sender's value proposition naturally — do not be salesy or pushy
- Keep it concise: 3-4 short paragraphs maximum
- End with a clear CTA (book a call, reply to discuss, etc.)
- Tone: professional but conversational, like a peer reaching out
- Do NOT use generic filler ("I hope this finds you well")
- Output ONLY valid JSON: { "subject": "...", "body": "..." }
- The body should be plain text (not HTML), with \\n for line breaks`;
}

export function buildDraftEmailUserPrompt(
  contact: Contact,
  company: Company | null,
  strategyHint?: string,
): string {
  const painPoints = company?.painPoints as Array<{ type: string; description: string }> | undefined;
  const rawData = (company?.rawData ?? {}) as Record<string, unknown>;
  const openPositions = rawData.openPositions as Array<{ title: string }> | undefined;

  const parts: string[] = [
    `PROSPECT CONTACT:`,
    `- Name: ${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
    contact.title ? `- Title: ${contact.title}` : '',
    contact.linkedinUrl ? `- LinkedIn: ${contact.linkedinUrl}` : '',
    '',
  ];

  if (company) {
    parts.push(`PROSPECT COMPANY:`);
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
