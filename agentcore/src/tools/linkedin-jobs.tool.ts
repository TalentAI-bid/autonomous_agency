import { scrape } from './crawl4ai.tool.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { enqueueExtensionTask } from '../services/extension-dispatcher.js';
import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, opportunities } from '../db/schema/index.js';
import { Country, State, City } from 'country-state-city';
import logger from '../utils/logger.js';
import { logPipelineError } from '../utils/pipeline-error.js';

const CLOUDFLARE_SIGNATURES = [
  'error 1015', 'rate limit', 'cloudflare', 'attention required',
  'cf-error-details', 'enable javascript and cookies',
  'checking your browser', 'just a moment',
];

function looksLikeCloudflareBlock(markdown: string): boolean {
  if (!markdown) return false;
  const lower = markdown.toLowerCase();
  let matches = 0;
  for (const sig of CLOUDFLARE_SIGNATURES) {
    if (lower.includes(sig)) matches++;
    if (matches >= 2) return true;
  }
  return false;
}

export interface LinkedInJobCompany {
  companyName: string;
  linkedinUrl?: string;
  jobTitle: string;
  jobUrl?: string;
  location?: string;
  postedAt?: string;
}

// Section headers LinkedIn renders for sidebar/non-result content. If the
// look-forward (or look-back) context hits one of these before the company
// link, the row is almost certainly a recommendation, not the job's actual
// hiring company — skip rather than misattribute.
const SIDEBAR_SECTION_MARKERS = [
  'Recommended',
  'People also viewed',
  'More jobs',
  'Suggested',
  'Promoted',
];

function hasSidebarMarkerBefore(context: string, untilIdx: number): boolean {
  const head = context.slice(0, untilIdx);
  return SIDEBAR_SECTION_MARKERS.some((m) => head.includes(m));
}

// ─── Retry constants ─────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s

async function scrapeWithRetry(tenantId: string, url: string): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const markdown = await scrape(tenantId, url);
    if (markdown && markdown.trim().length >= 50) return markdown;

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS[attempt]!;
      logger.info(
        { tenantId, url, attempt: attempt + 1, delayMs: delay },
        'LinkedIn Jobs scrape returned empty — retrying after delay',
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return '';
}

/**
 * Server-side LinkedIn Jobs search via CRAWL4AI.
 *
 * LinkedIn Jobs search pages are PUBLIC (no login required), so we scrape
 * them directly from the server instead of routing through the Chrome extension.
 *
 * For each company found, we:
 *  1. Save/update the company row with hiringSignal metadata
 *  2. Auto-queue a `fetch_company` extension task for full LinkedIn About details
 */
