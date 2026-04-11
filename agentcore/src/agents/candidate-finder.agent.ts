/**
 * CandidateFinderAgent — sources INDIVIDUAL PEOPLE (not companies).
 *
 * Parallel to CompanyFinderAgent but outputs `contacts` rows instead of
 * `companies`. Pipeline:
 *
 *   1. Mission analysis → LLM picks profile sources + skills + languages
 *   2. Source crawl     → crawlSite (json_api dispatches to GH / SO helpers)
 *   3. Extraction       → LLM extracts CandidateProfile[] per source type
 *   4. Dedupe + filter  → normalize by LinkedIn slug or name@company
 *   5. LinkedIn backfill → Google-SERP-extract (capped at 20)
 *   6. Persist + dispatch → saveOrUpdateContact + dispatchNext('enrichment')
 *
 * Dispatched in parallel with CompanyFinderAgent when the master agent's
 * agent-selector picks both.
 */

import { BaseAgent } from './base-agent.js';
import type { AgentType } from '../queues/queues.js';
import { SITE_CONFIGS } from '../config/site-configs.js';
import { crawlSite, crawlGoogleAndExtractUrls } from '../tools/smart-crawler.js';
import * as candPrompt from '../prompts/candidate-finder.prompt.js';
import { slugMatchesPerson } from '../utils/linkedin-match.js';
import { searchLinkedInPeople, getLinkedInProfile, getVoyagerStats } from '../tools/linkedin-voyager.tool.js';
import type { PipelineContext } from '../types/pipeline-context.js';
import logger from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface MissionContext {
  mission: string;
  locations?: string[];
  targetRoles?: string[];
  requiredSkills?: string[];
  experienceLevel?: string;
}

interface CandidateFinderInput {
  masterAgentId: string;
  missionContext: MissionContext;
  pipelineContext?: PipelineContext;
  dryRun?: boolean;
}

interface CandidateFinderMetrics {
  sourcesAnalyzed: number;
  sourcesCrawled: number;
  pagesScraped: number;
  profilesExtracted: number;
  uniqueCandidates: number;
  backfilled: number;
  saved: number;
  dispatched: number;
}

interface AggregatedCandidate extends candPrompt.CandidateProfile {
  discoverySourceSites: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const PROFILE_NAME_BLOCKLIST = new Set([
  'unknown',
  'n/a',
  'na',
  'anonymous',
  'anonymous user',
  'user',
  'admin',
  'guest',
  'test',
  'example',
]);

const GENERIC_TITLE_ONLY = new Set([
  'software engineer',
  'developer',
  'engineer',
  'designer',
  'recruiter',
  'sales',
  'manager',
]);

const MAX_LINKEDIN_BACKFILLS = 20;

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePersonKey(p: candPrompt.CandidateProfile): string {
  if (p.linkedinUrl) {
    const m = p.linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (m) return 'li:' + m[1]!.toLowerCase();
  }
  const name = (p.fullName || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const company = (p.currentCompany || '').toLowerCase().trim();
  return `n:${name}@${company}`;
}

function isBlockedName(name: string): boolean {
  const trimmed = (name || '').trim().toLowerCase();
  if (!trimmed) return true;
  if (trimmed.length < 3) return true;
  if (PROFILE_NAME_BLOCKLIST.has(trimmed)) return true;
  if (GENERIC_TITLE_ONLY.has(trimmed)) return true;
  // Reject names with digits or ? (StackOverflow question titles, handles)
  if (/[0-9?]/.test(trimmed)) return true;
  return false;
}

function splitFullName(full: string): { firstName: string; lastName: string } {
  const trimmed = (full || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: '', lastName: '' };
  const parts = trimmed.split(' ');
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '' };
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1]!,
  };
}

