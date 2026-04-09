/**
 * CompanyFinderAgent — the replacement for DiscoveryAgent.
 *
 * Pipeline:
 *   1. Mission analysis → LLM picks sites from SITE_CONFIGS + keyword pool
 *   2. Site crawl      → smart-crawler.crawlSite for each chosen site
 *   3. Extraction      → LLM extracts JobListing[] or CompanyEntry[] per page
 *   4. Dedupe + filter → normalize names, drop job-board self-references,
 *                        drop mega-corp and skip-domains
 *   5. Domain backfill → Google-SERP-extract per company missing a domain
 *   6. Persist + dispatch → saveOrUpdateCompany + dispatchNext('enrichment')
 *
 * Gated by env.USE_COMPANY_FINDER in master-agent.ts. When false, master
 * dispatches the legacy DiscoveryAgent instead.
 */

import { BaseAgent } from './base-agent.js';
import type { AgentType } from '../queues/queues.js';
import { SITE_CONFIGS } from '../config/site-configs.js';
import { crawlSite, crawlGoogleAndExtractUrls } from '../tools/smart-crawler.js';
import * as cfPrompt from '../prompts/company-finder.prompt.js';
import { isMegaCorp, shouldSkipDomain } from '../utils/domain-blocklist.js';
import type { PipelineContext } from '../types/pipeline-context.js';
import { SMART_MODEL } from '../tools/together-ai.tool.js';
import logger from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface MissionContext {
  mission: string;
  locations?: string[];
  industries?: string[];
  targetRoles?: string[];
  requiredSkills?: string[];
  experienceLevel?: string;
  keywords?: string[];
}

interface CompanyFinderInput {
  masterAgentId: string;
  missionContext: MissionContext;
  pipelineContext?: PipelineContext;
  dryRun?: boolean;
}

interface CompanyFinderMetrics {
  sitesCrawled: number;
  pagesScraped: number;
  listingsExtracted: number;
  uniqueCompanies: number;
  saved: number;
  dispatched: number;
}

interface CompanyFinderOutput {
  status: 'completed' | 'failed';
  metrics: CompanyFinderMetrics;
  error?: string;
}