export async function searchLinkedInJobs(
  tenantId: string,
  jobTitle: string,
  location: string,
  masterAgentId?: string,
): Promise<{ companies: LinkedInJobCompany[]; raw: string }> {
  const keywords = encodeURIComponent(jobTitle);
  const loc = encodeURIComponent(location);
  const url = `https://www.linkedin.com/jobs/search/?keywords=${keywords}&location=${loc}&f_TPR=r604800`;

  logger.info({ tenantId, jobTitle, location, url, masterAgentId }, 'Hiring signal: scraping LinkedIn Jobs via server');

  const markdown = await scrapeWithRetry(tenantId, url);
  if (!markdown || markdown.trim().length < 50) {
    logger.warn({ tenantId, jobTitle, location, markdownLen: markdown.length }, 'LinkedIn Jobs scrape returned empty/short content after retries');
    // Classify: Cloudflare signature → cloudflare_block, else treat as timeout/empty.
    const errorType = looksLikeCloudflareBlock(markdown) ? 'cloudflare_block' : 'crawl_timeout';
    await logPipelineError({
      tenantId,
      masterAgentId,
      step: 'linkedin_jobs_search',
      tool: 'CRAWL4AI',
      errorType,
      context: { url, jobTitle, location, markdownLen: markdown.length },
    });
    return { companies: [], raw: markdown };
  }

  const parsed = parseJobListings(markdown, jobTitle, location);

  // Deduplicate by LinkedIn URL
  const seen = new Set<string>();
  const unique: LinkedInJobCompany[] = [];
  for (const c of parsed) {
    const key = c.linkedinUrl || c.companyName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  logger.info(
    { tenantId, jobTitle, location, parsedBeforeDedup: parsed.length, afterDedup: unique.length },
    'LinkedIn Jobs parsed, filtered, and deduped',
  );

  // Save companies to DB and auto-chain fetch_company
  let saved = 0;
  for (const c of unique) {
    if (!c.companyName || c.companyName.length < 2) continue;

    // Dedup by linkedinUrl in DB. saveOrUpdateCompanyStatic only dedupes by
    // id / domain / name, so without this lookup re-scrapes would create
    // duplicate rows for LinkedIn-only companies that lack a domain. When a
    // row already exists, pin its id and fall through to the save path: the
    // helper takes the id-update branch (re-associates the company with this
    // master agent + merges rawData) and the per-run side effects below
    // (opportunity row, fetch_company enqueue) still fire. Previously a
    // `continue` here silently skipped both, which is why re-runs over
    // already-seen LinkedIn URLs produced 0 saved + 0 extension dispatches
    // for the new master agent.
    let existingCompanyId: string | undefined;
    if (c.linkedinUrl) {
      const [existing] = await withTenant(tenantId, async (tx) => {
        return tx
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, tenantId),
              eq(companies.linkedinUrl, c.linkedinUrl!),
            ),
          )
          .limit(1);
      });
      if (existing) existingCompanyId = existing.id;
    }

    try {
      const savedRow = await saveOrUpdateCompanyStatic(
        tenantId,
        {
          ...(existingCompanyId ? { id: existingCompanyId } : {}),
          name: c.companyName,
          linkedinUrl: c.linkedinUrl,
          rawData: {
            source: 'linkedin_jobs_crawl4ai',
            hiringSignal: true,
            openJob: c.jobTitle,
            jobUrl: c.jobUrl,
            jobPostedAt: c.postedAt,
            location: c.location,
          },
        },
        masterAgentId,
      );
      logger.debug({ companyId: savedRow.id, name: c.companyName, linkedinUrl: c.linkedinUrl }, 'Saved company from LinkedIn Jobs');

      // Materialize as an `opportunities` row so the dashboard's Opportunities
      // tab surfaces this hiring signal. Dedup on (masterAgentId, companyId, title)
      // so re-scraping the same search doesn't duplicate rows. Non-fatal —
      // a failure here must not abort the scrape loop.
      if (masterAgentId) {
        try {
          await withTenant(tenantId, async (tx) => {
            const existing = await tx
              .select({ id: opportunities.id })
              .from(opportunities)
              .where(
                and(
                  eq(opportunities.tenantId, tenantId),
                  eq(opportunities.masterAgentId, masterAgentId),
                  eq(opportunities.companyId, savedRow.id),
                  eq(opportunities.title, c.jobTitle),
                ),
              )
              .limit(1);
            if (existing.length > 0) return;

            await tx.insert(opportunities).values({
              tenantId,
              masterAgentId,
              title: c.jobTitle,
              opportunityType: 'hiring_signal',
              sourcePlatform: 'linkedin_jobs',
              // Prefer the actual job-post URL so the dashboard "Source" link
              // opens the LinkedIn job (not just the company page).
              sourceUrl: c.jobUrl ?? c.linkedinUrl ?? undefined,
              companyName: c.companyName,
              companyId: savedRow.id,
              location: c.location ?? undefined,
              buyingIntentScore: 70,
              urgency: 'soon',
              status: 'new',
            });
          });
        } catch (err) {
          logger.warn(
            { err, companyId: savedRow.id, jobTitle: c.jobTitle },
            'Failed to insert hiring_signal opportunity (non-fatal)',
          );
          // Surface in the dashboard errors panel so missing Opportunities-tab
          // rows aren't a silent failure: the user (and we) can see exactly
          // which (companyId, jobTitle) pair failed and why.
          await logPipelineError({
            tenantId,
            masterAgentId,
            step: 'opportunity_insert',
            tool: 'linkedin_jobs_search',
            errorType: 'opportunity_insert_failed',
            severity: 'warning',
            context: {
              companyId: savedRow.id,
              jobTitle: c.jobTitle,
              companyName: c.companyName,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      // Auto-queue fetch_company to get full company details via extension
      if (c.linkedinUrl) {
        try {
          await enqueueExtensionTask({
            tenantId,
            masterAgentId,
            site: 'linkedin',
            type: 'fetch_company',
            params: { linkedinUrl: c.linkedinUrl, companyId: savedRow.id },
            priority: 3,
          });
        } catch (err) {
          logger.debug({ err, linkedinUrl: c.linkedinUrl }, 'Failed to auto-queue fetch_company from LinkedIn Jobs (non-fatal)');
        }
      }

      saved++;
    } catch (err) {
      logger.debug({ err, name: c.companyName }, 'Skipped invalid company from LinkedIn Jobs');
    }
  }

  logger.info(
    { tenantId, masterAgentId, jobTitle, location, parsed: unique.length, saved },
    'Server-side LinkedIn Jobs scrape completed',
  );

  // We got markdown back but ended up with zero usable companies. Record it as a
  // soft warning so the user sees it in the UI — the strict keyword+location
  // filters deliberately return empty rather than pollute the pipeline.
  if (unique.length === 0) {
    await logPipelineError({
      tenantId,
      masterAgentId,
      step: 'linkedin_jobs_search',
      tool: 'CRAWL4AI',
      errorType: 'no_job_posts_found',
      severity: 'warning',
      context: { url, jobTitle, location, rawParsed: parsed.length },
    });
  }

  return { companies: unique, raw: markdown };
}

// ─── Location resolution (country/state/city via country-state-city) ─────────

// Two-tier alias set:
//  - `phrase` (multi-word, length ≥ 4): matched with `loc.includes(alias)`.
//    Examples: "new york", "île-de-france", "the hague". Safe because spaces
//    naturally bound the match.
//  - `token` (single-word, length ≥ 2): matched as a whole token by splitting
//    the parsed location on `[\s,/.()]+` and checking exact equality.
//    Examples: "paris", "lyon", "fr", "be", "ny", "tx". This prevents the
//    cross-country false positives that pure substring match produced (e.g.
//    French commune "Eu" matching "EU" tokens, US town "Cana" matching
//    "Canada", ISO code "be" matching "Berlin").
interface LocationAliases {
  phrase: Set<string>;
  token: Set<string>;
}

const aliasCache = new Map<string, LocationAliases>();

// Common alt-codes that don't appear in country-state-city's iso-2 list but
// are the natural input for English-speaking users. Lower-cased lookup keys
// → canonical iso-2 code in the dataset.
const COUNTRY_ALT_CODES: Record<string, string> = {
  'uk': 'gb',
  'usa': 'us',
  'u.k.': 'gb',
  'u.s.': 'us',
  'u.s.a.': 'us',
};

// Built once at module load so we can detect "this parsed location names a
// foreign country/state" without per-call allocation. Tokens cover ISO-2
// country codes + single-word country names + 2-char alphabetic state codes
// (US/CA/AU/MX-style: NY, TX, CA, ON, NSW…). Phrases cover multi-word
// country names ("united states", "south africa", "czech republic"). Used
// by filterByLocation to reject rows where the parsed location explicitly
// names a country/state other than the searched one — defends against:
//   - US-search matching "Toronto, Canada" because the US dataset has a
//     city called "Toronto, OH"
//   - UK-search matching "New York, NY" because the UK dataset has a city
//     called "York"
const ALL_FOREIGN_TOKENS = new Set<string>();
const ALL_FOREIGN_PHRASES = new Set<string>();
for (const c of Country.getAllCountries()) {
  const name = c.name.toLowerCase();
  if (/\s/.test(name)) ALL_FOREIGN_PHRASES.add(name);
  else ALL_FOREIGN_TOKENS.add(name);
  ALL_FOREIGN_TOKENS.add(c.isoCode.toLowerCase());
  for (const s of State.getStatesOfCountry(c.isoCode)) {
    if (s.isoCode.length === 2 && /^[a-z]+$/i.test(s.isoCode)) {
      ALL_FOREIGN_TOKENS.add(s.isoCode.toLowerCase());
    }
  }
}
// Add common alt-codes so the foreign-country guard catches "London, UK" in
// a non-UK search even though the dataset's UK ISO code is "GB".
for (const alt of Object.keys(COUNTRY_ALT_CODES)) ALL_FOREIGN_TOKENS.add(alt);

/**
 * Build the alias set for a given search location.
 *
 *  1. If the input resolves to a country (by full name or ISO-2 code), the
 *     alias set is { country name, country ISO-2, all states (name + 2-char
 *     alphabetic code), all cities }.
 *  2. Otherwise the alias set holds just the raw lowercased input — the user
 *     passed a city/region/free-form string.
 *
 * Numeric and 3-letter state codes (e.g. French INSEE numbers "01"–"95",
 * Belgian local codes like "VAN"/"BRU") are intentionally skipped because
 * LinkedIn-parsed locations don't use them; adding them would only create
 * noise.
 */
function resolveLocationAliases(searchLocation: string): LocationAliases {
  const key = searchLocation.toLowerCase().trim();
  const cached = aliasCache.get(key);
  if (cached) return cached;

  const phrase = new Set<string>();
  const token = new Set<string>();

  const add = (raw: string | undefined | null) => {
    if (!raw) return;
    const t = raw.toLowerCase().trim();
    if (t.length < 2) return;
    if (/\s/.test(t)) {
      if (t.length >= 4) phrase.add(t);
    } else {
      token.add(t);
    }
  };

  // Normalise common alt-codes (UK -> GB, USA -> US) before the dataset lookup.
  const lookupKey = COUNTRY_ALT_CODES[key] ?? key;

  const country = Country.getAllCountries().find(c =>
    c.name.toLowerCase() === lookupKey || c.isoCode.toLowerCase() === lookupKey,
  );

  if (country) {
    add(country.name);
    add(country.isoCode);
    // Include the alt-code itself if the user typed one ("UK" → also accept
    // "uk" as a token alias so "Paris, UK" is matched).
    if (key !== lookupKey) add(key);

    for (const state of State.getStatesOfCountry(country.isoCode)) {
      add(state.name);
      if (state.isoCode.length === 2 && /^[a-z]+$/i.test(state.isoCode)) {
        add(state.isoCode);
      }
    }

    const cities = City.getCitiesOfCountry(country.isoCode) ?? [];
    for (const city of cities) {
      add(city.name);
    }
  } else {
    add(key);
  }

  const result = { phrase, token };
  aliasCache.set(key, result);
  return result;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Normalise a LinkedIn company URL so cross-subdomain dedup works:
 *  - strips the query string
 *  - rewrites country subdomains (gr., uk., be., fr., …) to www.
 * `https://gr.linkedin.com/company/foo?trk=…` → `https://www.linkedin.com/company/foo`
 */
function normaliseLinkedInCompanyUrl(rawUrl: string): string {
  const noQuery = rawUrl.split('?')[0]!;
  return noQuery.replace(/^https?:\/\/[^/]*linkedin\.com\//i, 'https://www.linkedin.com/');
}

/**
 * Parse LinkedIn Jobs markdown output from CRAWL4AI, then filter by keyword + location.
 *
 * Three parsing strategies, tried in order:
 *  1. (Primary, current LinkedIn markup) Heading + bracketed-company pattern:
 *       ###  {Job Title}
 *       ####  [ {Company Name} ](https://{cc}.linkedin.com/company/{slug}?trk=…)
 *     Handles country subdomains, spaces inside brackets, lowercase /
 *     non-ASCII names.
 *  2. (Fallback) Find /jobs/view/ links and look forward for the nearest
 *     /company/ link. Catches older LinkedIn page variants.
 *  3. (Last resort) Find /company/ links and look backward for job titles.
 *
 * After parsing, results are filtered:
 *  - Keyword filter: job title must contain the primary search keyword
 *  - Location filter: job location must match the target region
 */
function parseJobListings(markdown: string, searchJobTitle: string, searchLocation: string): LinkedInJobCompany[] {
  let rawResults = parseViaHeadingPattern(markdown);
  let strategy = 'heading';

  if (rawResults.length === 0) {
    rawResults = parseViaJobViewLinks(markdown);
    strategy = 'jobs-view';
  }

  if (rawResults.length === 0) {
    rawResults = parseViaCompanyLinks(markdown);
    strategy = 'company-links';
  }

  if (rawResults.length === 0) {
    rawResults = parseViaLineFallback(markdown);
    strategy = 'line-fallback';
  }

  // Apply keyword + location filters
  const afterKeyword = filterByKeyword(rawResults, searchJobTitle);
  const afterLocation = filterByLocation(afterKeyword, searchLocation);

  logger.info({
    strategy,
    rawParsed: rawResults.length,
    afterKeywordFilter: afterKeyword.length,
    afterLocationFilter: afterLocation.length,
    searchJobTitle,
    searchLocation,
  }, 'LinkedIn Jobs parse + filter results');

  return afterLocation;
}

/**
 * Strategy 0 (Primary, current LinkedIn markup): match the heading-based job
 * card LinkedIn now serves on its public /jobs/search/ pages:
 *
 *   ###  {Job Title}
 *   ####  [ {Company Name} ](https://{cc}.linkedin.com/company/{slug}?trk=…)
 *
 * The regex tolerates:
 *  - any subdomain (`gr.`, `uk.`, `www.`, none) on linkedin.com
 *  - whitespace inside the bracketed company-name (`[ Joblet-AI ]`)
 *  - lowercase / non-ASCII company names (no `[A-Z]` anchor)
 */
function parseViaHeadingPattern(markdown: string): LinkedInJobCompany[] {
  const results: LinkedInJobCompany[] = [];
  const re = /###\s+(.+?)\n+####\s+\[\s*(.+?)\s*\]\(([^)]*linkedin\.com\/company\/[^)]+)\)/gm;
  let m: RegExpExecArray | null;

  while ((m = re.exec(markdown)) !== null) {
    const jobTitle = m[1]!.trim();
    const companyName = m[2]!.trim();
    if (jobTitle.length < 3 || companyName.length < 2) continue;

    const linkedinUrl = normaliseLinkedInCompanyUrl(m[3]!);

    // Look forward up to 600 chars for an inline location/posted-date hint —
    // LinkedIn renders these in italics or bullet text right under the card.
    const contextBlock = markdown.slice(m.index + m[0].length, m.index + m[0].length + 600);
    let jobLocation = '';
    const locMatch = contextBlock.match(/(?:📍|Location:|·)\s*([A-Za-z][^\n|·]{2,80})/);
    if (locMatch) {
      jobLocation = locMatch[1]!.trim();
    } else {
      const cityMatch = contextBlock.match(/\b([A-Z][a-zA-Zà-ÿ]+(?:[\s,]+[A-Z][a-zA-Zà-ÿ]+){0,3}(?:,\s*[A-Z]{2,})?)\b/);
      if (cityMatch && cityMatch[1]!.length > 3) jobLocation = cityMatch[1]!.trim();
    }

    let postedAt = '';
    const dateMatch = contextBlock.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago|just\s+now|today|yesterday)/i);
    if (dateMatch) postedAt = dateMatch[1]!.trim();

    // Look for the underlying /jobs/view/{id} URL so the dashboard "Source"
    // link can open the actual job post instead of just the company page.
    let jobUrl: string | undefined;
    const jobIdMatch = contextBlock.match(/linkedin\.com\/jobs\/view\/(\d+)/i);
    if (jobIdMatch) {
      jobUrl = `https://www.linkedin.com/jobs/view/${jobIdMatch[1]}/`;
    }

    results.push({
      companyName,
      linkedinUrl,
      jobTitle,
      jobUrl,
      location: jobLocation || undefined,
      postedAt: postedAt || undefined,
    });
  }

  return results;
}

/**
 * Strategy 1 (Primary): Find /jobs/view/ links — these are the actual job cards.
 * For each job link, look forward for the nearest /company/ link to identify the company.
 */
function parseViaJobViewLinks(markdown: string): LinkedInJobCompany[] {
  const results: LinkedInJobCompany[] = [];
  // Allow any subdomain (`gr.`, `uk.`, `www.`, none) and whitespace-padded brackets.
  // Capture the underlying job-view URL so we can persist it on the opportunity.
  const jobViewRegex = /\[\s*([^\]]+?)\s*\]\((https?:\/\/[^/]*linkedin\.com\/jobs\/view\/[^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = jobViewRegex.exec(markdown)) !== null) {
    const jobTitleRaw = match[1]!.trim();
    if (jobTitleRaw.length < 3) continue;

    const jobUrlRaw = match[2]!;
    let jobUrl: string | undefined;
    const jobIdMatch = jobUrlRaw.match(/jobs\/view\/(\d+)/i);
    if (jobIdMatch) jobUrl = `https://www.linkedin.com/jobs/view/${jobIdMatch[1]}/`;

    // Look-forward window tightened from 600 → 200 chars: LinkedIn renders
    // the hiring company link immediately after the job link; anything past
    // 200 chars is overwhelmingly a sidebar/recommendation block which we
    // were misattributing the job to.
    const afterJob = markdown.slice(match.index + match[0].length, match.index + match[0].length + 200);

    // Look for the nearest /company/ link after this job link (any subdomain).
    const companyMatch = afterJob.match(/\[\s*([^\]]+?)\s*\]\((https?:\/\/[^/]*linkedin\.com\/company\/[a-zA-Z0-9_-]+[^)]*)\)/);
    if (!companyMatch) continue;

    // If a recommendation/sidebar section heading (e.g. "Recommended", "People
    // also viewed") appears before the company link, treat the link as a
    // sidebar item, not the actual hiring company. Skip rather than misattribute.
    if (companyMatch.index !== undefined && hasSidebarMarkerBefore(afterJob, companyMatch.index)) {
      continue;
    }

    const companyName = companyMatch[1]!.trim();
    const linkedinUrl = normaliseLinkedInCompanyUrl(companyMatch[2]!);
    if (companyName.length < 2 || linkedinUrl.length < 30) continue;

    // Extract location: look in the text between job link and company link, or after company
    const contextBlock = afterJob;
    let jobLocation = '';
    const locMatch = contextBlock.match(/(?:📍|Location:|·)\s*([A-Za-z][^\n|·]{2,80})/);
    if (locMatch) {
      jobLocation = locMatch[1]!.trim();
    } else {
      // Look for "City, Country" or "City, ST" patterns
      const cityMatch = contextBlock.match(/\b([A-Z][a-zA-Zà-ÿ]+(?:[\s,]+[A-Z][a-zA-Zà-ÿ]+){0,3}(?:,\s*[A-Z]{2,})?)\b/);
      if (cityMatch && cityMatch[1]!.length > 3) jobLocation = cityMatch[1]!.trim();
    }

    // Extract posted date
    let postedAt = '';
    const dateMatch = contextBlock.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago|just\s+now|today|yesterday)/i);
    if (dateMatch) postedAt = dateMatch[1]!.trim();

    results.push({
      companyName,
      linkedinUrl,
      jobTitle: jobTitleRaw,
      jobUrl,
      location: jobLocation || undefined,
      postedAt: postedAt || undefined,
    });
  }

  return results;
}