/** Merge two candidate profiles, preferring non-empty fields from the newer one. */
function mergeCandidate(
  existing: AggregatedCandidate,
  incoming: candPrompt.CandidateProfile,
  sourceSite: string,
): AggregatedCandidate {
  const merged: AggregatedCandidate = { ...existing };
  if (!merged.discoverySourceSites.includes(sourceSite)) {
    merged.discoverySourceSites.push(sourceSite);
  }
  // Prefer non-empty values from incoming when existing is empty
  if (!merged.headline && incoming.headline) merged.headline = incoming.headline;
  if (!merged.currentTitle && incoming.currentTitle) merged.currentTitle = incoming.currentTitle;
  if (!merged.currentCompany && incoming.currentCompany) merged.currentCompany = incoming.currentCompany;
  if (!merged.location && incoming.location) merged.location = incoming.location;
  if (!merged.linkedinUrl && incoming.linkedinUrl) merged.linkedinUrl = incoming.linkedinUrl;
  if (!merged.githubUrl && incoming.githubUrl) merged.githubUrl = incoming.githubUrl;
  if (!merged.twitterUrl && incoming.twitterUrl) merged.twitterUrl = incoming.twitterUrl;
  if (!merged.websiteUrl && incoming.websiteUrl) merged.websiteUrl = incoming.websiteUrl;
  if (!merged.email && incoming.email) merged.email = incoming.email;
  if (!merged.bio && incoming.bio) merged.bio = incoming.bio;
  if (merged.experienceYears == null && incoming.experienceYears != null) {
    merged.experienceYears = incoming.experienceYears;
  }
  // Union skills
  const skillSet = new Set<string>([
    ...(merged.skills ?? []),
    ...(incoming.skills ?? []),
  ]);
  merged.skills = Array.from(skillSet).filter((s) => s && s.trim().length > 0);
  return merged;
}

function sourceTypeForSiteKey(siteKey: string): candPrompt.ProfileSourceType {
  if (siteKey === 'github_api') return 'github_api';
  if (siteKey === 'stackoverflow_api') return 'stackoverflow_api';
  if (siteKey === 'devto') return 'devto';
  return 'linkedin_profile_serp';
}

function normalizeLinkedInUrl(url: string): string {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return url;
  return `https://www.linkedin.com/in/${m[1]!.toLowerCase()}`;
}

// ── Agent ──────────────────────────────────────────────────────────────────

