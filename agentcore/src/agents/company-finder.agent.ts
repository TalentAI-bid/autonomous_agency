/**
 * CompanyFinderAgent — the replacement for DiscoveryAgent.
 *
 * Pipeline:
 *   1. Mission analysis → LLM picks sites from SITE_CONFIGS + keyword pool
 *   2. Per-site loop:
 *      a. Crawl pages → smart-crawler.crawlSite
 *      b. Extract    → LLM extracts JobListing[] or CompanyEntry[] per page
 *      c. Dedupe     → skip if normalized key already in savedCompanyKeys Set
 *      d. Filter     → drop blocklisted names, megacorps, skip-domains
 *      e. Save       → saveOrUpdateCompany immediately
 *      f. Dispatch   → dispatchNext('enrichment') immediately
 *
 * Companies appear in DB and enrichment starts within minutes of first page
 * crawl, not after all sites finish.
 *
 * Gated by env.USE_COMPANY_FINDER in master-agent.ts. When false, master
 * dispatches the legacy DiscoveryAgent instead.
 */

import { BaseAgent } from './base-agent.js';
import type { AgentType } from '../queues/queues.js';
import { SITE_CONFIGS } from '../config/site-configs.js';
import { crawlSite, crawlPage } from '../tools/smart-crawler.js';
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
  bdStrategy?: 'hiring_signal' | 'industry_target' | 'hybrid';
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
  // Job titles / role keywords (catch exact-match after legal suffix strip)
  'devops', 'sre', 'cloud engineer', 'cloud architect', 'data engineer',
  'frontend', 'backend', 'fullstack', 'full stack', 'developer', 'engineer',
  'consultant', 'freelance', 'expert', 'specialist', 'manager', 'lead',
  'senior', 'junior', 'intern', 'stagiaire', 'alternance', 'cdi', 'cdd',
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
  /^(devops|sre|cloud|data|frontend|backend|fullstack|java|python|react|angular|node)\b/i,
  /\bsearch\b.*\b(sarl|sàrl|gmbh|ltd)\b/i,
];

/** Stopwords for last-resort mission-text tokenization fallback (BUG 1 Fallback 3). */
const STOPWORDS = new Set([
  'find','hire','recruit','source','companies','company','people','candidates',
  'looking','need','want','with','that','from','about','their','they','have',
  'will','would','should','also','more','than','some','these','those','this',
  'into','onto','using','use','for','the','and','our','you','your','who','what',
  'when','where','why','how','any','all','best','top','must','can','are',
]);