/**
 * Strategy 2 (Fallback): Find /company/ links and look backward for job titles.
 * Only used when zero /jobs/view/ links are found.
 */
function parseViaCompanyLinks(markdown: string): LinkedInJobCompany[] {
  const results: LinkedInJobCompany[] = [];
  // Allow any subdomain + whitespace-padded brackets.
  const companyLinkRegex = /\[\s*([^\]]+?)\s*\]\((https?:\/\/[^/]*linkedin\.com\/company\/[a-zA-Z0-9_-]+[^)]*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = companyLinkRegex.exec(markdown)) !== null) {
    const name = match[1]!.trim();
    const linkedinUrl = normaliseLinkedInCompanyUrl(match[2]!);
    if (name.length < 2 || linkedinUrl.length < 30) continue;

    const contextBefore = markdown.slice(Math.max(0, match.index - 500), match.index);
    const contextAfter = markdown.slice(match.index, match.index + 300);

    // If a recommendation/sidebar section header appears in the immediately
    // preceding 200 chars, treat this as a sidebar link, not a hiring-signal
    // result. Skip rather than misattribute.
    const tailBefore = contextBefore.slice(-200);
    if (SIDEBAR_SECTION_MARKERS.some((m) => tailBefore.includes(m))) {
      continue;
    }

    // Job title + jobUrl: prefer /jobs/view/ link in context, then heading/bold, then last line
    let jt = '';
    let jobUrl: string | undefined;
    const jobLinkMatch = contextBefore.match(/\[\s*([^\]]+?)\s*\]\((https?:\/\/[^/]*linkedin\.com\/jobs\/view\/[^)]+)\)/);
    if (jobLinkMatch) {
      jt = jobLinkMatch[1]!.trim();
      const idMatch = jobLinkMatch[2]!.match(/jobs\/view\/(\d+)/i);
      if (idMatch) jobUrl = `https://www.linkedin.com/jobs/view/${idMatch[1]}/`;
    }
    if (!jt) {
      const headingMatch = contextBefore.match(/(?:#{1,4}\s+(.+)|^\*\*(.+?)\*\*)/m);
      if (headingMatch) jt = (headingMatch[1] || headingMatch[2] || '').trim();
    }
    if (!jt) {
      const lines = contextBefore.split('\n').map(l => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      jt = lastLine.replace(/^[#*\->\s]+/, '').replace(/\[([^\]]+)\]\([^)]+\)/, '$1').trim();
    }

    // Skip rows we couldn't pull a real job title from — these are almost
    // always navigation/sidebar links the parser stumbled into. Better to
    // surface zero results than to write "Unknown role" rows the user can't
    // verify.
    if (!jt || jt.length < 3) continue;

    // Location
    let location = '';
    const locMatch = contextAfter.match(/(?:📍|Location:|·)\s*([A-Z][^\n|·]{2,50})/);
    if (locMatch) location = locMatch[1]!.trim();
    if (!location) {
      const cityMatch = contextAfter.match(/\b([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3}(?:,\s*[A-Z]{2,})?)\b/);
      if (cityMatch && cityMatch[1]!.length > 3) location = cityMatch[1]!.trim();
    }

    // Posted date
    let postedAt = '';
    const dateMatch = contextAfter.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago|just\s+now|today|yesterday)/i);
    if (dateMatch) postedAt = dateMatch[1]!.trim();

    results.push({
      companyName: name,
      linkedinUrl,
      jobTitle: jt,
      jobUrl,
      location: location || undefined,
      postedAt: postedAt || undefined,
    });
  }

  return results;
}

/**
 * Strategy 3 (Last resort): Line-by-line "Title at Company" pattern.
 */
function parseViaLineFallback(markdown: string): LinkedInJobCompany[] {
  const results: LinkedInJobCompany[] = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    const jobPattern = trimmed.match(/^(?:[-*•]\s*)?(.+?)\s+(?:at|@|-|–|—)\s+(.+?)(?:\s*[|·]\s*(.+))?$/i);
    if (jobPattern) {
      const title = jobPattern[1]!.trim();
      const company = jobPattern[2]!.trim();
      const loc = jobPattern[3]?.trim();
      if (company.length >= 2 && title.length >= 3) {
        results.push({
          companyName: company,
          jobTitle: title,
          location: loc || undefined,
        });
      }
    }
  }
  return results;
}

