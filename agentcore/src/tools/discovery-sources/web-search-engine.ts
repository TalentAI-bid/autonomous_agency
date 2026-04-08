import pLimit from 'p-limit';
import { searchDiscovery } from '../searxng.tool.js';
import { scrapeAndExtractCompanies, scrapeAndExtractPeople } from './page-scraper.js';
import logger from '../../utils/logger.js';
import type { DiscoveryParams, PeopleDiscoveryParams, RawCompanyResult, RawPersonResult } from './types.js';

const searchLimit = pLimit(10);
const SEARCH_DELAY_MS = 200;
const MAX_SCRAPE_URLS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Query generation ────────────────────────────────────────────────────────

function generateCompanyQueries(params: DiscoveryParams): string[] {
  const queries: string[] = [];
  const keywords = params.keywords?.join(' ') ?? '';
  const location = params.location ?? '';
  const industry = params.industry ?? '';
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;

  // 1. Direct queries
  if (keywords) {
    queries.push(`"${keywords}" companies ${location}`.trim());
  }
  if (industry) {
    queries.push(`"top ${industry} companies ${location}"`.trim());
  }

  // 2. Hiring signals
  if (keywords) {
    queries.push(`"${keywords}" hiring ${location}`.trim());
    queries.push(`"${keywords}" jobs.lever.co`);
    queries.push(`"${keywords}" boards.greenhouse.io`);
  }

  // 3. Funding/news
  if (keywords || industry) {
    const term = keywords || industry;
    queries.push(`"${term}" ${location} funding OR raised`.trim());
    queries.push(`"${industry || keywords}" ${location} "million" funding ${lastYear} OR ${currentYear}`.trim());
  }

  // 4. Directories
  if (industry) {
    queries.push(`"top ${industry} companies" ${location} list`.trim());
    queries.push(`"${industry}" companies directory ${location}`.trim());
  }

  // 5. Tech stack queries
  if (params.techStack?.length) {
    for (const tech of params.techStack.slice(0, 3)) {
      queries.push(`"${tech}" company ${location}`.trim());
    }
  }

  // 6. Events
  if (industry) {
    queries.push(`"${industry}" conference speakers ${location} ${lastYear} OR ${currentYear}`.trim());
  }

  // 7. Publications / awards
  if (industry) {
    queries.push(`"${industry}" awards ${location}`.trim());
    queries.push(`"fastest growing" "${industry}" ${location}`.trim());
  }

  return queries.filter((q) => q.length > 5);
}

function generatePeopleQueries(params: PeopleDiscoveryParams): string[] {
  const queries: string[] = [];
  const company = params.companyName ?? '';
  const roles = params.targetRoles ?? ['CEO', 'CTO', 'VP'];

  for (const role of roles.slice(0, 3)) {
    queries.push(`"${role}" "${company}"`.trim());
  }

  if (company) {
    queries.push(`"${company}" leadership team`);
    queries.push(`"${company}" "our team" OR "about us"`);
  }

  return queries.filter((q) => q.length > 5);
}

// ── Confidence mapping ──────────────────────────────────────────────────────

function getConfidence(url: string): number {
  if (url.includes('lever.co') || url.includes('greenhouse.io')) return 65;
  if (url.includes('crunchbase.com')) return 65;
  if (url.includes('linkedin.com')) return 60;
  if (url.includes('techcrunch.com') || url.includes('venturebeat.com')) return 55;
  return 50;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function enhancedWebSearch(
  params: DiscoveryParams,
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const queries = generateCompanyQueries(params);
  if (queries.length === 0) return [];

  const allResults: RawCompanyResult[] = [];
  const uniqueUrls = new Set<string>();

  // Fire all queries with rate limiting
  const searchTasks = queries.map((query, i) =>
    searchLimit(async () => {
      try {
        if (i > 0) await sleep(SEARCH_DELAY_MS);
        return await searchDiscovery(tenantId, query, 5);
      } catch (err) {
        logger.debug({ err, query }, 'Web search query failed');
        return [];
      }
    }),
  );

  const settled = await Promise.allSettled(searchTasks);

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const sr of result.value) {
      // Basic company data from search snippets
      const confidence = getConfidence(sr.url);
      allResults.push({
        name: sr.title.split(/[|–—\-]/)[0]?.trim() ?? '',
        description: sr.snippet.slice(0, 200),
        source: `web_search:${new URL(sr.url).hostname}`,
        confidence,
        rawData: { url: sr.url, snippet: sr.snippet },
      });

      // Collect unique URLs for scraping
      if (!uniqueUrls.has(sr.url) && !sr.url.includes('linkedin.com') && !sr.url.includes('facebook.com')) {
        uniqueUrls.add(sr.url);
      }
    }
  }

  // Scrape top unique URLs for LLM extraction
  const urlsToScrape = [...uniqueUrls].slice(0, MAX_SCRAPE_URLS);
  if (urlsToScrape.length > 0) {
    try {
      const scraped = await scrapeAndExtractCompanies(urlsToScrape, tenantId);
      allResults.push(...scraped);
    } catch (err) {
      logger.debug({ err }, 'Web search scraping failed');
    }
  }

  return allResults.filter((r) => r.name);
}

export async function enhancedWebSearchPeople(
  params: PeopleDiscoveryParams,
  tenantId: string,
): Promise<RawPersonResult[]> {
  const queries = generatePeopleQueries(params);
  if (queries.length === 0) return [];

  const allResults: RawPersonResult[] = [];
  const uniqueUrls = new Set<string>();

  const searchTasks = queries.map((query, i) =>
    searchLimit(async () => {
      try {
        if (i > 0) await sleep(SEARCH_DELAY_MS);
        return await searchDiscovery(tenantId, query, 5);
      } catch (err) {
        logger.debug({ err, query }, 'Web people search failed');
        return [];
      }
    }),
  );

  const settled = await Promise.allSettled(searchTasks);

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const sr of result.value) {
      // Try to extract person info from title/snippet
      const titleMatch = sr.title.match(/^([A-Z][a-zÀ-ÿ]+ [A-Z][a-zÀ-ÿ]+(?:\s[A-Z][a-zÀ-ÿ]+)?)\s*[-–—|]/);
      if (titleMatch) {
        const nameParts = titleMatch[1]!.split(/\s+/);
        allResults.push({
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(' '),
          fullName: titleMatch[1],
          companyName: params.companyName,
          source: `web_search:${new URL(sr.url).hostname}`,
          confidence: 50,
          rawData: { url: sr.url, snippet: sr.snippet },
        });
      }

      if (!uniqueUrls.has(sr.url) && !sr.url.includes('linkedin.com')) {
        uniqueUrls.add(sr.url);
      }
    }
  }

  // Scrape top URLs for people extraction
  const urlsToScrape = [...uniqueUrls].slice(0, 5);
  if (urlsToScrape.length > 0) {
    try {
      const scraped = await scrapeAndExtractPeople(urlsToScrape, tenantId);
      for (const p of scraped) {
        if (!p.companyName) p.companyName = params.companyName;
      }
      allResults.push(...scraped);
    } catch (err) {
      logger.debug({ err }, 'Web people search scraping failed');
    }
  }

  return allResults;
}
