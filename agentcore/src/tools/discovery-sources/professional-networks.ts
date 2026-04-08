import pLimit from 'p-limit';
import { searchDiscovery } from '../searxng.tool.js';
import { scrapeAndExtractCompanies } from './page-scraper.js';
import logger from '../../utils/logger.js';
import type { DiscoveryParams, PeopleDiscoveryParams, RawCompanyResult, RawPersonResult } from './types.js';

const searchLimit = pLimit(10);
const SEARCH_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── LinkedIn Companies ──────────────────────────────────────────────────────

async function searchLinkedInCompanies(
  query: string,
  location: string | undefined,
  tenantId: string,
): Promise<RawCompanyResult[]> {
  try {
    const locationPart = location ? ` "${location}"` : '';
    await sleep(SEARCH_DELAY_MS);
    const results = await searchDiscovery(
      tenantId,
      `"${query}"${locationPart} linkedin company`,
      5,
    );

    return results
      .filter((r) => r.url.includes('linkedin.com/company/'))
      .map((r) => {
        // Extract company name from title: "Company Name | LinkedIn"
        const name = r.title.split(/[|–—]/)[0]?.trim() ?? query;
        return {
          name,
          linkedinUrl: r.url,
          description: r.snippet.slice(0, 200),
          source: 'linkedin',
          confidence: 70,
          rawData: { linkedinSnippet: r.snippet },
        };
      });
  } catch (err) {
    logger.debug({ err, query }, 'LinkedIn company search error');
    return [];
  }
}

// ── LinkedIn People ─────────────────────────────────────────────────────────

function parseLinkedInPersonFromResult(
  result: { url: string; title: string; snippet: string },
  companyName?: string,
): RawPersonResult | null {
  if (!result.url.includes('linkedin.com/in/')) return null;

  // Title format: "First Last - Title at Company | LinkedIn"
  const titleMatch = result.title.match(/^([A-Z][a-zÀ-ÿ]+ [A-Z][a-zÀ-ÿ]+(?:\s[A-Z][a-zÀ-ÿ]+)?)\s*[-–—]\s*(.+?)(?:\s*[|])/);
  if (!titleMatch) {
    // Simpler format: "First Last | LinkedIn"
    const simpleMatch = result.title.match(/^([A-Z][a-zÀ-ÿ]+ [A-Z][a-zÀ-ÿ]+(?:\s[A-Z][a-zÀ-ÿ]+)?)\s*[|]/);
    if (!simpleMatch) return null;

    const nameParts = simpleMatch[1]!.split(/\s+/);
    return {
      firstName: nameParts[0],
      lastName: nameParts.slice(1).join(' '),
      fullName: simpleMatch[1],
      linkedinUrl: result.url,
      companyName,
      source: 'linkedin',
      confidence: 60,
      rawData: { snippet: result.snippet },
    };
  }

  const nameParts = titleMatch[1]!.split(/\s+/);
  const titleText = titleMatch[2]?.trim();

  // Try to extract company from title: "CTO at Acme Corp"
  let extractedCompany = companyName;
  let jobTitle = titleText;
  const atMatch = titleText?.match(/^(.+?)\s+at\s+(.+)$/i);
  if (atMatch) {
    jobTitle = atMatch[1]?.trim();
    if (!extractedCompany) extractedCompany = atMatch[2]?.trim();
  }

  return {
    firstName: nameParts[0],
    lastName: nameParts.slice(1).join(' '),
    fullName: titleMatch[1],
    title: jobTitle,
    companyName: extractedCompany,
    linkedinUrl: result.url,
    source: 'linkedin',
    confidence: 65,
    rawData: { snippet: result.snippet },
  };
}

async function searchLinkedInPeople(
  companyName: string,
  targetRoles: string[],
  tenantId: string,
): Promise<RawPersonResult[]> {
  const results: RawPersonResult[] = [];
  const queries: string[] = [];

  // Role-specific queries
  for (const role of targetRoles.slice(0, 3)) {
    queries.push(`"${role}" "${companyName}" linkedin profile`);
  }

  // Leadership queries
  queries.push(`"${companyName}" CEO CTO VP linkedin profile`);
  queries.push(`"founder" "${companyName}" linkedin profile`);

  const tasks = queries.map((query) =>
    searchLimit(async () => {
      try {
        await sleep(SEARCH_DELAY_MS);
        const searchResults = await searchDiscovery(tenantId, query, 5);
        const people: RawPersonResult[] = [];
        for (const sr of searchResults) {
          const person = parseLinkedInPersonFromResult(sr, companyName);
          if (person) people.push(person);
        }
        return people;
      } catch (err) {
        logger.debug({ err, query }, 'LinkedIn people search failed');
        return [];
      }
    }),
  );

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(...result.value);
    }
  }

  return results;
}

// ── Twitter/X ───────────────────────────────────────────────────────────────

async function searchTwitter(query: string, tenantId: string): Promise<RawCompanyResult[]> {
  try {
    await sleep(SEARCH_DELAY_MS);
    const results = await searchDiscovery(
      tenantId,
      `"${query}" twitter x.com profile`,
      3,
    );

    return results
      .filter((r) => r.url.includes('twitter.com') || r.url.includes('x.com'))
      .map((r) => ({
        name: query,
        description: r.snippet.slice(0, 200),
        source: 'twitter',
        confidence: 40,
        rawData: { twitterUrl: r.url, snippet: r.snippet },
      }));
  } catch (err) {
    logger.debug({ err, query }, 'Twitter search error');
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function searchProfessionalNetworks(
  params: DiscoveryParams,
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const queryTerms: string[] = [];
  if (params.keywords?.length) queryTerms.push(...params.keywords.slice(0, 3));
  if (params.industry) queryTerms.push(params.industry);
  if (queryTerms.length === 0) return [];

  const allResults: RawCompanyResult[] = [];

  const tasks: Array<Promise<RawCompanyResult[]>> = [];

  // LinkedIn company search
  for (const term of queryTerms.slice(0, 3)) {
    tasks.push(searchLimit(() => searchLinkedInCompanies(term, params.location, tenantId)));
  }

  // Twitter search
  for (const term of queryTerms.slice(0, 2)) {
    tasks.push(searchLimit(() => searchTwitter(term, tenantId)));
  }

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  return allResults;
}

export async function searchProfessionalNetworksPeople(
  params: PeopleDiscoveryParams,
  tenantId: string,
): Promise<RawPersonResult[]> {
  if (!params.companyName) return [];
  return searchLinkedInPeople(
    params.companyName,
    params.targetRoles ?? ['CEO', 'CTO', 'VP Engineering', 'Head of'],
    tenantId,
  );
}
