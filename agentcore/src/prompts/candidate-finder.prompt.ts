/**
 * Candidate Finder Prompts — used by CandidateFinderAgent.
 *
 * Two phases, parallel to company-finder:
 *   1. Mission analysis — given a recruitment mission, the LLM picks which
 *      profile sources (keys from SITE_CONFIGS where profileType is set) to
 *      crawl, and produces target skills + programming languages + country.
 *   2. Extraction — one prompt per source type:
 *      - linkedin_profile_serp: parse Brave/DuckDuckGo result markdown
 *      - github_api: parse GitHub Search API items[]
 *      - stackoverflow_api: parse Stack Exchange Users API items[]
 *      - devto: parse dev.to ?filters=class_name:User user cards
 *
 * Both phases return strict JSON. Callers use extractJSON<T>() to parse.
 */

// ── Types returned by the LLM ──────────────────────────────────────────────

export interface CandidateProfile {
  fullName: string;
  headline?: string;
  currentTitle?: string;
  currentCompany?: string;
  location?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  twitterUrl?: string;
  websiteUrl?: string;
  email?: string;
  skills: string[];
  experienceYears?: number;
  bio?: string;
  /** Optional 0-100 relevance score. */
  relevanceScore?: number;
}

export interface CandidateExtractionResult {
  profiles: CandidateProfile[];
}

export interface CandidateMissionAnalysis {
  missionType:
    | 'developer_recruitment'
    | 'designer_recruitment'
    | 'sales_recruitment'
    | 'general_recruitment';
  targetRole: string;
  experienceLevel?: 'junior' | 'mid' | 'senior' | 'lead' | 'any';
  targetSkills: string[];
  /** Lowercase canonical names: javascript / typescript / python / rust / go / java / etc. */
  programmingLanguages?: string[];
  /** ISO 3166-1 alpha-2 lowercase. */
  targetCountry?: string;
  targetCities?: string[];
  /** Keys from SITE_CONFIGS where profileType is set. Validated by the agent. */
  sourcesToCrawl: string[];
  reasoning: string;
}

export type ProfileSourceType =
  | 'linkedin_profile_serp'
  | 'github_api'
  | 'stackoverflow_api'
  | 'devto';

// ── Mission Analyzer ───────────────────────────────────────────────────────

const MISSION_ANALYZER_SYSTEM_TEMPLATE = `You analyze a recruitment mission and decide which profile sources to scrape to find individual candidates. You return JSON with this exact shape:

{
  "missionType": "developer_recruitment" | "designer_recruitment" | "sales_recruitment" | "general_recruitment",
  "targetRole": "<the role being hired for>",
  "experienceLevel": "junior" | "mid" | "senior" | "lead" | "any",
  "targetSkills": ["skill 1", "skill 2", ...],
  "programmingLanguages": ["javascript", "python", ...],
  "targetCountry": "<ISO 3166-1 alpha-2 lowercase>",
  "targetCities": ["city 1", ...],
  "sourcesToCrawl": ["sourceKey1", "sourceKey2", ...],
  "reasoning": "brief explanation"
}

RULES:
- For developer_recruitment → include github_api AND stackoverflow_api, plus linkedin profile SERPs. Set programmingLanguages to LOWERCASE canonical names (js→javascript, ts→typescript, py→python, rb→ruby, go→go, rs→rust, cs→csharp). Only include languages actually relevant to the role.
- For designer_recruitment → skip github_api and stackoverflow_api. Prefer linkedin profile SERPs, plus devto if the role is front-end adjacent.
- For sales_recruitment → linkedin profile SERPs ONLY.
- For general_recruitment → linkedin profile SERPs, plus devto if the role is tech-adjacent.
- Pick 3-5 sources maximum.
- Only choose sources whose profileType matches the role family OR is 'general'.
- targetCountry must be lowercase ISO alpha-2 (e.g. 'fr', 'gb', 'us', 'de'). Use 'all' or omit if the mission is global.
- targetCities can be empty if the mission is country-wide.
- Output JSON only — no prose, no markdown fences.

Available profile sources (you may ONLY pick from this list): {{availableProfileSources}}`;

export function buildCandidateMissionAnalyzerSystemPrompt(
  availableProfileSources: string[],
): string {
  return MISSION_ANALYZER_SYSTEM_TEMPLATE.replace(
    '{{availableProfileSources}}',
    availableProfileSources.join(', '),
  );
}

