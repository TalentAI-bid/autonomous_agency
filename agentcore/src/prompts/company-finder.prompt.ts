/**
 * Company Finder Prompts — used by CompanyFinderAgent.
 *
 * Two phases:
 *   1. Mission analysis — given a mission context, the LLM picks which sites
 *      from SITE_CONFIGS to crawl, and produces keyword lists in EN + local.
 *   2. Extraction — given the markdown of a single page, the LLM extracts
 *      structured job listings (job_board) or companies (company_database)
 *      or parses a JSON API payload.
 *
 * Both phases return strict JSON. Callers use extractJSON<T>() to parse.
 */

// ── Types returned by the LLM ──────────────────────────────────────────────

export interface JobListing {
  /** The hiring company (NOT the job board itself). */
  companyName: string;
  /** Exact job title as posted. */
  jobTitle: string;
  /** "City, Country" or as best as can be determined. */
  jobLocation: string;
  /** Employer's own website domain if visible, else empty string. */
  companyDomain: string;
  /** First ~200 chars of the job description. */
  description: string;
  /** Optional 0-100 relevance score. */
  relevanceScore?: number;
}

export interface CompanyEntry {
  name: string;
  domain: string;
  industry: string;
  location: string;
  size: string;
  revenue: string;
  description: string;
}

export interface MissionAnalysis {
  missionType: 'recruitment' | 'b2b_sales' | 'startup_sales';
  searchKeywords: {
    en: string[];
    local: string[];
  };
  /** ISO 3166-1 alpha-2 (lowercase). */
  targetCountry: string;
  targetCities: string[];
  /** Keys from SITE_CONFIGS. Validated by the agent. */
  sitesToCrawl: string[];
  reasoning: string;
}

export interface JobBoardExtractionResult {
  listings: JobListing[];
}

export interface CompanyDatabaseExtractionResult {
  companies: CompanyEntry[];
}

// ── Mission Analyzer ───────────────────────────────────────────────────────

const MISSION_ANALYZER_SYSTEM = `You analyze a sales/recruitment mission and determine which websites to scrape. Given the mission context, you return JSON with this exact shape:

{
  "missionType": "recruitment" | "b2b_sales" | "startup_sales",
  "searchKeywords": {
    "en": ["english keyword 1", ...],
    "local": ["local-language keyword 1", ...]
  },
  "targetCountry": "<ISO 3166-1 alpha-2 lowercase, e.g. 'fr' 'gb' 'us' 'de'>",
  "targetCities": ["city 1", ...],
  "sitesToCrawl": ["siteKey1", "siteKey2", ...],
  "reasoning": "brief explanation"
}

RULES:
- For recruitment missions → pick job boards matching the target country.
- For b2b_sales missions → pick BOTH company databases AND job boards (job postings reveal hiring intent and tech stack).
- For startup_sales missions → prefer Crunchbase-style company databases + job boards covering startups.
- Only select sites whose 'countries' field includes the target country, OR whose 'countries' contains 'all'.
- Select 4-6 sites maximum per mission. Quality over quantity.
- searchKeywords.en should be 3-6 English-language keywords.
- searchKeywords.local should be 3-6 keywords in the primary language of the target country (use English if no local language applies).
- targetCities can be empty if the mission is country-wide.
- Output JSON only — no prose, no markdown fences.`;

export function buildMissionAnalyzerSystemPrompt(): string {
  return MISSION_ANALYZER_SYSTEM;
}

export function buildMissionAnalyzerUserPrompt(
  missionContext: {
    mission: string;
    locations?: string[];
    industries?: string[];
    targetRoles?: string[];
    keywords?: string[];
  },
  availableSiteKeys: string[],
): string {
  const lines: string[] = [];
  lines.push(`Mission: ${missionContext.mission}`);
  if (missionContext.locations?.length) {
    lines.push(`Target locations: ${missionContext.locations.join(', ')}`);
  }
  if (missionContext.industries?.length) {
    lines.push(`Target industries: ${missionContext.industries.join(', ')}`);
  }
  if (missionContext.targetRoles?.length) {
    lines.push(`Target roles: ${missionContext.targetRoles.join(', ')}`);
  }
  if (missionContext.keywords?.length) {
    lines.push(`Hint keywords: ${missionContext.keywords.join(', ')}`);
  }
  lines.push('');
  lines.push(`Available site keys (you may ONLY pick from this list): ${availableSiteKeys.join(', ')}`);
  lines.push('');
  lines.push('Return the JSON object described in the system prompt.');
  return lines.join('\n');
}

