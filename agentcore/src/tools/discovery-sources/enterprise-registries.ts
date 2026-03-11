import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { env } from '../../config/env.js';
import { createRedisConnection } from '../../queues/setup.js';
import logger from '../../utils/logger.js';
import type { DiscoveryParams, PeopleDiscoveryParams, RawCompanyResult, RawPersonResult } from './types.js';

const redis: Redis = createRedisConnection();
const apiLimit = pLimit(2);
const API_DELAY_MS = 1000;
const CACHE_TTL_90D = 90 * 24 * 3600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nameHash(name: string): string {
  return createHash('md5').update(name.toLowerCase().trim()).digest('hex');
}

// ── OpenCorporates ──────────────────────────────────────────────────────────

async function searchOpenCorporates(query: string): Promise<RawCompanyResult[]> {
  const cacheKey = `discovery:registry:global:opencorp:${nameHash(query)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as RawCompanyResult[];
  } catch { /* continue */ }

  try {
    let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(query)}&per_page=5`;
    if (env.OPENCORPORATES_API_TOKEN) {
      url += `&api_token=${env.OPENCORPORATES_API_TOKEN}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.debug({ status: response.status }, 'OpenCorporates search failed');
      return [];
    }

    const data = await response.json() as {
      results?: {
        companies?: Array<{
          company?: {
            name?: string;
            company_number?: string;
            jurisdiction_code?: string;
            incorporation_date?: string;
            registered_address_in_full?: string;
            opencorporates_url?: string;
          };
        }>;
      };
    };

    const results: RawCompanyResult[] = (data.results?.companies ?? []).map((item) => {
      const c = item.company;
      return {
        name: c?.name ?? '',
        headquarters: c?.registered_address_in_full ?? undefined,
        foundedYear: c?.incorporation_date ? parseInt(c.incorporation_date.slice(0, 4), 10) || undefined : undefined,
        source: 'opencorporates',
        confidence: 60,
        rawData: {
          companyNumber: c?.company_number,
          jurisdictionCode: c?.jurisdiction_code,
          opencorporatesUrl: c?.opencorporates_url,
        },
      };
    }).filter((r) => r.name);

    await redis.setex(cacheKey, CACHE_TTL_90D, JSON.stringify(results)).catch(() => {});
    return results;
  } catch (err) {
    logger.debug({ err, query }, 'OpenCorporates search error');
    return [];
  }
}

// ── Companies House UK ──────────────────────────────────────────────────────

async function searchCompaniesHouse(query: string): Promise<RawCompanyResult[]> {
  if (!env.COMPANIES_HOUSE_API_KEY) return [];

  const cacheKey = `discovery:registry:global:companieshouse:${nameHash(query)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as RawCompanyResult[];
  } catch { /* continue */ }

  try {
    const url = `https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(query)}&items_per_page=5`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${Buffer.from(env.COMPANIES_HOUSE_API_KEY + ':').toString('base64')}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json() as {
      items?: Array<{
        title?: string;
        company_number?: string;
        date_of_creation?: string;
        address_snippet?: string;
        company_status?: string;
      }>;
    };

    const results: RawCompanyResult[] = (data.items ?? []).map((item) => ({
      name: item.title ?? '',
      headquarters: item.address_snippet ?? undefined,
      foundedYear: item.date_of_creation ? parseInt(item.date_of_creation.slice(0, 4), 10) || undefined : undefined,
      source: 'companies_house',
      confidence: 65,
      rawData: {
        companyNumber: item.company_number,
        companyStatus: item.company_status,
      },
    })).filter((r) => r.name);

    await redis.setex(cacheKey, CACHE_TTL_90D, JSON.stringify(results)).catch(() => {});
    return results;
  } catch (err) {
    logger.debug({ err, query }, 'Companies House search error');
    return [];
  }
}

// ── SEC EDGAR ───────────────────────────────────────────────────────────────

async function searchSECEdgar(query: string): Promise<RawCompanyResult[]> {
  const cacheKey = `discovery:registry:global:edgar:${nameHash(query)}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as RawCompanyResult[];
  } catch { /* continue */ }

  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}&dateRange=custom&startdt=2020-01-01&forms=10-K`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'AgentCore/1.0 (contact@agentcore.dev)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json() as {
      hits?: {
        hits?: Array<{
          _source?: {
            entity_name?: string;
            file_date?: string;
            display_names?: string[];
          };
        }>;
      };
    };

    const results: RawCompanyResult[] = (data.hits?.hits ?? []).slice(0, 5).map((hit) => ({
      name: hit._source?.entity_name ?? hit._source?.display_names?.[0] ?? '',
      source: 'sec_edgar',
      confidence: 55,
      rawData: { fileDate: hit._source?.file_date },
    })).filter((r) => r.name);

    await redis.setex(cacheKey, CACHE_TTL_90D, JSON.stringify(results)).catch(() => {});
    return results;
  } catch (err) {
    logger.debug({ err, query }, 'SEC EDGAR search error');
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function searchEnterpriseRegistries(
  params: DiscoveryParams,
  _tenantId: string,
): Promise<RawCompanyResult[]> {
  const queries: string[] = [];
  if (params.keywords?.length) queries.push(...params.keywords.slice(0, 3));
  if (params.industry) queries.push(params.industry);
  if (queries.length === 0) return [];

  const allResults: RawCompanyResult[] = [];

  const tasks = queries.flatMap((query) => [
    apiLimit(async () => {
      await sleep(API_DELAY_MS);
      return searchOpenCorporates(query);
    }),
    apiLimit(async () => {
      await sleep(API_DELAY_MS);
      return searchCompaniesHouse(query);
    }),
    apiLimit(async () => {
      await sleep(API_DELAY_MS);
      return searchSECEdgar(query);
    }),
  ]);

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  return allResults;
}

export async function searchEnterpriseRegistriesPeople(
  _params: PeopleDiscoveryParams,
  _tenantId: string,
): Promise<RawPersonResult[]> {
  // Registries don't have people data
  return [];
}