// ─── Filters ──────────────────────────────────────────────────────────────────

/**
 * Filter by keyword: the primary search keyword (first word, usually the most
 * specific like "Solana", "Hedera") MUST appear in the job title. No fallback:
 * if nothing matches, return empty — better than polluting the pipeline with
 * unrelated jobs (e.g. "FullStack Developer" for a "Hedera developer" search).
 *
 * For "Hedera developer":
 *  - "FullStack Developer" → has "developer" but NOT "hedera" → rejected
 *  - "Hedera Smart Contract Developer" → has "hedera" → accepted
 */
// Stop-words stripped from the search query before picking the "primary" anchor
// keyword. These all appear in nearly every engineering / IT job title and so
// can't tell us whether a hit is on-topic.
const KEYWORD_STOP_WORDS = new Set([
  'engineer', 'engineers', 'engineering',
  'developer', 'developers', 'development',
  'senior', 'junior', 'lead', 'staff', 'principal',
  'specialist', 'expert', 'analyst', 'architect', 'manager',
]);

function filterByKeyword(results: LinkedInJobCompany[], searchJobTitle: string): LinkedInJobCompany[] {
  // Pick the first non-stopword token as the "primary" anchor — for "DevOps
  // Engineer" that's "devops"; for "Site Reliability Engineer" that's "site"
  // (we'd prefer "reliability" but matching ANY non-stop token still works);
  // for "Senior Cloud Engineer" that's "cloud". Falling back to the full
  // lowercased query when every token is a stopword keeps "QA" / "ML"
  // searches from accepting everything.
  const lc = searchJobTitle.toLowerCase().trim();
  const tokens = lc.split(/[\s/,&()-]+/).filter(Boolean);
  const primary = tokens.find(t => t.length >= 3 && !KEYWORD_STOP_WORDS.has(t)) ?? lc;

  const matches = results.filter(r => r.jobTitle.toLowerCase().includes(primary));

  if (matches.length === 0 && results.length > 0) {
    // Reject rather than return unfiltered: LinkedIn's URL-level filter is
    // unreliable (the page often returns generic recommendations when no
    // exact matches exist), and falling back to "everything" was producing
    // hiring-signal companies that aren't actually hiring for the keyword
    // — the symptom that brought us here. The master-agent's
    // search_quality_low alert covers the user-facing 0-result case.
    logger.warn(
      { searchJobTitle, primary, resultCount: results.length },
      'LinkedIn Jobs keyword filter matched zero — rejecting batch to avoid wrong-company pollution',
    );
    return [];
  }

  return matches;
}