// ── Extraction Prompts ─────────────────────────────────────────────────────

function buildJobBoardExtractionSystem(keywords: string[]): string {
  return `You extract job listings from a job board page. For each listing in the page, return:

{
  "listings": [
    {
      "companyName": "<the EMPLOYER, NOT the job board>",
      "jobTitle": "<exact job title as posted>",
      "jobLocation": "<city + country, best effort>",
      "companyDomain": "<employer's website domain if visible, else \\"\\">",
      "description": "<first 200 characters of the job description>",
      "relevanceScore": <0-100, optional>
    }
  ]
}

HARD RULES:
1. Never extract the job board itself as a company (e.g., never output "Welcome to the Jungle", "LinkedIn", "Indeed", "Glassdoor", "StepStone", "Free-Work", "Dice" as companyName).
2. If the company name is unclear or missing, SKIP that listing entirely.
3. Only extract listings relevant to the keywords below. If a listing is clearly off-topic, skip it.
4. Output JSON only — no prose, no markdown fences.
5. Limit to at most 30 listings per page.

Relevant keywords: ${keywords.join(', ')}`;
}

function buildCompanyDatabaseExtractionSystem(
  keywords: string[],
  missionContext: { industries?: string[]; targetCountry?: string },
): string {
  const industries = missionContext.industries?.length
    ? missionContext.industries.join(', ')
    : '(any)';
  const country = missionContext.targetCountry ?? '(any)';
  return `You extract companies from a business directory page. For each company entry, return:

{
  "companies": [
    {
      "name": "<official company name>",
      "domain": "<company website if visible, else \\"\\">",
      "industry": "<sector>",
      "location": "<city + country>",
      "size": "<employee count if shown, else \\"\\">",
      "revenue": "<if shown, else \\"\\">",
      "description": "<brief description>"
    }
  ]
}

HARD RULES:
1. Only include companies matching target industries: ${industries}
2. Only include companies in country: ${country}
3. If a company name is unclear, SKIP that entry.
4. Output JSON only — no prose, no markdown fences.
5. Limit to at most 30 companies per page.

Hint keywords: ${keywords.join(', ')}`;
}

function buildJsonApiExtractionSystem(keywords: string[]): string {
  return `The content below is a JSON document from a job API (e.g., RemoteOK). Parse it and return job listings in this exact shape:

{
  "listings": [
    {
      "companyName": "<the EMPLOYER>",
      "jobTitle": "<exact job title>",
      "jobLocation": "<city + country, best effort>",
      "companyDomain": "<employer website if available, else \\"\\">",
      "description": "<first 200 chars of job description>",
      "relevanceScore": <0-100, optional>
    }
  ]
}

HARD RULES:
1. Skip listings irrelevant to: ${keywords.join(', ')}
2. If companyName is unclear, skip the listing.
3. Output JSON only — no prose, no markdown fences.
4. Limit to at most 30 listings.`;
}

export function buildExtractionSystemPrompt(
  type: 'job_board' | 'company_database' | 'json_api',
  keywords: string[],
  missionContext: { industries?: string[]; targetCountry?: string } = {},
): string {
  switch (type) {
    case 'job_board':
      return buildJobBoardExtractionSystem(keywords);
    case 'company_database':
      return buildCompanyDatabaseExtractionSystem(keywords, missionContext);
    case 'json_api':
      return buildJsonApiExtractionSystem(keywords);
  }
}

export function buildExtractionUserPrompt(p: {
  url: string;
  siteName: string;
  content: string;
}): string {
  // Truncate to keep prompt sane
  const content = p.content.length > 12000 ? p.content.slice(0, 12000) + '\n\n[truncated]' : p.content;
  return `Source: ${p.siteName}
URL: ${p.url}

Page content:
\`\`\`
${content}
\`\`\`

Extract entries per the system prompt. Return JSON only.`;
}
