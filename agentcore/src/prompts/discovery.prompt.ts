export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a B2B sales intelligence and lead generation expert. Generate targeted search queries to find decision-makers and key stakeholders at companies matching the target profile. Focus on LinkedIn profiles of people in leadership/purchasing roles, company team pages, and company profiles.

CRITICAL RULE — Location enforcement:
If locations are specified, EVERY query MUST include the location as a required term (not optional, not in parentheses with OR alternatives that omit it). Do not generate any query without the target location.

Always respond with valid JSON. Generate diverse queries to maximize coverage.`;
  }

  return `You are a Boolean search and LinkedIn sourcing expert. Generate highly targeted search queries to find candidates matching specific requirements. Focus on queries that will return relevant LinkedIn profiles and professional pages.

CRITICAL RULE — Location enforcement:
If locations are specified, EVERY query MUST include the location as a required term (not optional, not in parentheses with OR alternatives that omit it). Do not generate any query without the target location. The location must appear as a mandatory keyword in the query string.

Always respond with valid JSON. Generate diverse queries to maximize coverage.`;
}

export function buildUserPrompt(data: {
  targetRoles: string[];
  requiredSkills: string[];
  locations: string[];
  industries?: string[];
  keywords?: string[];
  useCase?: string;
}): string {
  const locationBlock = data.locations.length > 0
    ? `\nMANDATORY LOCATION FILTER: ${data.locations.join(', ')}
⚠️ Every single query below MUST contain "${data.locations[0]}" (or the equivalent location term). Queries missing the location will be rejected.\n`
    : '';

  if (data.useCase === 'sales') {
    return `Generate 10-15 targeted search queries to find decision-makers and companies matching these requirements:

TARGET DECISION-MAKER ROLES: ${data.targetRoles.join(', ')}
TARGET COMPANY ATTRIBUTES: ${data.requiredSkills.join(', ')}
${locationBlock}${!locationBlock ? `LOCATIONS: ${data.locations.join(', ')}\n` : ''}${data.industries?.length ? `INDUSTRIES: ${data.industries.join(', ')}` : ''}
${data.keywords?.length ? `PRODUCT/SOLUTION KEYWORDS: ${data.keywords.join(', ')}` : ''}

Generate queries for LinkedIn and web search. Include:
- LinkedIn profile searches for decision-makers (site:linkedin.com/in/ "CTO" OR "VP Engineering" "SaaS" London)
- LinkedIn company searches (site:linkedin.com/company/ fintech series-B)
- Company team/leadership pages ("company name" team OR leadership OR about-us)
- Industry directory searches
- Conference speaker/attendee lists

Do NOT include:
- GitHub or StackOverflow searches
- Job posting searches
- Portfolio or blog searches

Return JSON:
{
  "queries": [
    "site:linkedin.com/in/ \\"CTO\\" OR \\"VP Engineering\\" \\"SaaS\\" London",
    "site:linkedin.com/company/ fintech series-B London",
    ...
  ]
}

Make queries specific and varied. Use different keyword combinations, boolean operators (AND, OR, NOT), and quotation marks for exact phrases.`;
  }

  // Default: recruitment
  return `Generate 10-15 targeted search queries to find professionals matching these requirements:

TARGET ROLES: ${data.targetRoles.join(', ')}
REQUIRED SKILLS: ${data.requiredSkills.join(', ')}
${locationBlock}${!locationBlock ? `LOCATIONS: ${data.locations.join(', ')}\n` : ''}${data.industries?.length ? `INDUSTRIES: ${data.industries.join(', ')}` : ''}
${data.keywords?.length ? `KEYWORDS: ${data.keywords.join(', ')}` : ''}

Generate queries for LinkedIn and web search. Include:
- LinkedIn profile searches (site:linkedin.com/in/)
- Professional directory searches
- GitHub/portfolio searches for technical roles
- Company page searches

Return JSON:
{
  "queries": [
    "site:linkedin.com/in/ (senior react developer OR \\"react engineer\\") (London OR Remote)",
    "site:linkedin.com/in/ typescript nodejs 5 years experience",
    ...
  ]
}

Make queries specific and varied. Use different keyword combinations, boolean operators (AND, OR, NOT), and quotation marks for exact phrases.`;
}