/**
 * Filter by location: jobs whose location clearly doesn't match the target
 * region are excluded. Jobs with no location or "remote" are kept.
 */
function filterByLocation(results: LinkedInJobCompany[], searchLocation: string): LinkedInJobCompany[] {
  if (!searchLocation) return results;

  const aliases = resolveLocationAliases(searchLocation);

  const filtered = results.filter(r => {
    // Trust LinkedIn's URL-level location filter for rows where our
    // markdown parser failed to extract a location string. The parser is
    // brittle (relies on emoji/heuristic regex over scraped HTML) and
    // frequently misses location text even on correctly-localised jobs.
    // Auto-rejecting these silently dropped legitimate in-country jobs
    // and produced 0-result regressions on supported countries (e.g.
    // France/DevOps query). Cross-border bleed-through is handled by
    // the alias resolver above and the no-fallback-to-unfiltered change
    // below.
    if (!r.location) return true;
    const loc = r.location.toLowerCase();
    const tokens = loc.split(/[\s,/.()]+/).filter(Boolean);

    // Foreign-country/state guard: if the parsed location names a country
    // or US/CA/AU-style state code that's NOT in our alias set, reject. This
    // catches:
    //   - US dataset has a city "Toronto, OH"; without this guard, US search
    //     would falsely accept "Toronto, Canada".
    //   - UK dataset has the historic city "York"; without this guard, UK
    //     search would falsely accept "New York, NY" via the "york" token.
    for (const t of tokens) {
      if (ALL_FOREIGN_TOKENS.has(t) && !aliases.token.has(t)) return false;
    }
    for (const p of ALL_FOREIGN_PHRASES) {
      if (loc.includes(p) && !aliases.phrase.has(p)) return false;
    }

    // Multi-word phrases ("new york", "île-de-france"): substring match —
    // spaces naturally bound the match.
    for (const p of aliases.phrase) {
      if (loc.includes(p)) return true;
    }

    // Single-word names + ISO codes ("paris", "lyon", "fr", "ny"):
    // whole-token match. Splitting on common separators (whitespace, commas,
    // slashes, dots, parens) and comparing whole tokens prevents the
    // cross-country false positives a pure substring match produced
    // (e.g. US town "Cana" matching "Canada", French commune "Eu"
    // matching the "EU" abbreviation, ISO "be" matching "Berlin").
    for (const t of tokens) {
      if (aliases.token.has(t)) return true;
    }

    // Keep remote jobs (they could be in the target region)
    if (loc.includes('remote') || loc.includes('hybrid')) return true;

    // Reject: location doesn't match target
    return false;
  });

  // If the filter rejected everything, that's the correct answer for
  // off-target results. Previously we returned the unfiltered set as a
  // "filter must be broken" fallback — but that silently let cross-border
  // bleed-through (UK / NL / FR jobs under a Belgium search) get persisted.
  // If you see this warn frequently for a specific country, the fix is to
  // pass a more specific searchLocation (the country-state-city dataset
  // already covers all ISO countries; if a country is unresolvable, the
  // alias set degrades to the raw input string).
  if (filtered.length === 0 && results.length > 0) {
    logger.warn(
      {
        searchLocation,
        phraseCount: aliases.phrase.size,
        tokenCount: aliases.token.size,
        resultCount: results.length,
      },
      'LinkedIn Jobs location filter rejected all results — returning empty',
    );
  }

  return filtered;
}
