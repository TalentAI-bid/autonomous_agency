import pLimit from 'p-limit';
import { searchDiscovery } from '../searxng.tool.js';
import { scrapeAndExtractCompanies, scrapeAndExtractPeople } from './page-scraper.js';
import logger from '../../utils/logger.js';
import type { DiscoveryParams, PeopleDiscoveryParams, RawCompanyResult, RawPersonResult } from './types.js';

const searchLimit = pLimit(10);
const SEARCH_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Site-specific search helpers ────────────────────────────────────────────

interface SiteSearchConfig {
  site: string;
  queryTemplate: (name: string, location?: string) => string;
  confidence: number;
  source: string;
  scrapeTop?: number;
}

const SITES: SiteSearchConfig[] = [
  {
    site: 'crunchbase.com/organization',
    queryTemplate: (name) => `"${name}" crunchbase`,
    confidence: 75,
    source: 'crunchbase',
    scrapeTop: 1,
  },
  {
    site: 'wellfound.com/company',
    queryTemplate: (name) => `"${name}" wellfound`,
    confidence: 65,
    source: 'wellfound',
    scrapeTop: 1,
  },
  {
    site: 'g2.com/products',
    queryTemplate: (name) => `"${name}" g2`,
    confidence: 60,
    source: 'g2',
  },
  {
    site: 'glassdoor.com',
    queryTemplate: (name) => `"${name}" glassdoor overview`,
    confidence: 55,
    source: 'glassdoor',
  },
  {
    site: 'producthunt.com',
    queryTemplate: (name) => `"${name}" producthunt`,
    confidence: 55,
    source: 'producthunt',
  },
  {
    site: 'clutch.co',
    queryTemplate: (name) => `"${name}" clutch.co`,
    confidence: 55,
    source: 'clutch',
  },
  {
    site: 'capterra.com',
    queryTemplate: (name) => `"${name}" capterra`,
    confidence: 50,
    source: 'capterra',
  },
  {
    site: 'trustpilot.com',
    queryTemplate: (name) => `"${name}" trustpilot`,
    confidence: 45,
    source: 'trustpilot',
  },
];

async function searchSite(
  config: SiteSearchConfig,
  queryTerms: string[],
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const results: RawCompanyResult[] = [];

  for (const term of queryTerms.slice(0, 2)) {
    try {
      await sleep(SEARCH_DELAY_MS);
      const searchResults = await searchDiscovery(tenantId, config.queryTemplate(term), 5);

      // Extract basic info from search snippets
      for (const sr of searchResults) {
        if (!sr.url.includes(config.site.split('/')[0]!)) continue;
        results.push({
          name: term,
          domain: extractDomainFromSnippet(sr.snippet) ?? undefined,
          description: sr.snippet.slice(0, 200),
          source: config.source,
          confidence: config.confidence,
          rawData: { url: sr.url, snippet: sr.snippet },
        });
      }

      // Optionally scrape top results for richer data
      if (config.scrapeTop && searchResults.length > 0) {
        const urlsToScrape = searchResults
          .filter((sr) => sr.url.includes(config.site.split('/')[0]!))
          .slice(0, config.scrapeTop)
          .map((sr) => sr.url);

        if (urlsToScrape.length > 0) {
          try {
            const scraped = await scrapeAndExtractCompanies(urlsToScrape, tenantId);
            for (const s of scraped) {
              s.source = config.source;
              s.confidence = config.confidence;
            }
            results.push(...scraped);
          } catch (err) {
            logger.debug({ err, source: config.source }, 'Scraping business database failed');
          }
        }
      }
    } catch (err) {
      logger.debug({ err, source: config.source, term }, 'Business database search failed');
    }
  }

  return results;
}

function extractDomainFromSnippet(snippet: string): string | null {
  const match = snippet.match(/(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/);
  return match?.[1] ?? null;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function searchBusinessDatabases(
  params: DiscoveryParams,
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const queryTerms: string[] = [];
  if (params.keywords?.length) queryTerms.push(...params.keywords.slice(0, 3));
  if (params.industry) queryTerms.push(params.industry);
  if (queryTerms.length === 0) return [];

  const allResults: RawCompanyResult[] = [];

  const tasks = SITES.map((config) =>
    searchLimit(async () => {
      try {
        return await searchSite(config, queryTerms, tenantId);
      } catch (err) {
        logger.debug({ err, source: config.source }, 'Business database source failed');
        return [];
      }
    }),
  );

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  return allResults;
}

export async function searchBusinessDatabasesPeople(
  params: PeopleDiscoveryParams,
  tenantId: string,
): Promise<RawPersonResult[]> {
  const results: RawPersonResult[] = [];
  if (!params.companyName) return results;

  const tasks = [
    // Wellfound team pages
    searchLimit(async () => {
      try {
        await sleep(SEARCH_DELAY_MS);
        const searchResults = await searchDiscovery(
          tenantId,
          `"${params.companyName}" wellfound team`,
          3,
        );
        const urls = searchResults.map((sr) => sr.url).filter((u) => u.includes('wellfound.com'));
        if (urls.length > 0) {
          return await scrapeAndExtractPeople(urls.slice(0, 1), tenantId);
        }
        return [];
      } catch (err) {
        logger.debug({ err }, 'Wellfound people search failed');
        return [];
      }
    }),

    // Glassdoor CEO/leadership
    searchLimit(async () => {
      try {
        await sleep(SEARCH_DELAY_MS);
        const searchResults = await searchDiscovery(
          tenantId,
          `"${params.companyName}" glassdoor CEO leadership`,
          3,
        );
        const people: RawPersonResult[] = [];
        for (const sr of searchResults) {
          // Try to extract name from title: "John Smith - CEO at Company | Glassdoor"
          const titleMatch = sr.title.match(/^([A-Z][a-z]+ [A-Z][a-z]+)\s*[-–—]\s*(.+?)(?:\s*[|@])/);
          if (titleMatch) {
            const nameParts = titleMatch[1]!.split(' ');
            people.push({
              firstName: nameParts[0],
              lastName: nameParts.slice(1).join(' '),
              fullName: titleMatch[1],
              title: titleMatch[2]?.trim(),
              companyName: params.companyName,
              source: 'glassdoor',
              confidence: 50,
              rawData: { url: sr.url },
            });
          }
        }
        return people;
      } catch (err) {
        logger.debug({ err }, 'Glassdoor people search failed');
        return [];
      }
    }),
  ];

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(...result.value);
    }
  }

  return results;
}