export class CandidateFinderAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'candidate-finder' as AgentType });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const typedInput = input as unknown as CandidateFinderInput;
    const { masterAgentId, missionContext, pipelineContext, dryRun } = typedInput;
    const startedAt = Date.now();

    const metrics: CandidateFinderMetrics = {
      sourcesAnalyzed: 0,
      sourcesCrawled: 0,
      pagesScraped: 0,
      profilesExtracted: 0,
      uniqueCandidates: 0,
      backfilled: 0,
      saved: 0,
      dispatched: 0,
    };

    // Build profile-source key list: sites where profileType is set
    const availableProfileSources = Object.entries(SITE_CONFIGS)
      .filter(([, c]) => Boolean(c.profileType))
      .map(([k]) => k);

    if (availableProfileSources.length === 0) {
      logger.warn('CandidateFinder: no profile sources registered');
      return { status: 'completed', metrics };
    }

    // ── Phase 1: Mission analysis ─────────────────────────────────────────
    let analysis: candPrompt.CandidateMissionAnalysis;
    try {
      analysis = await this.extractJSON<candPrompt.CandidateMissionAnalysis>(
        [
          {
            role: 'system',
            content: candPrompt.buildCandidateMissionAnalyzerSystemPrompt(availableProfileSources),
          },
          {
            role: 'user',
            content: candPrompt.buildCandidateMissionAnalyzerUserPrompt(missionContext),
          },
        ],
        2,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'CandidateFinder: mission analysis failed');
      return { status: 'failed', metrics, error: msg } as Record<string, unknown>;
    }

    logger.info(
      {
        missionType: analysis.missionType,
        targetRole: analysis.targetRole,
        targetCountry: analysis.targetCountry,
        sourcesRequested: analysis.sourcesToCrawl,
      },
      'CandidateFinder: mission analyzed',
    );

    metrics.sourcesAnalyzed = Array.isArray(analysis.sourcesToCrawl)
      ? analysis.sourcesToCrawl.length
      : 0;

    // ── Validate source keys (drop unknowns / non-profile sources) ────────
    const requested = Array.isArray(analysis.sourcesToCrawl) ? analysis.sourcesToCrawl : [];
    const validSources = requested.filter((k) => {
      if (!availableProfileSources.includes(k)) {
        logger.warn({ sourceKey: k }, 'CandidateFinder: LLM returned unknown/non-profile source key, dropping');
        return false;
      }
      return true;
    });

    if (validSources.length === 0) {
      logger.warn('CandidateFinder: no valid profile sources after validation');
      return { status: 'completed', metrics };
    }

    const targetCountry = (analysis.targetCountry || '').toLowerCase();
    const primaryCity = analysis.targetCities?.[0];
    const targetSkills = (analysis.targetSkills ?? []).filter((s) => s && s.trim().length > 0);
    const programmingLanguages = (analysis.programmingLanguages ?? []).filter(
      (s) => s && s.trim().length > 0,
    );

    // ── Phase 2+3: Crawl + extract per source ─────────────────────────────
    type ExtractedProfile = candPrompt.CandidateProfile & { siteKey: string };
    const allProfiles: ExtractedProfile[] = [];

    for (const siteKey of validSources) {
      const config = SITE_CONFIGS[siteKey]!;
      metrics.sourcesCrawled++;

      // Determine per-source keyword strategy
      let keywords: string[];
      if (siteKey === 'github_api' || siteKey === 'stackoverflow_api') {
        keywords = programmingLanguages.length > 0 ? programmingLanguages : targetSkills;
      } else if (siteKey === 'brave_linkedin_profiles' || siteKey === 'duckduckgo_linkedin_profiles') {
        // Build LinkedIn SERP queries: site:linkedin.com/in "${role}" "${skill}"
        const role = analysis.targetRole || '';
        const countryHint = targetCountry ? ` "${targetCountry.toUpperCase()}"` : '';
        keywords = targetSkills.slice(0, 3).map(
          (skill) => `site:linkedin.com/in "${role}" "${skill}"${countryHint}`,
        );
        if (keywords.length === 0) {
          // Fallback: role-only search
          keywords = [`site:linkedin.com/in "${role}"${countryHint}`];
        }
      } else if (siteKey === 'devto') {
        // Dev.to user search — pass skill/language tokens directly
        const pool = programmingLanguages.length > 0 ? programmingLanguages : targetSkills;
        keywords = pool.slice(0, 3);
      } else {
        keywords = targetSkills.slice(0, 3);
      }

      if (keywords.length === 0) {
        logger.warn({ siteKey }, 'CandidateFinder: no keywords for source, skipping');
        continue;
      }

      let pages: Array<{ url: string; content: string }>;
      try {
        pages = await crawlSite(siteKey, keywords, primaryCity);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), siteKey },
          'CandidateFinder: crawlSite threw',
        );
        continue;
      }
      metrics.pagesScraped += pages.length;

      const sourceType = sourceTypeForSiteKey(siteKey);

      for (const page of pages) {
        const systemPrompt = candPrompt.buildProfileExtractionSystemPrompt(
          sourceType,
          targetSkills,
          analysis.targetRole || '',
        );
        const userPrompt = candPrompt.buildProfileExtractionUserPrompt({
          url: page.url,
          sourceName: config.name,
          content: page.content,
        });

        try {
          const result = await this.extractJSON<candPrompt.CandidateExtractionResult>(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            2,
          );
          for (const p of result.profiles ?? []) {
            if (p.linkedinUrl) {
              p.linkedinUrl = normalizeLinkedInUrl(p.linkedinUrl);
            }
            allProfiles.push({ ...p, siteKey });
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), siteKey, url: page.url },
            'CandidateFinder: extraction failed',
          );
        }
      }
    }

    // ── Phase 3.5: Voyager LinkedIn search (supplementary) ───────────────
    {
      const stats = getVoyagerStats();
      if (stats.dailyCount < stats.dailyLimit - 15) {
        try {
          const searchResult = await searchLinkedInPeople(
            analysis.targetRole || targetSkills[0] || '',
            analysis.targetCountry || '',
            10,
          );
          for (const result of searchResult.results) {
            const fullName = `${result.firstName} ${result.lastName}`.trim();
            if (isBlockedName(fullName)) continue;
            allProfiles.push({
              fullName,
              headline: result.headline,
              currentTitle: result.headline?.split(' at ')?.[0]?.trim() || result.headline,
              currentCompany: result.currentCompany || '',
              location: result.location,
              linkedinUrl: result.profileUrl ? normalizeLinkedInUrl(result.profileUrl) : undefined,
              skills: [],
              siteKey: 'linkedin_voyager',
            } as ExtractedProfile);
          }
          logger.info({ count: searchResult.results.length }, 'CandidateFinder: Voyager search added profiles');
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'CandidateFinder: Voyager search failed');
        }
      }
    }

    metrics.profilesExtracted = allProfiles.length;

    // ── Phase 4: Dedupe + filter ──────────────────────────────────────────
    const map = new Map<string, AggregatedCandidate>();
    for (const p of allProfiles) {
      if (isBlockedName(p.fullName)) continue;

      // Country filter: drop entries whose location does not include the target country
      if (targetCountry && p.location) {
        const loc = p.location.toLowerCase();
        const country = targetCountry;
        // best-effort substring match; if location is empty we keep the profile
        if (country && !loc.includes(country)) {
          // also check common name forms (e.g. 'gb' vs 'united kingdom', 'fr' vs 'france')
          const countryNames: Record<string, string[]> = {
            fr: ['france', 'french'],
            gb: ['united kingdom', 'uk', 'england', 'scotland', 'wales', 'britain'],
            us: ['united states', 'usa', 'america'],
            de: ['germany', 'deutschland'],
            es: ['spain', 'españa', 'espana'],
            it: ['italy', 'italia'],
            nl: ['netherlands', 'holland'],
            be: ['belgium', 'belgique'],
            ch: ['switzerland', 'suisse', 'schweiz'],
            ca: ['canada'],
            ie: ['ireland'],
            ee: ['estonia', 'eesti'],
          };
          const aliases = countryNames[country] ?? [];
          if (!aliases.some((a) => loc.includes(a))) continue;
        }
      }

      const key = normalizePersonKey(p);
      const existing = map.get(key);
      if (existing) {
        map.set(key, mergeCandidate(existing, p, (p as ExtractedProfile).siteKey));
      } else {
        map.set(key, {
          ...p,
          skills: p.skills ?? [],
          discoverySourceSites: [(p as ExtractedProfile).siteKey],
        });
      }
    }

    metrics.uniqueCandidates = map.size;

    if (dryRun) {
      const elapsedMs = Date.now() - startedAt;
      logger.info({ ...metrics, elapsedMs }, 'CandidateFinder: dry run summary');
      return { status: 'completed', metrics };
    }

    // ── Phase 5: LinkedIn backfill (capped) ───────────────────────────────
    const candidateList = Array.from(map.values());
    let backfillsRemaining = MAX_LINKEDIN_BACKFILLS;
    for (const candidate of candidateList) {
      if (candidate.linkedinUrl) continue;
      if (backfillsRemaining <= 0) break;
      backfillsRemaining--;

      const hint = candidate.currentCompany || candidate.currentTitle || '';
      const query = `${candidate.fullName} ${hint} linkedin`.trim();
      const { firstName: bfFirst, lastName: bfLast } = splitFullName(candidate.fullName);
      if (!bfFirst || !bfLast) continue; // slugMatchesPerson requires both parts
      try {
        const { urls } = await crawlGoogleAndExtractUrls(
          this.tenantId,
          query,
          'linkedin_person',
          { personName: candidate.fullName },
        );
        const firstUrl = urls[0]?.url;
        if (firstUrl && slugMatchesPerson(firstUrl, bfFirst, bfLast)) {
          candidate.linkedinUrl = normalizeLinkedInUrl(firstUrl);
          metrics.backfilled++;
        }
      } catch (err) {
        logger.debug(
          { err: err instanceof Error ? err.message : String(err), name: candidate.fullName },
          'CandidateFinder: LinkedIn backfill failed',
        );
      }
    }

    // ── Phase 5.5: Voyager profile enrichment (top 10 with LinkedIn URLs) ──
    const MAX_VOYAGER_ENRICHMENTS = 10;
    let voyagerEnrichCount = 0;
    for (const candidate of candidateList) {
      if (voyagerEnrichCount >= MAX_VOYAGER_ENRICHMENTS) break;
      if (!candidate.linkedinUrl) continue;
      const stats = getVoyagerStats();
      if (stats.dailyCount >= stats.dailyLimit) break;
      try {
        const vp = await getLinkedInProfile(candidate.linkedinUrl);
        if (vp) {
          if (vp.skills?.length && (!candidate.skills || candidate.skills.length === 0)) candidate.skills = vp.skills;
          if (vp.headline && !candidate.headline) candidate.headline = vp.headline;
          if (vp.location && !candidate.location) candidate.location = vp.location;
          (candidate as any)._voyagerProfile = {
            experiences: vp.experiences,
            education: vp.education,
            languages: vp.languages,
            certifications: vp.certifications,
            summary: vp.summary,
          };
          voyagerEnrichCount++;
        }
      } catch (err) {
        logger.debug({ name: candidate.fullName, err: err instanceof Error ? err.message : String(err) }, 'CandidateFinder: Voyager enrich failed');
      }
    }
    if (voyagerEnrichCount > 0) {
      logger.info({ voyagerEnrichCount }, 'CandidateFinder: Voyager profile enrichment completed');
    }

    // ── Phase 6: Persist + dispatch enrichment ────────────────────────────
    for (const candidate of candidateList) {
      try {
        const { firstName, lastName } = splitFullName(candidate.fullName);

        const rawData: Record<string, unknown> = {
          discoverySource: 'candidate-finder',
          discoverySourceSites: candidate.discoverySourceSites,
        };
        if (candidate.headline) rawData.headline = candidate.headline;
        if (candidate.bio) rawData.bio = candidate.bio;
        if (candidate.githubUrl) rawData.githubUrl = candidate.githubUrl;
        if (candidate.twitterUrl) rawData.twitterUrl = candidate.twitterUrl;
        if (candidate.websiteUrl) rawData.websiteUrl = candidate.websiteUrl;
        if (candidate.experienceYears != null) rawData.experienceYears = candidate.experienceYears;
        if (candidate.relevanceScore != null) rawData.relevanceScore = candidate.relevanceScore;
        if ((candidate as any)._voyagerProfile) rawData.voyagerProfile = (candidate as any)._voyagerProfile;

        const saved = await this.saveOrUpdateContact({
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          title: candidate.currentTitle,
          companyName: candidate.currentCompany,
          linkedinUrl: candidate.linkedinUrl,
          email: candidate.email,
          location: candidate.location,
          skills: candidate.skills ?? [],
          source: 'web_search',
          rawData,
        });
        metrics.saved++;

        await this.dispatchNext('enrichment', {
          contactId: saved.id,
          masterAgentId,
          pipelineContext,
          dryRun,
        });
        metrics.dispatched++;
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            name: candidate.fullName,
          },
          'CandidateFinder: save/dispatch failed',
        );
      }
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info({ ...metrics, elapsedMs }, 'CandidateFinder summary');

    return { status: 'completed', metrics };
  }
}