// Aggregated record we build during dedupe
interface AggregatedCompany {
  displayName: string;
  domain: string | null;
  discoveryUrls: string[];
  discoverySite: string;
  sourceType: 'job_board' | 'company_database';
  jobTitles: string[];
  jobLocations: string[];
  descriptions: string[];
  relevanceScore?: number;
  industry?: string;
  location?: string;
  size?: string;
  revenue?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Strip common legal suffixes for dedupe (anchored at end, optional period). */
const LEGAL_SUFFIX_RE = /\s+(SAS|SARL|SA|SRL|Ltd|Inc|GmbH|LLC|BV|AG|Pty|PLC|Corp|Co|Limited|Incorporated|Corporation)\.?$/i;

/** Names that should never be saved as a company (job boards self-referencing). */
const COMPANY_NAME_BLOCKLIST = new Set([
  'unknown', 'n/a', 'na',
  'indeed', 'linkedin', 'glassdoor', 'monster',
  'welcome to the jungle', 'welcometothejungle',
  'apec', 'pole emploi', 'pôle emploi', 'france travail',
  'freework', 'free-work', 'free work',
  'stepstone', 'step stone', 'dice',
  'job bank', 'jobbank', 'jobbank canada',
  'infojobs', 'cvkeskus', 'irishjobs', 'irish jobs',
  'societe.com', 'societe',
  'crunchbase', 'bloomberg', 'zoominfo', 'apollo',
  'rocketreach', 'wikipedia',
]);

/** Listicle/article-title regexes (case-insensitive). Anything matching these is junk. */
const ARTICLE_TITLE_PATTERNS: RegExp[] = [
  /^category:/i,
  /\bbest\b.*\bcompanies\b/i,
  /\btop\s+\d*\s*\b.*\bcompanies\b/i,
  /\blargest\b.*\bcompanies\b/i,
  /\blist of\b/i,
  /\b20(2\d|3\d)\b/,
  /\d[\d,]*\+/,
  /\bcompanies of\b/i,
  /\bcompanies in\b/i,
];

/** Stopwords for last-resort mission-text tokenization fallback (BUG 1 Fallback 3). */
const STOPWORDS = new Set([
  'find','hire','recruit','source','companies','company','people','candidates',
  'looking','need','want','with','that','from','about','their','they','have',
  'will','would','should','also','more','than','some','these','those','this',
  'into','onto','using','use','for','the','and','our','you','your','who','what',
  'when','where','why','how','any','all','best','top','must','can','are',
]);

/** Cap on per-company Google domain backfills to avoid SERP blocks on large missions. */
const MAX_DOMAIN_BACKFILLS = 20;

/** Hard cap on the keyword pool fed to crawlSite. Each keyword × site × page = 1 Crawl4AI request. */
const MAX_KEYWORDS = 6;

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeCompanyKey(name: string): string {
  const stripped = name.trim().replace(LEGAL_SUFFIX_RE, '').trim();
  return stripped.toLowerCase().replace(/\s+/g, ' ');
}

function isBlockedCompanyName(name: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (trimmed.length < 2) return true;
  if (trimmed.length > 60) return true;

  const key = normalizeCompanyKey(trimmed);
  if (!key || key.length < 2) return true;
  if (COMPANY_NAME_BLOCKLIST.has(key)) return true;

  for (const re of ARTICLE_TITLE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

/** Defensive sanitizer applied to LLM-returned searchKeywords. */
function isValidSearchKeyword(kw: string): boolean {
  const trimmed = kw.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  if (trimmed.split(/\s+/).length > 4) return false;
  if (/\b(best|top|largest|list of)\b/i.test(trimmed)) return false;
  if (/\b20[2-3]\d\b/.test(trimmed)) return false;
  if (/\d[\d,]*\+/.test(trimmed)) return false;
  if (/^category:/i.test(trimmed)) return false;
  return true;
}

function normalizeDomain(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).hostname.replace(/^www\./, '').toLowerCase();
    }
    if (trimmed.includes('.') && !trimmed.includes(' ')) {
      return trimmed.replace(/^www\./, '').toLowerCase();
    }
  } catch {
    // invalid URL
  }
  return null;
}

// ── Agent ──────────────────────────────────────────────────────────────────

