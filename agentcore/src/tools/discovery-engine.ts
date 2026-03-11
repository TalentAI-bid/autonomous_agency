import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';
import { searchEnterpriseRegistries, searchEnterpriseRegistriesPeople } from './discovery-sources/enterprise-registries.js';
import { searchBusinessDatabases, searchBusinessDatabasesPeople } from './discovery-sources/business-databases.js';
import { searchTechSources, searchTechSourcesPeople } from './discovery-sources/tech-industry.js';
import { searchProfessionalNetworks, searchProfessionalNetworksPeople } from './discovery-sources/professional-networks.js';
import { enhancedWebSearch, enhancedWebSearchPeople } from './discovery-sources/web-search-engine.js';
import { searchRedditIntelligence, searchRedditIntelligencePeople } from './discovery-sources/reddit-intelligence.js';
import { deduplicateCompanies, deduplicatePeople } from './discovery-sources/deduplication.js';
import type {
  DiscoveryParams,
  PeopleDiscoveryParams,
  DiscoveryResult,
  RawCompanyResult,
  RawPersonResult,
  MergedPersonResult,
} from './discovery-sources/types.js';

// ── Constants ───────────────────────────────────────────────────────────────

const OVERALL_TIMEOUT_MS = 120_000;
const PLAN_CACHE_TTL = 12 * 3600; // 12 hours
const COMPANY_CACHE_TTL = 30 * 24 * 3600; // 30 days

// ── Source definitions ──────────────────────────────────────────────────────

interface SourceDef {
  name: string;
  search: (params: DiscoveryParams, tenantId: string) => Promise<RawCompanyResult[]>;
}

interface PeopleSourceDef {
  name: string;
  search: (params: PeopleDiscoveryParams, tenantId: string) => Promise<RawPersonResult[]>;
}

const COMPANY_SOURCES: SourceDef[] = [
  { name: 'enterprise_registries', search: searchEnterpriseRegistries },
  { name: 'business_databases', search: searchBusinessDatabases },
  { name: 'tech_sources', search: searchTechSources },
  { name: 'professional_networks', search: searchProfessionalNetworks },
  { name: 'web_search', search: enhancedWebSearch },
  { name: 'reddit_intelligence', search: searchRedditIntelligence },
];

const PEOPLE_SOURCES: PeopleSourceDef[] = [
  { name: 'business_databases', search: searchBusinessDatabasesPeople },
  { name: 'tech_sources', search: searchTechSourcesPeople },
  { name: 'professional_networks', search: searchProfessionalNetworksPeople },
  { name: 'web_search', search: enhancedWebSearchPeople },
  { name: 'reddit_intelligence', search: searchRedditIntelligencePeople },
];

// ── Discovery Engine ────────────────────────────────────────────────────────

class DiscoveryEngine {
  private redis: Redis;

  constructor() {
    this.redis = createRedisConnection();
  }

