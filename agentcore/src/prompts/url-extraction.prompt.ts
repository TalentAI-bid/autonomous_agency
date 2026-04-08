/**
 * URL Extraction Prompt — used by smart-crawler.crawlGoogleAndExtractUrls()
 * to convert raw Google/Brave/DuckDuckGo SERP markdown into structured URL
 * lists. Used by both the CompanyFinderAgent and the EnrichmentAgent.
 *
 * Hard rules baked into the system prompt:
 * - Never invent URLs — only return URLs that appear verbatim in the markdown.
 * - Unwrap `https://www.google.com/url?q=<actual>&...` Google redirects.
 * - Per-intent allow/deny rules (see SYSTEM_PREAMBLE + INTENT_RULES below).
 *
 * The caller is expected to post-filter:
 *   1. Drop URLs not present in the original markdown (anti-hallucination).
 *   2. Drop URLs failing isJunkUrl().
 *   3. Unwrap any remaining google.com/url?q=... wrappers.
 */

export interface ExtractedUrl {
  url: string;
  title: string;
  snippet: string;
  /** 0-100; how confident the LLM is that this URL matches the intent. */
  relevance: number;
}

export interface ExtractedUrlList {
  urls: ExtractedUrl[];
  reasoning?: string;
}

export type UrlExtractionIntent =
  | 'company_domain'
  | 'linkedin_person'
  | 'linkedin_company'
  | 'news'
  | 'team_page'
  | 'github_profile'
  | 'github_repos'
  | 'twitter_profile'
  | 'stackoverflow_profile'
  | 'personal_site'
  | 'dev_community';

const SYSTEM_PREAMBLE = `You extract URLs verbatim from raw search-engine result markdown (Google, Brave, DuckDuckGo). You return strict JSON with the shape:

{
  "urls": [
    { "url": "https://...", "title": "...", "snippet": "...", "relevance": 0-100 }
  ],
  "reasoning": "brief explanation"
}

HARD RULES (violation = invalid output):
1. Never invent URLs. Only return URLs that appear verbatim in the input markdown.
2. Unwrap Google redirects: if you see https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F&sa=..., output the canonical URL https://example.com/.
3. Output only JSON. No prose, no markdown fences, no explanations outside the JSON object.
4. If no URLs match the intent, return { "urls": [], "reasoning": "no matches" }.
5. Apply the intent-specific allow/deny rules below — return at most 10 URLs, sorted by relevance descending.`;

const INTENT_RULES: Record<UrlExtractionIntent, string> = {
  company_domain: `INTENT: company_domain
KEEP: URLs whose host plausibly matches the company name (the company's own website).
REJECT: linkedin.com, facebook.com, twitter.com, x.com, instagram.com, youtube.com, tiktok.com, crunchbase.com, bloomberg.com, wikipedia.org, glassdoor.com, indeed.com, ziprecruiter.com, monster.com, lever.co, greenhouse.io, workday.com, myworkdayjobs.com, bamboohr.com, smartrecruiters.com, jobvite.com, breezy.hr, ashbyhq.com, techcrunch.com, venturebeat.com, businesswire.com, prnewswire.com, yahoo.com, zoominfo.com, apollo.io, rocketreach.co.`,

  linkedin_person: `INTENT: linkedin_person
KEEP: only URLs matching linkedin.com/in/<slug> (personal profiles).
REJECT: anything else, including linkedin.com/company/, linkedin.com/jobs/, linkedin.com/pulse/.`,

  linkedin_company: `INTENT: linkedin_company
KEEP: only URLs matching linkedin.com/company/<slug> (company pages).
REJECT: anything else, including linkedin.com/in/, linkedin.com/jobs/, linkedin.com/showcase/.`,

  news: `INTENT: news
KEEP: recent article URLs from news/media outlets covering the company.
REJECT: linkedin.com, facebook.com, twitter.com, x.com, reddit.com, news.google.com, wikipedia.org, the company's own homepage.`,

  team_page: `INTENT: team_page
KEEP: URLs whose path contains team / about / leadership / people / management / our-team AND whose host matches the company hint.
REJECT: linkedin.com, glassdoor.com, indeed.com, third-party directories.`,

  github_profile: `INTENT: github_profile
KEEP: URLs matching github.com/<user> (profile root, no /<repo> suffix).
REJECT: gist.github.com, github.com/marketplace, *.github.io, github.com/topics, github.com/search, github.com/orgs, repo URLs (github.com/<user>/<repo>).`,

  github_repos: `INTENT: github_repos
KEEP: URLs matching github.com/<user>/<repo> (repository pages).
REJECT: gist.github.com, github.com/marketplace, github.com/topics, github.com/search, profile-only URLs.`,

  twitter_profile: `INTENT: twitter_profile
KEEP: URLs matching twitter.com/<handle> or x.com/<handle> (profile root).
REJECT: status URLs (/status/), search URLs (/search), hashtag URLs (/hashtag/).`,

  stackoverflow_profile: `INTENT: stackoverflow_profile
KEEP: URLs matching stackoverflow.com/users/<id>[/...] (user profiles).
REJECT: question pages (/questions/), tag pages (/tags/), search pages.`,

  personal_site: `INTENT: personal_site
KEEP: personal blog or portfolio URLs (the person's own domain).
REJECT: linkedin.com, github.com, medium.com, dev.to, twitter.com, x.com, facebook.com, indeed.com, glassdoor.com.`,

  dev_community: `INTENT: dev_community
KEEP: URLs matching medium.com/@<user> or dev.to/<user> (author pages).
REJECT: medium.com/<publication> (unless it's clearly a personal publication), tag pages, topic pages.`,
};

export function buildSystemPrompt(intent: UrlExtractionIntent): string {
  return `${SYSTEM_PREAMBLE}\n\n${INTENT_RULES[intent]}`;
}

export function buildUserPrompt(p: {
  markdown: string;
  intent: UrlExtractionIntent;
  companyName?: string;
  personName?: string;
}): string {
  const hints: string[] = [];
  if (p.companyName) hints.push(`Company hint: ${p.companyName}`);
  if (p.personName) hints.push(`Person hint: ${p.personName}`);
  const hintsBlock = hints.length ? `${hints.join('\n')}\n\n` : '';

  // Truncate huge markdown to keep prompt sane
  const markdown = p.markdown.length > 16000 ? p.markdown.slice(0, 16000) + '\n\n[truncated]' : p.markdown;

  return `${hintsBlock}Intent: ${p.intent}

Search engine result markdown:
\`\`\`
${markdown}
\`\`\`

Extract URLs matching the intent above. Return JSON only.`;
}
