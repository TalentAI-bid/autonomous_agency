export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a business development and prospect intelligence expert. Generate targeted search queries to find decision-makers and key contacts at organizations matching the target profile.

Adapt your search strategy to the TARGET TYPE described in the requirements:
- For companies/startups: LinkedIn company pages, team pages, funding news
- For universities/academic: department pages, research groups, faculty directories
- For government/NGO: program pages, initiative announcements, agency directories
- For consulting targets: pain-point discussions, RFP listings, industry forums

CRITICAL RULE — Location enforcement:
If locations are specified, EVERY query MUST include the location as a required term (not optional, not in parentheses with OR alternatives that omit it). Do not generate any query without the target location.

Always respond with valid JSON. Generate diverse queries to maximize coverage.

CRITICAL QUERY FORMAT RULES:
- Use AT MOST 1 quoted phrase per query. Too many quoted terms returns zero results from search engines.
- Good: "DevOps companies" France infrastructure
- Bad: "société" "ESN" "DevOps" "services" "France" "recrutement"
- Mix one quoted exact phrase with unquoted keywords for best coverage.
- NO site: directives. Keep queries simple and natural. Domain filtering is done in code.
- NO -site: exclusions. Unwanted domains are filtered programmatically.
- When targeting non-English countries, generate queries in BOTH the local language AND English for broader coverage.`;
  }

  return `You are a Boolean search and LinkedIn sourcing expert. Generate highly targeted search queries to find candidates matching specific requirements. Focus on queries that will return relevant LinkedIn profiles and professional pages.

CRITICAL RULE — Location enforcement:
If locations are specified, EVERY query MUST include the location as a required term (not optional, not in parentheses with OR alternatives that omit it). Do not generate any query without the target location. The location must appear as a mandatory keyword in the query string.

Always respond with valid JSON. Generate diverse queries to maximize coverage.

CRITICAL QUERY FORMAT RULES:
- Use AT MOST 1 quoted phrase per query. Too many quoted terms returns zero results from search engines.
- Mix one quoted exact phrase with unquoted keywords for best coverage.
- NO site: directives. Keep queries simple and natural. Domain filtering is done in code.
- When targeting non-English countries, generate queries in BOTH the local language AND English.`;
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

Generate queries for LinkedIn and web search. IMPORTANT: Use at most 1 quoted phrase per query — combine with unquoted keywords. NO site: directives — keep queries natural.

Strategy by target type:
- LinkedIn profiles: "[role]" [industry] [location] LinkedIn
- LinkedIn companies: [descriptor] [location] company LinkedIn
- Team/leadership pages: "[org type]" team OR leadership [location]
- Industry directories and association lists
- Academic: [topic] [department] [location] university OR faculty
- Government/NGO: [initiative] [topic] [location] government OR agency
- News: "[organization type]" funding OR launches [topic] [year]

Examples of GOOD queries (max 1 quoted phrase, no site:):
- "DevOps" France company LinkedIn
- "infrastructure companies" France cloud services
- ESN DevOps consulting France
- top DevOps firms Paris infrastructure

Examples of BAD queries (too many quotes or using site: — will return 0 results):
- "société" "ESN" "DevOps" "services" "France" "recrutement"
- "enterprise" "consulting" "cloud" "infrastructure" "Paris"
- site:linkedin.com/company/ "DevOps" France

Do NOT include:
- Generic blog or tutorial searches
- Job posting searches (unless looking for hiring signals)

Return JSON:
{
  "queries": [
    "\\"[target role]\\" [industry] [location] LinkedIn",
    "[descriptor] [location] company LinkedIn",
    "\\"[industry] companies\\" [location] [keyword]",
    "[industry] [keyword] firms [location]",
    ...
  ]
}

Make queries specific and varied. Use different keyword combinations and boolean operators. MATCH query style to the actual target type. For non-English countries, include queries in both the local language and English.`;
  }

  // Default: recruitment
  return `Generate 10-15 targeted search queries to find professionals matching these requirements:

TARGET ROLES: ${data.targetRoles.join(', ')}
REQUIRED SKILLS: ${data.requiredSkills.join(', ')}
${locationBlock}${!locationBlock ? `LOCATIONS: ${data.locations.join(', ')}\n` : ''}${data.industries?.length ? `INDUSTRIES: ${data.industries.join(', ')}` : ''}
${data.keywords?.length ? `KEYWORDS: ${data.keywords.join(', ')}` : ''}

Generate queries for LinkedIn and web search. IMPORTANT: No site: directives — keep queries natural. Max 1 quoted phrase per query.

Include:
- LinkedIn profile searches (use "LinkedIn" as keyword, not site:)
- Professional directory searches
- GitHub/portfolio searches for technical roles
- Company page searches

Return JSON:
{
  "queries": [
    "\\"senior react developer\\" London LinkedIn",
    "typescript nodejs engineer London portfolio",
    ...
  ]
}

Make queries specific and varied. Use different keyword combinations, boolean operators (AND, OR, NOT). Keep queries simple and natural.`;
}
