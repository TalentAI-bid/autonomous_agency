export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a business development expert specialized in finding companies that are ACTIVELY HIRING for specific roles. Your queries must target JOB POSTINGS, CAREER PAGES, and HIRING ANNOUNCEMENTS — not general company pages.

CRITICAL RULE — Every query must have ALL THREE:
1. LOCATION: The exact country or city from the target locations. No exceptions.
2. ROLE/SKILL: At least one specific role or skill keyword from the mission.
3. HIRING INTENT: At least one hiring keyword: "hiring", "job", "jobs", "career", "careers", "recrutement", "offre emploi", "poste", "CDI", "nous recrutons", "rejoignez-nous", "join our team", "we are hiring".

A query like "DevOps companies France" is FORBIDDEN — it must be "DevOps hiring France" or "offre emploi DevOps France".

Always respond with valid JSON. Generate diverse queries to maximize coverage.

CRITICAL QUERY FORMAT RULES:
- Use AT MOST 1 quoted phrase per query. Too many quoted terms returns zero results from search engines.
- Good: "offre emploi DevOps" France CDI
- Bad: "société" "ESN" "DevOps" "services" "France" "recrutement"
- Mix one quoted exact phrase with unquoted keywords for best coverage.
- NO site: directives. Keep queries simple and natural. Domain filtering is done in code.
- NO -site: exclusions. Unwanted domains are filtered programmatically.
- When targeting non-English countries, generate at LEAST HALF the queries in the LOCAL LANGUAGE.
  For France: use "recrutement", "offre emploi", "CDI", "poste", "nous recrutons", "ingénieur".
- Target country-specific job boards by name: Welcome to the Jungle, Free-Work, APEC, Indeed.fr for France.`;
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
    return `Generate 10-15 targeted search queries to find COMPANIES ACTIVELY HIRING for roles matching these requirements:

TARGET ROLES / CONTACTS: ${data.targetRoles.join(', ')}
TARGET ORGANIZATION ATTRIBUTES: ${data.requiredSkills.join(', ')}
${locationBlock}${!locationBlock ? `LOCATIONS: ${data.locations.join(', ')}\n` : ''}${data.industries?.length ? `INDUSTRIES / SECTORS: ${data.industries.join(', ')}` : ''}
${data.keywords?.length ? `KEYWORDS: ${data.keywords.join(', ')}` : ''}

CRITICAL: Every query MUST contain a HIRING INTENT keyword ("hiring", "job", "careers", "recrutement", "offre emploi", "CDI", "poste", "nous recrutons"). We want companies with OPEN POSITIONS, not just companies that exist.

Generate queries targeting job postings and career pages. IMPORTANT: Use at most 1 quoted phrase per query. NO site: directives.

Strategy — focus on HIRING SIGNALS:
- Job board searches: "[role]" hiring [location] LinkedIn jobs
- Career pages: "[role]" careers [location]
- French job boards: "offre emploi [role]" [location] (for French markets)
- Hiring announcements: "[role]" "we are hiring" OR "join our team" [location]
- Local language: "recrutement [role]" [location] CDI (for French markets)

Examples of GOOD queries (hiring intent + location + role):
- "DevOps engineer" hiring France LinkedIn jobs
- "offre emploi DevOps" Paris CDI
- Welcome to the Jungle DevOps France
- "ingénieur DevOps" recrutement France
- DevOps careers France "join our team"
- Free-Work DevOps France poste

Examples of BAD queries (NO hiring intent — will find generic company pages):
- "DevOps" France company LinkedIn (no hiring keyword)
- "infrastructure companies" France cloud services (no hiring keyword)
- ESN DevOps consulting France (no hiring keyword)
- site:linkedin.com/company/ "DevOps" France (site: directive)

Do NOT include:
- Generic blog or tutorial searches
- Company directory searches without hiring intent
- Queries without a hiring keyword

Return JSON:
{
  "queries": [
    "\\"[role]\\" hiring [location] LinkedIn jobs",
    "\\"offre emploi [role]\\" [location] CDI",
    "[role] careers [location] \\"join our team\\"",
    ...
  ]
}

Make queries specific and varied. For non-English countries, generate at LEAST HALF the queries in the local language. For France specifically: use recrutement, offre emploi, CDI, poste, ingénieur, nous recrutons.`;
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
