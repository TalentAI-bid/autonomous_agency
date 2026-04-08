export interface GeneratedSearchQueries {
  companyWebsiteQueries: string[];
  linkedinCompanyQueries: string[];
  contactLinkedinQueries: string[];
  contactGithubQueries: string[];
  contactSocialQueries: string[];
  domainResolutionQueries: string[];
  reasoning: string;
}

export function buildSystemPrompt(): string {
  return `You are an expert web researcher who generates optimal search queries for finding companies and people online.

Given a company name and optional context (industry, domain, contact name, title), generate multiple search query variations that maximize the chance of finding the correct results.

STRATEGIES:
- For ambiguous company names (common words like "Apple", "Mercury", "Relay"), add qualifying terms like the industry, product type, or "startup" / "software company"
- For companies that may go by abbreviations or alternate names, generate queries for both the full name and likely abbreviations
- For companies with very generic names, try pairing the company name with the contact person's name or title
- For LinkedIn searches, try both exact-match quotes and partial matches
- NO site: directives. Our SearXNG instance returns 0 results when queries contain site: operators. Use the platform name as a keyword instead (e.g. "Acme linkedin profile" not "site:linkedin.com Acme").
- NO -site: exclusions. Unwanted domains are filtered programmatically downstream.
- Use AT MOST 2 quoted phrases per query — more quoted terms returns zero results
- Generate 1-2 queries per category, ordered from most specific to broadest

Return valid JSON matching the GeneratedSearchQueries interface.`;
}

export function buildUserPrompt(data: {
  companyName: string;
  domain?: string;
  contactName?: string;
  contactTitle?: string;
  industry?: string;
  additionalContext?: string;
}): string {
  const parts: string[] = [];
  parts.push(`COMPANY: ${data.companyName}`);
  if (data.domain) parts.push(`KNOWN DOMAIN: ${data.domain}`);
  if (data.contactName) parts.push(`CONTACT: ${data.contactName}`);
  if (data.contactTitle) parts.push(`TITLE: ${data.contactTitle}`);
  if (data.industry) parts.push(`INDUSTRY: ${data.industry}`);
  if (data.additionalContext) parts.push(`CONTEXT: ${data.additionalContext}`);

  return `Generate optimized search queries for finding this company and person online.

${parts.join('\n')}

Return JSON: {
  "companyWebsiteQueries": ["query1", "query2"],
  "linkedinCompanyQueries": ["query1"],
  "contactLinkedinQueries": ["query1", "query2"],
  "contactGithubQueries": ["query1"],
  "contactSocialQueries": ["query1"],
  "domainResolutionQueries": ["query1", "query2"],
  "reasoning": "Brief explanation of query strategy"
}`;
}
