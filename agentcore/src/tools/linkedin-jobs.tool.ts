import { scrape } from './crawl4ai.tool.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { enqueueExtensionTask } from '../services/extension-dispatcher.js';
import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies, opportunities } from '../db/schema/index.js';
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
  location?: string;
  postedAt?: string;
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

    // Dedup by linkedinUrl in DB
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
      if (existing) {
        logger.debug({ linkedinUrl: c.linkedinUrl, existingId: existing.id }, 'Skipped duplicate company from LinkedIn Jobs (dedup by linkedinUrl)');
        continue;
      }
    }

    try {
      const savedRow = await saveOrUpdateCompanyStatic(
        tenantId,
        {
          name: c.companyName,
          linkedinUrl: c.linkedinUrl,
          rawData: {
            source: 'linkedin_jobs_crawl4ai',
            hiringSignal: true,
            openJob: c.jobTitle,
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
              sourceUrl: c.linkedinUrl ?? undefined,
              companyName: c.companyName,
              companyId: savedRow.id,
              location: c.location ?? undefined,
              buyingIntentScore: 70,
              urgency: 'soon',
              status: 'new',
            });
          });
        } catch (err) {
          logger.debug(
            { err, companyId: savedRow.id, jobTitle: c.jobTitle },
            'Failed to insert hiring_signal opportunity (non-fatal)',
          );
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

// ─── Location aliases for validation ──────────────────────────────────────────

const LOCATION_ALIASES: Record<string, string[]> = {
  'united kingdom': ['united kingdom', 'uk', 'london', 'manchester', 'birmingham', 'edinburgh', 'glasgow', 'bristol', 'leeds', 'liverpool', 'cambridge', 'oxford', 'england', 'scotland', 'wales', 'belfast', 'cardiff', 'nottingham', 'sheffield', 'newcastle', 'reading', 'brighton'],
  'france': ['france', 'paris', 'lyon', 'marseille', 'bordeaux', 'toulouse', 'nantes', 'lille', 'strasbourg', 'montpellier', 'nice'],
  'germany': ['germany', 'berlin', 'munich', 'hamburg', 'frankfurt', 'cologne', 'düsseldorf', 'stuttgart', 'dortmund', 'essen', 'leipzig', 'dresden'],
  'ireland': ['ireland', 'dublin', 'cork', 'galway', 'limerick', 'waterford'],
  'spain': ['spain', 'madrid', 'barcelona', 'valencia', 'seville', 'bilbao', 'malaga'],
  'united states': ['united states', 'usa', 'us', 'new york', 'san francisco', 'los angeles', 'chicago', 'seattle', 'austin', 'boston', 'denver', 'miami', 'atlanta'],
  'estonia': ['estonia', 'tallinn', 'tartu'],
};

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse LinkedIn Jobs markdown output from CRAWL4AI, then filter by keyword + location.
 *
 * Two parsing strategies:
 *  1. (Primary) Find /jobs/view/ links — these ARE the actual job cards.
 *     For each, look forward for the nearest /company/ link.
 *  2. (Fallback) Find /company/ links and look backward for job titles.
 *     Only used when zero /jobs/view/ links are found.
 *
 * After parsing, results are filtered:
 *  - Keyword filter: job title must contain the primary search keyword
 *  - Location filter: job location must match the target region
 */
function parseJobListings(markdown: string, searchJobTitle: string, searchLocation: string): LinkedInJobCompany[] {
  let rawResults = parseViaJobViewLinks(markdown);

  if (rawResults.length === 0) {
    rawResults = parseViaCompanyLinks(markdown);
  }

  if (rawResults.length === 0) {
    rawResults = parseViaLineFallback(markdown);
  }

  // Apply keyword + location filters
  const afterKeyword = filterByKeyword(rawResults, searchJobTitle);
  const afterLocation = filterByLocation(afterKeyword, searchLocation);

  logger.info({
    rawParsed: rawResults.length,
    afterKeywordFilter: afterKeyword.length,
    afterLocationFilter: afterLocation.length,
    searchJobTitle,
    searchLocation,
  }, 'LinkedIn Jobs parse + filter results');

  return afterLocation;
}

/**
 * Strategy 1 (Primary): Find /jobs/view/ links — these are the actual job cards.
 * For each job link, look forward for the nearest /company/ link to identify the company.
 */
function parseViaJobViewLinks(markdown: string): LinkedInJobCompany[] {
  const results: LinkedInJobCompany[] = [];
  const jobViewRegex = /\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/jobs\/view\/[^)]+\)/g;
  let match: RegExpExecArray | null;

  while ((match = jobViewRegex.exec(markdown)) !== null) {
    const jobTitleRaw = match[1]!.trim();
    if (jobTitleRaw.length < 3) continue;

    const afterJob = markdown.slice(match.index + match[0].length, match.index + match[0].length + 600);

    // Look for the nearest /company/ link after this job link
    const companyMatch = afterJob.match(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_-]+)\/?[^)]*\)/);
    if (!companyMatch) continue;

    const companyName = companyMatch[1]!.trim();
    const companySlug = companyMatch[2]!;
    if (companyName.length < 2 || companySlug.length < 2) continue;

    // Extract location: look in the text between job link and company link, or after company
    const contextBlock = afterJob.slice(0, 500);
    let jobLocation = '';
    const locMatch = contextBlock.match(/(?:📍|Location:|·)\s*([A-Z][^\n|·]{2,50})/);
    if (locMatch) {
      jobLocation = locMatch[1]!.trim();
    } else {
      // Look for "City, Country" or "City, ST" patterns
      const cityMatch = contextBlock.match(/\b([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3}(?:,\s*[A-Z]{2,})?)\b/);
      if (cityMatch && cityMatch[1]!.length > 3) jobLocation = cityMatch[1]!.trim();
    }

    // Extract posted date
    let postedAt = '';
    const dateMatch = contextBlock.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago|just\s+now|today|yesterday)/i);
    if (dateMatch) postedAt = dateMatch[1]!.trim();

    results.push({
      companyName,
      linkedinUrl: `https://www.linkedin.com/company/${companySlug}`,
      jobTitle: jobTitleRaw,
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
  const companyLinkRegex = /\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_-]+)\/?[^)]*\)/g;
  let match: RegExpExecArray | null;

  while ((match = companyLinkRegex.exec(markdown)) !== null) {
    const name = match[1]!.trim();
    const slug = match[2]!;
    if (name.length < 2 || slug.length < 2) continue;

    const contextBefore = markdown.slice(Math.max(0, match.index - 500), match.index);
    const contextAfter = markdown.slice(match.index, match.index + 300);

    // Job title: prefer /jobs/view/ link in context, then heading/bold, then last line
    let jt = '';
    const jobLinkMatch = contextBefore.match(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/jobs\/view\//);
    if (jobLinkMatch) {
      jt = jobLinkMatch[1]!.trim();
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
      linkedinUrl: `https://www.linkedin.com/company/${slug}`,
      jobTitle: jt || 'Unknown role',
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
function filterByKeyword(results: LinkedInJobCompany[], searchJobTitle: string): LinkedInJobCompany[] {
  const keywords = searchJobTitle.toLowerCase().split(/\s+/).filter(k => k.length > 2);
  if (keywords.length === 0) return results;

  const primaryKeyword = keywords[0]!;

  const primaryMatches = results.filter(r => {
    const title = r.jobTitle.toLowerCase();
    return title.includes(primaryKeyword);
  });

  if (primaryMatches.length === 0 && results.length > 0) {
    logger.warn(
      { searchJobTitle, primaryKeyword, resultCount: results.length },
      'LinkedIn Jobs keyword filter matched zero — returning empty (strict match required)',
    );
  }

  return primaryMatches;
}

/**
 * Filter by location: jobs whose location clearly doesn't match the target
 * region are excluded. Jobs with no location or "remote" are kept.
 */
function filterByLocation(results: LinkedInJobCompany[], searchLocation: string): LinkedInJobCompany[] {
  if (!searchLocation) return results;

  const locLower = searchLocation.toLowerCase().trim();

  // Build list of valid location terms for this target
  const validTerms = LOCATION_ALIASES[locLower] || [locLower];

  const filtered = results.filter(r => {
    if (!r.location) return true; // keep if no location data (can't exclude)
    const loc = r.location.toLowerCase();

    // Keep if location matches any valid term
    if (validTerms.some(term => loc.includes(term))) return true;

    // Keep remote jobs (they could be in the target region)
    if (loc.includes('remote') || loc.includes('hybrid')) return true;

    // Reject: location doesn't match target
    return false;
  });

  // If filter removed everything, return original (location data may be bad)
  if (filtered.length === 0 && results.length > 0) {
    logger.warn(
      { searchLocation, validTerms, resultCount: results.length },
      'LinkedIn Jobs location filter matched nothing — returning unfiltered results',
    );
    return results;
  }

  return filtered;
}