export function buildCandidateMissionAnalyzerUserPrompt(missionContext: {
  mission: string;
  locations?: string[];
  targetRoles?: string[];
  requiredSkills?: string[];
  experienceLevel?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Mission: ${missionContext.mission}`);
  if (missionContext.targetRoles?.length) {
    lines.push(`Target roles: ${missionContext.targetRoles.join(', ')}`);
  }
  if (missionContext.requiredSkills?.length) {
    lines.push(`Required skills: ${missionContext.requiredSkills.join(', ')}`);
  }
  if (missionContext.experienceLevel) {
    lines.push(`Experience level: ${missionContext.experienceLevel}`);
  }
  if (missionContext.locations?.length) {
    lines.push(`Target locations: ${missionContext.locations.join(', ')}`);
  }
  lines.push('');
  lines.push('Return the JSON object described in the system prompt.');
  return lines.join('\n');
}

// ── Extraction Prompts ─────────────────────────────────────────────────────

function buildLinkedInSerpExtractionSystem(
  targetSkills: string[],
  targetRole: string,
): string {
  return `You extract LinkedIn profile snippets from a Brave or DuckDuckGo search results page. Each result row typically has: Name • Title @ Company • Location, plus a linkedin.com/in/{slug} URL.

For each profile, return:

{
  "profiles": [
    {
      "fullName": "<full name>",
      "headline": "<first line / tagline if present>",
      "currentTitle": "<job title if parseable from snippet>",
      "currentCompany": "<company if parseable from snippet>",
      "location": "<city + country if present>",
      "linkedinUrl": "https://www.linkedin.com/in/{slug}",
      "skills": ["skill 1", ...],
      "relevanceScore": <0-100, optional>
    }
  ]
}

HARD RULES:
1. Only accept linkedin.com/in/ URLs. Skip linkedin.com/company/, linkedin.com/posts/, linkedin.com/pub/dir/.
2. Skip any row without a linkedin.com/in/ URL.
3. Normalize linkedinUrl to https://www.linkedin.com/in/{slug} (strip tracking params).
4. skills should be an inferred subset of: ${targetSkills.join(', ')} (include only skills mentioned in the snippet).
5. Output JSON only — no prose, no markdown fences.
6. Limit to at most 30 profiles per page.

Target role: ${targetRole}`;
}

function buildGitHubApiExtractionSystem(
  targetSkills: string[],
  targetRole: string,
): string {
  return `The content below is a GitHub Search Users API JSON payload with an items[] array. Each item is a user with fields like: login, html_url, name (optional), bio (optional), location (optional), company (optional — sometimes prefixed with '@').

For each user item, return:

{
  "profiles": [
    {
      "fullName": "<name || login>",
      "headline": "<bio if present, else empty>",
      "currentTitle": "<if parseable from bio>",
      "currentCompany": "<company stripped of leading '@'>",
      "location": "<location if present>",
      "githubUrl": "<html_url>",
      "skills": ["language 1", ...],
      "bio": "<bio>",
      "relevanceScore": <0-100, optional>
    }
  ]
}

HARD RULES:
1. fullName = name if present, else login.
2. If company starts with '@', strip the '@'.
3. Skip organization accounts (login contains '-org', '-team', '-bot', or 'bot' suffix).
4. skills should be inferred from bio + any language hints, matching: ${targetSkills.join(', ')}
5. Output JSON only — no prose, no markdown fences.

Target role: ${targetRole}`;
}

function buildStackOverflowApiExtractionSystem(
  targetSkills: string[],
  targetRole: string,
): string {
  return `The content below is a Stack Exchange Users API JSON payload (filter=!nOedRLbqzB) with an items[] array. Each user has fields like: display_name, link (profile URL), location, about_me (HTML), website_url.

For each user, return:

{
  "profiles": [
    {
      "fullName": "<display_name>",
      "headline": "<first plain-text line of about_me>",
      "websiteUrl": "<website_url || link>",
      "location": "<location if present>",
      "bio": "<about_me with HTML tags stripped>",
      "skills": ["skill 1", ...],
      "relevanceScore": <0-100, optional>
    }
  ]
}

HARD RULES:
1. Strip HTML tags from about_me before using as bio.
2. Skip users whose display_name contains 'bot', '-bot', or 'Anonymous'.
3. Prefer website_url as websiteUrl; fall back to the profile link.
4. skills should be inferred from about_me, matching: ${targetSkills.join(', ')}
5. Output JSON only — no prose, no markdown fences.

Target role: ${targetRole}`;
}

function buildDevtoExtractionSystem(
  targetSkills: string[],
  targetRole: string,
): string {
  return `Parse this dev.to USER SEARCH page markdown (the /search?q=...&filters=class_name:User endpoint). The page shows USER cards — NOT article cards. Each user card has: a display name, a @handle (links to dev.to/{handle}), a short bio/tagline, and a Follow button.

For each user card, return:

{
  "profiles": [
    {
      "fullName": "<display name>",
      "headline": "<bio/tagline text>",
      "websiteUrl": "https://dev.to/{handle}",
      "bio": "<full tagline>",
      "skills": ["skill 1", ...],
      "relevanceScore": <0-100, optional>
    }
  ]
}

HARD RULES:
1. Only extract USER cards — skip any rows that look like articles (have read-time or cover image but no @handle + Follow button).
2. websiteUrl must be https://dev.to/{handle} — strip the leading '@' from the handle.
3. Skip cards without a visible @handle.
4. skills should be inferred from the bio, matching: ${targetSkills.join(', ')}
5. Output JSON only — no prose, no markdown fences.
6. Limit to at most 30 profiles.

Target role: ${targetRole}`;
}

export function buildProfileExtractionSystemPrompt(
  sourceType: ProfileSourceType,
  targetSkills: string[],
  targetRole: string,
): string {
  switch (sourceType) {
    case 'linkedin_profile_serp':
      return buildLinkedInSerpExtractionSystem(targetSkills, targetRole);
    case 'github_api':
      return buildGitHubApiExtractionSystem(targetSkills, targetRole);
    case 'stackoverflow_api':
      return buildStackOverflowApiExtractionSystem(targetSkills, targetRole);
    case 'devto':
      return buildDevtoExtractionSystem(targetSkills, targetRole);
  }
}

export function buildProfileExtractionUserPrompt(p: {
  url: string;
  sourceName: string;
  content: string;
}): string {
  const content =
    p.content.length > 12000 ? p.content.slice(0, 12000) + '\n\n[truncated]' : p.content;
  return `Source: ${p.sourceName}
URL: ${p.url}

Page content:
\`\`\`
${content}
\`\`\`

Extract profiles per the system prompt. Return JSON only.`;
}
