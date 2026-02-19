export function buildSystemPrompt(): string {
  return `You are a Boolean search and LinkedIn sourcing expert. Generate highly targeted search queries to find candidates matching specific requirements. Focus on queries that will return relevant LinkedIn profiles and professional pages.

Always respond with valid JSON. Generate diverse queries to maximize coverage.`;
}

export function buildUserPrompt(data: {
  targetRoles: string[];
  requiredSkills: string[];
  locations: string[];
  industries?: string[];
  keywords?: string[];
}): string {
  return `Generate 10-15 targeted search queries to find professionals matching these requirements:

TARGET ROLES: ${data.targetRoles.join(', ')}
REQUIRED SKILLS: ${data.requiredSkills.join(', ')}
LOCATIONS: ${data.locations.join(', ')}
${data.industries?.length ? `INDUSTRIES: ${data.industries.join(', ')}` : ''}
${data.keywords?.length ? `KEYWORDS: ${data.keywords.join(', ')}` : ''}

Generate queries for LinkedIn and web search. Include:
- LinkedIn profile searches (site:linkedin.com/in/)
- Professional directory searches
- GitHub/portfolio searches for technical roles
- Company page searches

Return JSON:
{
  "queries": [
    "site:linkedin.com/in/ (senior react developer OR \"react engineer\") (London OR Remote)",
    "site:linkedin.com/in/ typescript nodejs 5 years experience",
    ...
  ]
}

Make queries specific and varied. Use different keyword combinations, boolean operators (AND, OR, NOT), and quotation marks for exact phrases.`;
}
