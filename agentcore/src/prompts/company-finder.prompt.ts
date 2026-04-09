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

export function buildMissionAnalyzerSystemPrompt(availableSiteKeys: string[]): string {
  const siteList = availableSiteKeys.join(', ');
  return `You analyze a sales / recruitment mission and decide which job boards or company databases to scrape. Return STRICT JSON with this shape:

{
  "missionType": "recruitment" | "b2b_sales" | "startup_sales",
  "searchKeywords": { "en": string[], "local": string[] },
  "targetCountry": "<ISO 3166-1 alpha-2 lowercase, e.g. 'fr' 'gb' 'us' 'de'>",
  "targetCities": string[],
  "sitesToCrawl": string[],
  "reasoning": string
}

CRITICAL RULES FOR \`searchKeywords\`:
- These keywords are typed VERBATIM into a job board's search input box (or a company database's keyword field). They are NOT Google queries.
- Each keyword must be a SHORT JOB TITLE or ROLE NAME of 1–4 words MAX.
- Maximum 6 keywords total per language array.
- \`en\` = English variants. \`local\` = native-language variants for \`targetCountry\` (use the country's primary language: fr→French, de→German, es→Spanish, it→Italian, nl→Dutch, pt→Portuguese, etc). If targetCountry is anglophone, leave \`local\` empty.
- For B2B / startup sales missions, keywords are still ROLES the buyer is hiring for (because that hiring activity is the *signal* that they have budget + pain).

GOOD examples:
  ✓ ["devops engineer", "site reliability engineer", "SRE", "cloud architect"]
  ✓ ["account executive", "BDR", "sales development representative"]
  ✓ ["product designer", "UX designer", "figma designer"]
  local examples (fr): ["ingenieur devops", "architecte cloud"]
  local examples (de): ["devops ingenieur", "cloud architekt"]

BAD examples (NEVER produce these):
  ✗ "Best French Software Companies for 2025"          ← article title, not a job title
  ✗ "Top 10 SaaS firms hiring DevOps in Paris"         ← long sentence
  ✗ "Category:Software companies of France"            ← Wikipedia category
  ✗ "List of fintech companies"                         ← listicle phrasing
  ✗ "1,380+ React jobs"                                 ← search-result count
  ✗ "Find me companies that need React developers"     ← natural-language sentence
  ✗ "best devops engineer 2025"                         ← contains year + superlative
  ✗ any keyword > 4 words, > 60 chars, or containing the word "best", "top", "largest", "list of", or any 4-digit year between 2020 and 2039

CRITICAL RULES FOR \`sitesToCrawl\`:
- Each entry MUST be a key from this list (the agent will look it up in its in-process SITE_CONFIGS registry and refuse to use any unlisted key):
  ${siteList}
- These are REAL job boards / company databases that the agent will scrape DIRECTLY via Crawl4AI. The agent does NOT and will not perform Google searches for primary discovery — it goes to these sites and uses their built-in search.
- Pick 3–6 sites maximum that match \`targetCountry\` (i.e., the site's \`countries\` field includes targetCountry or 'all').
- For recruitment missions: prefer job boards (welcometothejungle, freework, linkedin_jobs, glassdoor, stepstone, dice, jobbank_ca, etc).
- For b2b_sales / startup_sales: include BOTH job boards (signals of hiring = budget + pain) AND company databases (societe_com, uk_companies_house, northdata, einforma, ariregister).

Return JSON ONLY — no prose, no markdown fences, no commentary.

EXAMPLE RESPONSE (this is the EXACT shape you must return — return an OBJECT, never a plain array):
{
  "missionType": "recruitment",
  "searchKeywords": {
    "en": ["devops engineer", "SRE", "cloud engineer"],
    "local": ["ingenieur devops", "architecte cloud"]
  },
  "targetCountry": "fr",
  "targetCities": ["Paris", "Lyon"],
  "sitesToCrawl": ["welcometothejungle", "freework", "linkedin_jobs", "glassdoor"],
  "reasoning": "Recruitment mission targeting French companies hiring DevOps roles"
}

DO NOT return a plain array like ["devops engineer", "SRE"]. DO NOT return only keywords. Return the FULL JSON object with ALL fields shown above.`;
}

export function buildMissionAnalyzerUserPrompt(
  missionContext: {
    mission: string;
    locations?: string[];
    industries?: string[];
    targetRoles?: string[];
    keywords?: string[];
  },
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
  lines.push('Return the JSON object described in the system prompt.');
  return lines.join('\n');
}

// ── Extraction Prompts ─────────────────────────────────────────────────────

const DISALLOWED_COMPANY_NAMES_BLOCK = `
DISALLOWED COMPANY NAMES — never extract these as a \`companyName\`:
- The job board itself (Welcome to the Jungle, Indeed, LinkedIn, Glassdoor, etc.)
- Article titles or listicle headlines:
  ✗ "Best French Software Companies for 2025"
  ✗ "Top 10 SaaS Firms Hiring DevOps"
  ✗ "Category:Software companies of France"
  ✗ anything starting with "Category:", "List of", "Best ", "Top ", "Largest "
- Wikipedia categories or directory headers
- Sentences > 6 words or strings > 60 characters
- Strings containing a 4-digit year (2020–2039)
- Strings containing "1,380+", "500+", "10K+" etc. (these are job-count badges, not company names)
- Search-result counts ("1,380 jobs", "500 results")
- Free-form descriptions ("a fast-growing fintech in Paris")

If you cannot identify a clear, short, real company name for a row, SKIP that row. It is far better to extract 5 real companies than 50 junk rows.`;

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
${DISALLOWED_COMPANY_NAMES_BLOCK}

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
${DISALLOWED_COMPANY_NAMES_BLOCK}

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
4. Limit to at most 30 listings.
${DISALLOWED_COMPANY_NAMES_BLOCK}`;
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
