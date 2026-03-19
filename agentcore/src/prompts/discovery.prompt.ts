export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a business development and prospect intelligence expert. Generate targeted search queries to find decision-makers and key contacts at organizations matching the target profile.

Adapt your search strategy to the TARGET TYPE described in the requirements:
- For companies/startups: LinkedIn company pages, team pages, funding news
- For universities/academic: site:.edu, site:.ac.uk, department pages, research groups
- For government/NGO: site:.gov, site:.org, program pages, initiative announcements
- For consulting targets: pain-point discussions, RFP listings, industry forums

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
    return `Generate 10-15 targeted search queries to find decision-makers and organizations matching these requirements:

TARGET ROLES / CONTACTS: ${data.targetRoles.join(', ')}
TARGET ORGANIZATION ATTRIBUTES: ${data.requiredSkills.join(', ')}
${locationBlock}${!locationBlock ? `LOCATIONS: ${data.locations.join(', ')}\n` : ''}${data.industries?.length ? `INDUSTRIES / SECTORS: ${data.industries.join(', ')}` : ''}
${data.keywords?.length ? `KEYWORDS: ${data.keywords.join(', ')}` : ''}

Generate queries for LinkedIn and web search. Adapt the search strategy to the target type:
- LinkedIn profile searches: site:linkedin.com/in/ "[role]" "[industry]" [location]
- LinkedIn organization searches: site:linkedin.com/company/ "[descriptor]" [location]
- Organization team/leadership pages: "[org name]" team OR leadership OR about-us
- Industry directories and association lists
- Academic institutions: site:.edu OR site:.ac.uk OR site:.ac.fr "[topic]" "[department]"
- Government/NGO: site:.gov OR site:.org "[initiative]" "[topic]"
- Conference speaker/attendee lists
- News and announcements: "[organization type]" "launches" OR "announces" [topic] [year]

Do NOT include:
- Generic blog or tutorial searches
- Job posting searches (unless looking for hiring signals)

Return JSON:
{
  "queries": [
    "site:linkedin.com/in/ \\"[target role]\\" \\"[industry]\\" [location]",
    "site:linkedin.com/company/ \\"[descriptor]\\" [location]",
    ...
  ]
}

Make queries specific and varied. Use different keyword combinations, boolean operators (AND, OR, NOT), and quotation marks for exact phrases. MATCH query style to the actual target type.`;
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