  async discoverCompanies(params: DiscoveryParams, tenantId: string): Promise<DiscoveryResult> {
    const startTime = Date.now();
    const paramsHash = createHash('md5').update(JSON.stringify(params)).digest('hex');
    const planCacheKey = `discovery:plan:${paramsHash}`;

    // Check plan cache
    try {
      const cached = await this.redis.get(planCacheKey);
      if (cached) {
        logger.info({ tenantId, paramsHash }, 'Discovery result served from cache');
        const result = JSON.parse(cached) as DiscoveryResult;
        result.metadata.fromCache = true;
        return result;
      }
    } catch { /* continue */ }

    logger.info({ tenantId, params, sourceCount: COMPANY_SOURCES.length }, 'Discovery engine starting company search');

    // Fire all source categories in parallel with overall timeout
    const allRaw: RawCompanyResult[] = [];
    const allPeopleRaw: RawPersonResult[] = [];
    const failedSources: string[] = [];
    let successfulSources = 0;

    const sourcePromises = COMPANY_SOURCES.map(async (source) => {
      try {
        const results = await source.search(params, tenantId);
        return { name: source.name, results, error: null };
      } catch (err) {
        logger.warn({ err, source: source.name }, 'Discovery source failed');
        return { name: source.name, results: [] as RawCompanyResult[], error: err };
      }
    });

    // Also search for people in parallel
    const peopleParams: PeopleDiscoveryParams = {
      targetRoles: params.targetRoles,
      maxResults: params.maxResults,
    };

    const peoplePromises = PEOPLE_SOURCES.map(async (source) => {
      try {
        const results = await source.search(peopleParams, tenantId);
        return { name: source.name, results, error: null };
      } catch (err) {
        logger.warn({ err, source: source.name }, 'People discovery source failed');
        return { name: source.name, results: [] as RawPersonResult[], error: err };
      }
    });

    // Race against timeout
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), OVERALL_TIMEOUT_MS),
    );

    const allPromises = Promise.allSettled([...sourcePromises, ...peoplePromises]);
    const raceResult = await Promise.race([allPromises, timeoutPromise]);

    if (raceResult === 'timeout') {
      logger.warn({ tenantId, durationMs: Date.now() - startTime }, 'Discovery engine timed out');
      failedSources.push('timeout');
    }

    // Collect results from settled promises
    const settled = raceResult === 'timeout'
      ? await Promise.allSettled([...sourcePromises, ...peoplePromises])
      : raceResult;

    for (let i = 0; i < COMPANY_SOURCES.length; i++) {
      const result = settled[i];
      if (result?.status === 'fulfilled') {
        const { name, results, error } = result.value as { name: string; results: RawCompanyResult[]; error: unknown };
        if (error) {
          failedSources.push(name);
        } else {
          allRaw.push(...results);
          if (results.length > 0) successfulSources++;
        }
      } else {
        failedSources.push(COMPANY_SOURCES[i]!.name);
      }
    }

    for (let i = 0; i < PEOPLE_SOURCES.length; i++) {
      const result = settled[COMPANY_SOURCES.length + i];
      if (result?.status === 'fulfilled') {
        const { results } = result.value as { name: string; results: RawPersonResult[]; error: unknown };
        allPeopleRaw.push(...results);
      }
    }

    // Deduplicate
    const companies = deduplicateCompanies(allRaw);
    const people = deduplicatePeople(allPeopleRaw);

    // Apply maxResults limit
    const maxResults = params.maxResults ?? 50;
    const limitedCompanies = companies.slice(0, maxResults);
    const limitedPeople = people.slice(0, maxResults);

    const durationMs = Date.now() - startTime;

    const discoveryResult: DiscoveryResult = {
      companies: limitedCompanies,
      people: limitedPeople,
      metadata: {
        totalSources: COMPANY_SOURCES.length,
        successfulSources,
        failedSources,
        durationMs,
        fromCache: false,
      },
    };

    // Cache the plan result
    try {
      await this.redis.setex(planCacheKey, PLAN_CACHE_TTL, JSON.stringify(discoveryResult));
    } catch { /* non-critical */ }

    // Cache individual company results by domain
    for (const company of limitedCompanies) {
      if (company.domain) {
        const domainKey = `discovery:company:${company.domain}`;
        try {
          await this.redis.setex(domainKey, COMPANY_CACHE_TTL, JSON.stringify(company));
        } catch { /* non-critical */ }
      }
    }

    logger.info(
      {
        tenantId,
        companiesFound: limitedCompanies.length,
        peopleFound: limitedPeople.length,
        rawCompanies: allRaw.length,
        rawPeople: allPeopleRaw.length,
        successfulSources,
        failedSources,
        durationMs,
      },
      'Discovery engine completed',
    );

    return discoveryResult;
  }

  async discoverPeople(params: PeopleDiscoveryParams, tenantId: string): Promise<MergedPersonResult[]> {
    const startTime = Date.now();
    const allRaw: RawPersonResult[] = [];

    logger.info({ tenantId, params, sourceCount: PEOPLE_SOURCES.length }, 'Discovery engine starting people search');

    const sourcePromises = PEOPLE_SOURCES.map(async (source) => {
      try {
        return await source.search(params, tenantId);
      } catch (err) {
        logger.warn({ err, source: source.name }, 'People discovery source failed');
        return [];
      }
    });

    const settled = await Promise.allSettled(sourcePromises);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        allRaw.push(...result.value);
      }
    }

    const merged = deduplicatePeople(allRaw);
    const maxResults = params.maxResults ?? 50;

    logger.info(
      { tenantId, rawPeople: allRaw.length, mergedPeople: merged.length, durationMs: Date.now() - startTime },
      'People discovery completed',
    );

    return merged.slice(0, maxResults);
  }
}

// ── Singleton export ────────────────────────────────────────────────────────

export const discoveryEngine = new DiscoveryEngine();