export class CompanyFinderAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'company-finder' as AgentType });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const typedInput = input as unknown as CompanyFinderInput;
    const { masterAgentId, missionContext, pipelineContext, dryRun } = typedInput;
    const startedAt = Date.now();
    const metrics: CompanyFinderMetrics = {
      sitesCrawled: 0,
      pagesScraped: 0,
      listingsExtracted: 0,
      uniqueCompanies: 0,
      saved: 0,
      dispatched: 0,
    };

    // BUG C: company-finder must only consider job_board / company_database sites.
    // Profile sources (brave_linkedin_profiles, github_api, devto, etc.) belong
    // exclusively to the candidate-finder pipeline.
    const availableSiteKeys = Object.keys(SITE_CONFIGS).filter(
      (k) => !SITE_CONFIGS[k]!.profileType,
    );
    if (availableSiteKeys.length === 0) {
      logger.warn('CompanyFinder: SITE_CONFIGS is empty — nothing to crawl');
      return { status: 'completed', metrics };
    }

    // ── Phase 1: Mission analysis ──────────────────────────────────────────
    let analysis: cfPrompt.MissionAnalysis;
    try {
      analysis = await this.extractJSON<cfPrompt.MissionAnalysis>(
        [
          { role: 'system', content: cfPrompt.buildMissionAnalyzerSystemPrompt(availableSiteKeys) },
          {
            role: 'user',
            content: cfPrompt.buildMissionAnalyzerUserPrompt(missionContext),
          },
        ],
        2,
        { model: SMART_MODEL },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'CompanyFinder: mission analysis failed');
      return { status: 'failed', metrics, error: `mission analysis: ${msg}` };
    }

    // BUG A recovery: LLM sometimes returns a plain string array instead of the
    // MissionAnalysis object. Detect and reshape so downstream code is unaware.
    if (Array.isArray(analysis)) {
      logger.warn(
        { rawAnalysis: analysis },
        'CompanyFinder: LLM returned array instead of object — recovering to MissionAnalysis shape',
      );
      const arr = analysis as unknown as unknown[];
      analysis = {
        missionType: 'recruitment',
        searchKeywords: {
          en: arr.filter((k): k is string => typeof k === 'string').slice(0, 6),
          local: [],
        },
        targetCountry: ((missionContext.locations?.[0] ?? '').toLowerCase().slice(0, 2)) || '',
        targetCities: missionContext.locations ?? [],
        sitesToCrawl: ['welcometothejungle', 'linkedin_jobs', 'glassdoor'],
        reasoning: 'Recovered from malformed LLM response (array instead of object)',
      };
    }

    // BUG A defensive defaults: if individual required fields are missing, fill in
    // from missionContext / hardcoded fallbacks. Never crash on missing fields.
    if (!analysis || typeof analysis !== 'object') {
      logger.warn({ rawAnalysis: analysis }, 'CompanyFinder: analysis is not an object — using full defaults');
      analysis = {
        missionType: 'recruitment',
        searchKeywords: { en: [], local: [] },
        targetCountry: '',
        targetCities: missionContext.locations ?? [],
        sitesToCrawl: ['welcometothejungle', 'linkedin_jobs', 'glassdoor'],
        reasoning: 'Defaulted from null analysis',
      };
    }
    if (!analysis.searchKeywords || typeof analysis.searchKeywords !== 'object') {
      logger.warn('CompanyFinder: analysis.searchKeywords missing — filling from mission context');
      const fallbackEn = [
        ...(missionContext.targetRoles ?? []),
        ...(missionContext.requiredSkills ?? []),
        ...(missionContext.keywords ?? []),
      ].filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
      analysis.searchKeywords = { en: fallbackEn, local: [] };
    }
    if (!Array.isArray(analysis.sitesToCrawl) || analysis.sitesToCrawl.length === 0) {
      logger.warn('CompanyFinder: analysis.sitesToCrawl missing — using defaults');
      analysis.sitesToCrawl = ['welcometothejungle', 'linkedin_jobs', 'glassdoor'];
    }
    if (typeof analysis.targetCountry !== 'string') {
      analysis.targetCountry = '';
    }
    if (!Array.isArray(analysis.targetCities)) {
      analysis.targetCities = missionContext.locations ?? [];
    }

    logger.info(
      {
        masterAgentId,
        rawAnalysis: analysis,
      },
      'CompanyFinder: raw mission analysis',
    );

    logger.info(
      {
        missionType: analysis.missionType,
        targetCountry: analysis.targetCountry,
        sitesRequested: analysis.sitesToCrawl,
      },
      'CompanyFinder: mission analyzed',
    );

    // ── Validate site keys + country filter ───────────────────────────────
    const targetCountry = (analysis.targetCountry || '').toLowerCase();

    const requestedSites = Array.isArray(analysis.sitesToCrawl) ? analysis.sitesToCrawl : [];
    const validSites = requestedSites.filter((siteKey) => {
      const config = SITE_CONFIGS[siteKey];
      if (!config) {
        logger.warn({ siteKey }, 'CompanyFinder: LLM returned unknown site key, dropping');
        return false;
      }
      // BUG C: profile sources are candidate-finder-only.
      if (config.profileType) {
        logger.warn(
          { siteKey, profileType: config.profileType },
          'CompanyFinder: dropped profile source (candidate-finder only)',
        );
        return false;
      }
      if (!targetCountry) return true;
      if (config.countries.includes('all')) return true;
      return config.countries.includes(targetCountry);
    });

    // Fallback: if nothing passed filter, use 'all'-tagged sites (LinkedIn Jobs etc.)
    let sitesToCrawl =
      validSites.length > 0
        ? validSites
        : availableSiteKeys.filter((k) => SITE_CONFIGS[k]!.countries.includes('all'));

    // Hard fallback: if STILL empty, use a hard-coded set of always-on job boards.
    if (sitesToCrawl.length === 0) {
      const hardFallback = ['linkedin_jobs', 'glassdoor'].filter((k) => SITE_CONFIGS[k]);
      if (hardFallback.length > 0) {
        sitesToCrawl = hardFallback;
        logger.warn(
          { hardFallback, targetCountry },
          'CompanyFinder: no country/all matches — using hard fallback',
        );
      }
    }

    if (sitesToCrawl.length === 0) {
      logger.warn(
        { targetCountry, requested: requestedSites },
        'CompanyFinder: no valid sites after country filter',
      );
      return { status: 'completed', metrics };
    }

    // ── Build keyword pool with sanitization + fallback chain ─────────────
    const rawKeywords = this.pickKeywordPool(analysis.searchKeywords, targetCountry);
    const beforeCount = rawKeywords.length;
    let allKeywords = rawKeywords.filter(isValidSearchKeyword).slice(0, MAX_KEYWORDS);
    if (allKeywords.length < beforeCount) {
      logger.warn(
        { dropped: beforeCount - allKeywords.length, kept: allKeywords.length },
        'CompanyFinder: dropped malformed keywords from LLM analysis',
      );
    }

    // Fallback 1: master-agent provided hint keywords
    if (allKeywords.length === 0 && missionContext.keywords?.length) {
      allKeywords = missionContext.keywords.filter(isValidSearchKeyword).slice(0, MAX_KEYWORDS);
      if (allKeywords.length > 0) {
        logger.warn(
          { source: 'missionContext.keywords', count: allKeywords.length },
          'CompanyFinder: LLM returned empty keywords, falling back to mission hints',
        );
      }
    }

    // Fallback 2: targetRoles + requiredSkills
    if (allKeywords.length === 0) {
      const roleSkill = [
        ...(missionContext.targetRoles ?? []),
        ...(missionContext.requiredSkills ?? []),
      ].filter((s) => s && s.trim().length > 0);
      if (roleSkill.length > 0) {
        allKeywords = roleSkill.filter(isValidSearchKeyword).slice(0, MAX_KEYWORDS);
        if (allKeywords.length > 0) {
          logger.warn(
            { source: 'targetRoles+requiredSkills', count: allKeywords.length },
            'CompanyFinder: falling back to roles/skills as keywords',
          );
        }
      }
    }

    // Fallback 3: extract noun-like tokens from the mission text (last resort).
    if (allKeywords.length === 0 && missionContext.mission) {
      const tokens = missionContext.mission
        .toLowerCase()
        .split(/[^a-zà-ÿ0-9]+/i)
        .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
      allKeywords = Array.from(new Set(tokens)).slice(0, 5);
      if (allKeywords.length > 0) {
        logger.warn(
          { source: 'mission text tokens', count: allKeywords.length },
          'CompanyFinder: falling back to mission text tokenization',
        );
      }
    }

    if (allKeywords.length === 0) {
      logger.error('CompanyFinder: no keywords derivable from mission — aborting');
      return { status: 'completed', metrics };
    }

    const primaryCity = analysis.targetCities?.[0];

    logger.info(
      { masterAgentId, sitesToCrawl, allKeywords, primaryCity, targetCountry },
      'CompanyFinder: starting site crawling',
    );

    // ── Phase 2+3: Crawl + extract per site ────────────────────────────────
    type ExtractedListing = cfPrompt.JobListing & { siteKey: string; url: string };
    type ExtractedCompanyEntry = cfPrompt.CompanyEntry & { siteKey: string; url: string };

    const listings: ExtractedListing[] = [];
    const companyEntries: ExtractedCompanyEntry[] = [];

    for (const siteKey of sitesToCrawl) {
      const config = SITE_CONFIGS[siteKey]!;
      metrics.sitesCrawled++;

      let pages: Array<{ url: string; content: string }>;
      try {
        pages = await crawlSite(siteKey, allKeywords, primaryCity);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), siteKey },
          'CompanyFinder: crawlSite threw',
        );
        continue;
      }
      metrics.pagesScraped += pages.length;

      logger.info(
        { siteKey, pageCount: pages.length, urls: pages.map((p) => p.url) },
        'CompanyFinder: crawled site',
      );

      for (const page of pages) {
        const systemPrompt = cfPrompt.buildExtractionSystemPrompt(config.type, allKeywords, {
          industries: missionContext.industries,
          targetCountry,
        });
        const userPrompt = cfPrompt.buildExtractionUserPrompt({
          url: page.url,
          siteName: config.name,
          content: page.content,
        });

        try {
          if (config.type === 'company_database') {
            const result = await this.extractJSON<cfPrompt.CompanyDatabaseExtractionResult>(
              [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              2,
              { model: SMART_MODEL },
            );
            const extracted = result.companies ?? [];
            for (const c of extracted) {
              companyEntries.push({ ...c, siteKey, url: page.url });
            }
            logger.info(
              { siteKey, url: page.url, type: config.type, extractedCount: extracted.length },
              'CompanyFinder: extracted from page',
            );
          } else {
            const result = await this.extractJSON<cfPrompt.JobBoardExtractionResult>(
              [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              2,
              { model: SMART_MODEL },
            );
            const extracted = result.listings ?? [];
            for (const l of extracted) {
              listings.push({ ...l, siteKey, url: page.url });
            }
            logger.info(
              { siteKey, url: page.url, type: config.type, extractedCount: extracted.length },
              'CompanyFinder: extracted from page',
            );
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), siteKey, url: page.url },
            'CompanyFinder: extraction failed',
          );
        }
      }
    }

    metrics.listingsExtracted = listings.length + companyEntries.length;

    // ── Phase 4: Dedupe + filter ──────────────────────────────────────────
    const companyMap = new Map<string, AggregatedCompany>();
    let droppedCount = 0;

    for (const l of listings) {
      if (isBlockedCompanyName(l.companyName)) {
        droppedCount++;
        logger.debug({ name: l.companyName, reason: 'blocklist/pattern' }, 'CompanyFinder: dropped junk name');
        continue;
      }
      const domain = normalizeDomain(l.companyDomain);
      if (domain && (shouldSkipDomain(domain) || isMegaCorp(domain))) {
        droppedCount++;
        continue;
      }

      const key = normalizeCompanyKey(l.companyName);
      const existing = companyMap.get(key);
      if (existing) {
        if (!existing.discoveryUrls.includes(l.url)) existing.discoveryUrls.push(l.url);
        if (l.jobTitle) existing.jobTitles.push(l.jobTitle);
        if (l.jobLocation) existing.jobLocations.push(l.jobLocation);
        if (l.description) existing.descriptions.push(l.description);
        if (!existing.domain && domain) existing.domain = domain;
      } else {
        companyMap.set(key, {
          displayName: l.companyName.trim(),
          domain,
          discoveryUrls: [l.url],
          discoverySite: l.siteKey,
          sourceType: 'job_board',
          jobTitles: l.jobTitle ? [l.jobTitle] : [],
          jobLocations: l.jobLocation ? [l.jobLocation] : [],
          descriptions: l.description ? [l.description] : [],
          relevanceScore: l.relevanceScore,
        });
      }
    }

    for (const c of companyEntries) {
      if (isBlockedCompanyName(c.name)) {
        droppedCount++;
        logger.debug({ name: c.name, reason: 'blocklist/pattern' }, 'CompanyFinder: dropped junk name');
        continue;
      }
      const domain = normalizeDomain(c.domain);
      if (domain && (shouldSkipDomain(domain) || isMegaCorp(domain))) {
        droppedCount++;
        continue;
      }

      const key = normalizeCompanyKey(c.name);
      const existing = companyMap.get(key);
      if (existing) {
        if (!existing.domain && domain) existing.domain = domain;
        if (!existing.industry && c.industry) existing.industry = c.industry;
        if (!existing.location && c.location) existing.location = c.location;
        if (!existing.size && c.size) existing.size = c.size;
        if (!existing.revenue && c.revenue) existing.revenue = c.revenue;
        if (c.description) existing.descriptions.push(c.description);
        if (!existing.discoveryUrls.includes(c.url)) existing.discoveryUrls.push(c.url);
      } else {
        companyMap.set(key, {
          displayName: c.name.trim(),
          domain,
          discoveryUrls: [c.url],
          discoverySite: c.siteKey,
          sourceType: 'company_database',
          jobTitles: [],
          jobLocations: c.location ? [c.location] : [],
          descriptions: c.description ? [c.description] : [],
          industry: c.industry || undefined,
          location: c.location || undefined,
          size: c.size || undefined,
          revenue: c.revenue || undefined,
        });
      }
    }

    metrics.uniqueCompanies = companyMap.size;

    logger.info(
      { survivors: companyMap.size, dropped: droppedCount },
      'CompanyFinder: dedupe + filter complete',
    );

    if (dryRun) {
      const elapsedMs = Date.now() - startedAt;
      logger.info({ ...metrics, elapsedMs }, 'CompanyFinder: dry run summary');
      return { status: 'completed', metrics };
    }

    // ── Phase 5: Domain backfill (best-effort, capped) ────────────────────
    const companyList = Array.from(companyMap.values());
    let backfillsRemaining = MAX_DOMAIN_BACKFILLS;
    for (const company of companyList) {
      if (company.domain) continue;
      if (backfillsRemaining <= 0) break;
      backfillsRemaining--;
      try {
        const { urls } = await crawlGoogleAndExtractUrls(
          this.tenantId,
          `${company.displayName} official website`,
          'company_domain',
          { companyName: company.displayName },
        );
        const firstUrl = urls[0]?.url;
        if (firstUrl) {
          try {
            const d = new URL(firstUrl).hostname.replace(/^www\./, '');
            if (!shouldSkipDomain(d) && !isMegaCorp(d)) {
              company.domain = d;
            }
          } catch {
            // invalid URL
          }
        }
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : String(err), company: company.displayName },
          'CompanyFinder: domain backfill failed',
        );
      }
    }

    // ── Phase 6: Persist + dispatch enrichment ────────────────────────────
    for (const company of companyList) {
      try {
        const primaryJobTitle = company.jobTitles[0];
        const primaryJobLocation = company.jobLocations[0];
        const description = company.descriptions.join(' | ').slice(0, 500);

        const rawData: Record<string, unknown> = {
          discoverySource: 'company-finder',
          discoverySite: company.discoverySite,
          discoveryUrl: company.discoveryUrls[0],
          discoveryUrls: company.discoveryUrls,
          sourceType: company.sourceType,
        };
        if (company.sourceType === 'job_board') {
          rawData.hiringSignal = 'job_posting';
          if (primaryJobTitle) rawData.jobTitle = primaryJobTitle;
          if (primaryJobLocation) rawData.jobLocation = primaryJobLocation;
        }
        if (company.relevanceScore != null) rawData.relevanceScore = company.relevanceScore;
        if (company.industry) rawData.industry = company.industry;
        if (company.location) rawData.location = company.location;
        if (company.size) rawData.size = company.size;
        if (company.revenue) rawData.revenue = company.revenue;

        const saved = await this.saveOrUpdateCompany({
          name: company.displayName,
          domain: company.domain ?? undefined,
          description: description || undefined,
          rawData,
        });
        metrics.saved++;

        await this.dispatchNext('enrichment', {
          companyId: saved.id,
          masterAgentId,
          pipelineContext,
          dryRun,
        });
        metrics.dispatched++;
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            company: company.displayName,
          },
          'CompanyFinder: save/dispatch failed',
        );
      }
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info({ ...metrics, elapsedMs }, 'CompanyFinder summary');

    return { status: 'completed', metrics };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Mix EN + local keywords, prefer local for non-English countries. Dedupe + cap at 8. */
  private pickKeywordPool(
    searchKeywords: { en: string[]; local: string[] },
    targetCountry: string,
  ): string[] {
    const en = searchKeywords?.en ?? [];
    const local = searchKeywords?.local ?? [];
    if (!en.length) return local.slice(0, 8);
    if (!local.length) return en.slice(0, 8);

    const localFirstCountries = new Set([
      'fr', 'be', 'lu', 'ch', 'de', 'at', 'es', 'pt', 'it', 'ee',
      'nl', 'pl', 'ro', 'gr', 'hu', 'cz', 'sk', 'fi', 'se', 'no', 'dk',
    ]);
    const ordered = localFirstCountries.has(targetCountry) ? [...local, ...en] : [...en, ...local];
    return Array.from(new Set(ordered.filter((k) => k && k.trim().length > 0))).slice(0, 8);
  }
}