/** Hard cap on the keyword pool fed to crawlSite. Each keyword × site × page = 1 Crawl4AI request. */
const MAX_KEYWORDS = 6;

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeCompanyKey(name: string): string {
  const stripped = name.trim()
    .replace(/\s*\(.*?\)\s*$/, '')   // strip trailing "(Paris)", "(France)", etc.
    .replace(LEGAL_SUFFIX_RE, '')
    .trim();
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
      (k) => !SITE_CONFIGS[k]!.profileType && k !== 'welcometothejungle_company',
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
        sitesToCrawl: ['welcometothejungle', 'glassdoor'],
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
        sitesToCrawl: ['welcometothejungle', 'glassdoor'],
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
      analysis.sitesToCrawl = ['welcometothejungle', 'glassdoor'];
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

    // Strategy-based site filtering
    const bdStrategy = missionContext.bdStrategy || 'hybrid';
    if (bdStrategy === 'hiring_signal') {
      sitesToCrawl = sitesToCrawl.filter(key => SITE_CONFIGS[key]?.type === 'job_board');
    } else if (bdStrategy === 'industry_target') {
      sitesToCrawl = sitesToCrawl.filter(key => SITE_CONFIGS[key]?.type === 'company_database');
    }
    // 'hybrid' keeps both

    logger.info({ bdStrategy, sitesToCrawl }, 'CompanyFinder: sites filtered by BD strategy');

    // Hard fallback: if STILL empty, use a hard-coded set of always-on job boards.
    if (sitesToCrawl.length === 0) {
      const hardFallback = ['welcometothejungle', 'glassdoor'].filter((k) => SITE_CONFIGS[k]);
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

    // ── Phase 2: Per-site crawl + extract + save + dispatch ────────────────
    // Cross-site dedupe: track normalized company keys already saved so that
    // if "Capgemini" appears on WTTJ AND LinkedIn, it's only saved once.
    const savedCompanyKeys = new Set<string>();

    for (const siteKey of sitesToCrawl) {
      const config = SITE_CONFIGS[siteKey]!;
      metrics.sitesCrawled++;

      let pages: Array<{ url: string; content: string }>;
      try {
        // Smart location: if the site's locationParam contains "country", pass the
        // ISO country code (uppercase). Otherwise pass the city name.
        let locationForSite = primaryCity;
        if (config.locationParam && /country/i.test(config.locationParam) && targetCountry) {
          locationForSite = targetCountry.toUpperCase();
        }
        pages = await crawlSite(siteKey, allKeywords, locationForSite);
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
        // ── WTTJ: extract company slugs directly from search results HTML ──
        if (siteKey === 'welcometothejungle') {
          const slugRegex = /welcometothejungle\.com\/fr\/companies\/([a-zA-Z0-9_-]+)/g;
          const slugs = new Set<string>();
          let slugMatch;
          while ((slugMatch = slugRegex.exec(page.content)) !== null) {
            const slug = slugMatch[1];
            if (slug && slug.length > 1 && !['jobs', 'pages', 'media', 'login'].includes(slug)) {
              slugs.add(slug);
            }
          }

          logger.info({ siteKey, slugCount: slugs.size, slugs: Array.from(slugs) },
            'CompanyFinder: extracted company slugs from WTTJ');

          const wttjCompanyConfig = SITE_CONFIGS['welcometothejungle_company'];
          if (wttjCompanyConfig) {
            for (const slug of Array.from(slugs).slice(0, 15)) {
              const companyPageUrl = `https://www.welcometothejungle.com/fr/companies/${slug}`;

              try {
                const mainContent = await crawlPage(companyPageUrl, wttjCompanyConfig);
                if (!mainContent || mainContent.length < 500) continue;
                if (mainContent.includes('ne fait plus partie de la jungle')) continue;
                const companyContent = mainContent;

                // Extract company name — first H1 on WTTJ company page
                const nameMatch = companyContent.match(/^#\s+([^\n]+)/m);
                let companyName = '';
                if (nameMatch) {
                  companyName = nameMatch[1].trim().replace(/\[.*?\]\(.*?\)/g, '').trim();
                }
                if (!companyName || companyName.length < 2 ||
                    ['presentation', 'présentation', 'crédits', 'about', 'team', 'culture'].includes(companyName.toLowerCase())) {
                  companyName = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                }

                // Extract industry and location from lines after H1
                const lines = companyContent.split('\n');
                const h1Index = lines.findIndex(l => l.startsWith('# '));
                let industry = '';
                let location = '';
                if (h1Index >= 0) {
                  for (let i = h1Index + 1; i < Math.min(h1Index + 6, lines.length); i++) {
                    const line = lines[i].trim();
                    if (line === 'Follow' || line === '' || line.startsWith('!') || line.startsWith('[')) continue;
                    if (!industry) { industry = line; continue; }
                    if (!location && !line.includes('http')) { location = line; break; }
                  }
                }

                // Extract website domain from "[View website]" / "[Voir le site]" link first
                let companyDomain = '';
                const viewWebsitePatterns = [
                  /\[View website\]\((https?:\/\/[^\)]+)\)/i,
                  /\[Voir le site\]\((https?:\/\/[^\)]+)\)/i,
                  /\[Site web\]\((https?:\/\/[^\)]+)\)/i,
                  /\[Website\]\((https?:\/\/[^\)]+)\)/i,
                ];
                for (const pattern of viewWebsitePatterns) {
                  const match = mainContent.match(pattern);
                  if (match) {
                    try {
                      companyDomain = new URL(match[1]).hostname.replace('www.', '');
                      logger.info({ company: companyName, domain: companyDomain, source: 'view-website-link' }, 'Domain from View website');
                      break;
                    } catch {}
                  }
                }

                // Fallback: scan all URLs if no "View website" link.
                // Require the candidate host to contain at least one ≥3-char token
                // from the company name — prevents picking intercom/w3/sj-cdn hosts.
                if (!companyDomain) {
                  const allUrls = companyContent.match(/https?:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s"')><]*/g) || [];
                  const skipDomains = ['welcometothejungle', 'wttj', 'solutions.welcometothejungle',
                    'linkedin', 'facebook', 'twitter', 'instagram',
                    'youtube', 'axeptio', 'imgix', 'gstatic', 'maps.google', 'googleapis', 'cloudflare',
                    'amazonaws', 'cdn.', 'fonts.', 'analytics', 'doubleclick', 'googletagmanager',
                    'w3.org', 'schema.org', 'sj-cdn.net', 'intercomcdn', 'intercomassets'];
                  const nameWords = companyName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);

                  for (const u of allUrls) {
                    try {
                      const h = new URL(u).hostname.replace('www.', '').toLowerCase();
                      if (skipDomains.some(d => h.includes(d))) continue;
                      if (h.length < 4) continue;
                      const domainBase = h.replace(/\.[a-z]+$/, '').replace(/[^a-z0-9]/g, '');
                      if (nameWords.length > 0 && !nameWords.some(w => domainBase.includes(w))) continue;
                      companyDomain = h;
                      break;
                    } catch { continue; }
                  }
                }

                // Extract LinkedIn — priority: social network link (markdown from WTTJ social buttons)
                let linkedinUrl = '';
                const socialLiMatch = mainContent.match(
                  /\[([^\]]*linkedin[^\]]*)\]\((https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+)\)/i
                );
                if (socialLiMatch) {
                  linkedinUrl = socialLiMatch[2];
                }

                // Fallback: scan all linkedin URLs, skip WTTJ's own
                if (!linkedinUrl) {
                  const allLinkedins = [...mainContent.matchAll(/linkedin\.com\/company\/([a-zA-Z0-9_-]+)/g)];
                  const WTTJ_LINKEDIN_SLUGS = ['wttj-fr', 'wttj', 'welcometothejungle', 'welcome-to-the-jungle'];
                  for (const liMatch of allLinkedins) {
                    const liSlug = liMatch[1];
                    if (WTTJ_LINKEDIN_SLUGS.includes(liSlug.toLowerCase())) continue;
                    linkedinUrl = `https://www.linkedin.com/company/${liSlug}`;
                    break;
                  }
                }

                // Final safety: reject if it's still a WTTJ slug
                if (linkedinUrl) {
                  const finalSlug = linkedinUrl.split('/company/')[1]?.split(/[/?#]/)[0]?.toLowerCase() || '';
                  if (['wttj-fr', 'wttj', 'welcometothejungle', 'welcome-to-the-jungle'].includes(finalSlug)) {
                    linkedinUrl = '';
                  }
                }

                // Cross-site dedupe
                const key = normalizeCompanyKey(companyName);
                if (savedCompanyKeys.has(key)) continue;
                if (isBlockedCompanyName(companyName)) continue;
                if (companyDomain && (shouldSkipDomain(companyDomain) || isMegaCorp(companyDomain))) continue;
                savedCompanyKeys.add(key);
                metrics.uniqueCompanies++;

                try {
                  const saved = await this.saveOrUpdateCompany({
                    name: companyName,
                    domain: companyDomain || undefined,
                    linkedinUrl: linkedinUrl || undefined,
                    description: companyContent.slice(0, 500),
                    dataCompleteness: 15,
                    rawData: {
                      discoverySource: 'company-finder',
                      discoverySite: 'welcometothejungle',
                      discoveryUrl: companyPageUrl,
                      sourceType: 'job_board',
                      hiringSignal: 'job_posting',
                      wttjSlug: slug,
                      wttjContent: mainContent.slice(0, 8000),
                      linkedinCompanyUrl: linkedinUrl,
                      ...(industry && { industry }),
                      ...(location && { location }),
                    },
                  });
                  metrics.saved++;
                  metrics.listingsExtracted++;

                  if (!dryRun) {
                    await this.dispatchNext('enrichment', {
                      companyId: saved.id,
                      masterAgentId,
                      pipelineContext,
                      dryRun,
                    });
                    metrics.dispatched++;
                  }

                  logger.info({
                    company: companyName, slug, domain: companyDomain,
                    contentLen: mainContent.length,
                  }, 'CompanyFinder: saved WTTJ company from profile page');
                } catch (err) {
                  logger.warn(
                    { err: err instanceof Error ? err.message : String(err), company: companyName, slug },
                    'CompanyFinder: WTTJ company save/dispatch failed',
                  );
                }
              } catch (err) {
                logger.debug({ slug, err: err instanceof Error ? err.message : String(err) },
                  'CompanyFinder: WTTJ company page crawl failed');
              }
            }
          }
          // Skip LLM extraction for WTTJ — slugs give us everything
          continue;
        }

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
            metrics.listingsExtracted += extracted.length;
            logger.info(
              { siteKey, url: page.url, type: config.type, extractedCount: extracted.length },
              'CompanyFinder: extracted from page',
            );

            // Inline dedupe + filter + save + dispatch per company entry
            for (const c of extracted) {
              if (isBlockedCompanyName(c.name)) {
                logger.debug({ name: c.name }, 'CompanyFinder: dropped junk name');
                continue;
              }
              const domain = normalizeDomain(c.domain);
              if (domain && (shouldSkipDomain(domain) || isMegaCorp(domain))) continue;

              const key = normalizeCompanyKey(c.name);
              if (savedCompanyKeys.has(key)) continue;
              savedCompanyKeys.add(key);
              metrics.uniqueCompanies++;

              try {
                const saved = await this.saveOrUpdateCompany({
                  name: c.name.trim(),
                  domain: domain ?? undefined,
                  description: c.description?.slice(0, 500) || undefined,
                  dataCompleteness: 15,
                  rawData: {
                    discoverySource: 'company-finder',
                    discoverySite: siteKey,
                    discoveryUrl: page.url,
                    discoveryUrls: [page.url],
                    sourceType: 'company_database',
                    ...(c.industry && { industry: c.industry }),
                    ...(c.location && { location: c.location }),
                    ...(c.size && { size: c.size }),
                    ...(c.revenue && { revenue: c.revenue }),
                  },
                });
                metrics.saved++;

                if (!dryRun) {
                  await this.dispatchNext('enrichment', {
                    companyId: saved.id,
                    masterAgentId,
                    pipelineContext,
                    dryRun,
                  });
                  metrics.dispatched++;
                }
              } catch (err) {
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err), company: c.name },
                  'CompanyFinder: save/dispatch failed',
                );
              }
            }
          } else {
            // job_board or json_api
            const result = await this.extractJSON<cfPrompt.JobBoardExtractionResult>(
              [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              2,
              { model: SMART_MODEL },
            );
            const extracted = result.listings ?? [];
            metrics.listingsExtracted += extracted.length;
            logger.info(
              { siteKey, url: page.url, type: config.type, extractedCount: extracted.length },
              'CompanyFinder: extracted from page',
            );

            // Inline dedupe + filter + save + dispatch per job listing
            for (const l of extracted) {
              if (isBlockedCompanyName(l.companyName)) {
                logger.debug({ name: l.companyName }, 'CompanyFinder: dropped junk name');
                continue;
              }
              const domain = normalizeDomain(l.companyDomain);
              if (domain && (shouldSkipDomain(domain) || isMegaCorp(domain))) continue;

              const key = normalizeCompanyKey(l.companyName);
              if (savedCompanyKeys.has(key)) continue;
              savedCompanyKeys.add(key);
              metrics.uniqueCompanies++;

              try {
                const saved = await this.saveOrUpdateCompany({
                  name: l.companyName.trim(),
                  domain: domain ?? undefined,
                  description: l.description?.slice(0, 500) || undefined,
                  dataCompleteness: 15,
                  rawData: {
                    discoverySource: 'company-finder',
                    discoverySite: siteKey,
                    discoveryUrl: page.url,
                    discoveryUrls: [page.url],
                    sourceType: 'job_board',
                    hiringSignal: 'job_posting',
                    openPositions: l.jobTitle ? [{
                      title: l.jobTitle,
                      location: l.jobLocation || '',
                      url: page.url,
                      description: l.description || '',
                    }] : [],
                    ...(l.jobTitle && { jobTitle: l.jobTitle }),
                    ...(l.jobLocation && { jobLocation: l.jobLocation }),
                    ...(l.relevanceScore != null && { relevanceScore: l.relevanceScore }),
                  },
                });
                metrics.saved++;

                if (!dryRun) {
                  await this.dispatchNext('enrichment', {
                    companyId: saved.id,
                    masterAgentId,
                    pipelineContext,
                    dryRun,
                  });
                  metrics.dispatched++;
                }
              } catch (err) {
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err), company: l.companyName },
                  'CompanyFinder: save/dispatch failed',
                );
              }
            }
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), siteKey, url: page.url },
            'CompanyFinder: extraction failed',
          );
        }
      }

      logger.info(
        { siteKey, savedSoFar: metrics.saved, dispatchedSoFar: metrics.dispatched, uniqueSoFar: savedCompanyKeys.size },
        'CompanyFinder: site complete — companies saved + enrichment dispatched',
      );
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
