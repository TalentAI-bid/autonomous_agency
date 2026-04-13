/**
 * LinkedInAgent — LinkedIn discovery agent for the pipeline.
 *
 * Dispatched by the master agent when the user explicitly requests
 * headhunting / LinkedIn-based candidate search.
 *
 * Pipeline: searchLinkedInPeople → getLinkedInProfile → findEmail → save contacts → dispatch enrichment
 *
 * Gated by ENABLE_LINKEDIN env flag.
 */

import { BaseAgent } from './base-agent.js';
import { searchLinkedInPeople, getLinkedInProfile, getVoyagerStats } from '../tools/linkedin-voyager.tool.js';
import { findEmailByPattern } from '../tools/email-finder.tool.js';
import logger from '../utils/logger.js';

interface LinkedInJobData {
  masterAgentId: string;
  missionContext?: {
    mission?: string;
    targetRoles?: string[];
    locations?: string[];
    requiredSkills?: string[];
    keywords?: string[];
  };
  pipelineContext?: Record<string, unknown>;
  // Direct invocation params (from API or explicit dispatch)
  keywords?: string;
  location?: string;
  count?: number;
  enrichEmails?: boolean;
}

interface LinkedInCandidate {
  firstName: string;
  lastName: string;
  headline: string;
  location: string;
  linkedinUrl: string;
  currentCompany: string;
  email?: string;
  emailMethod?: string;
  profileData?: Record<string, unknown>;
}

export class LinkedInAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const data = input as unknown as LinkedInJobData;
    const masterAgentId = data.masterAgentId || this.masterAgentId;
    const mc = data.missionContext;

    // Resolve search parameters from mission context or direct params
    const keywords = data.keywords
      || mc?.targetRoles?.[0]
      || mc?.requiredSkills?.[0]
      || mc?.keywords?.[0]
      || '';
    const location = data.location || mc?.locations?.[0] || '';
    const count = data.count || 10;
    const enrichEmails = data.enrichEmails !== false; // default true

    if (!keywords) {
      logger.warn({ masterAgentId }, 'LinkedIn agent: no keywords to search');
      return { status: 'skipped', reason: 'no_keywords' };
    }

    logger.info({ masterAgentId, keywords, location, count }, 'LinkedIn agent: starting search');

    // Check Voyager budget
    const stats = getVoyagerStats();
    if (stats.dailyCount >= stats.dailyLimit) {
      logger.warn({ dailyCount: stats.dailyCount, dailyLimit: stats.dailyLimit }, 'LinkedIn agent: daily limit reached');
      return { status: 'skipped', reason: 'daily_limit_reached' };
    }

    // 1. Search LinkedIn
    const searchResult = await searchLinkedInPeople(keywords, location, count);
    logger.info({ total: searchResult.total, results: searchResult.results.length }, 'LinkedIn agent: search completed');

    if (searchResult.results.length === 0) {
      return { status: 'completed', candidates: 0, reason: 'no_results' };
    }

    // 2. Enrich each result with full profile + email
    const candidates: LinkedInCandidate[] = [];
    let emailsFound = 0;
    let profilesEnriched = 0;

    for (const result of searchResult.results) {
      const candidate: LinkedInCandidate = {
        firstName: result.firstName,
        lastName: result.lastName,
        headline: result.headline || '',
        location: result.location || '',
        linkedinUrl: result.profileUrl || '',
        currentCompany: result.currentCompany || '',
      };

      // Get full profile if budget allows
      if (candidate.linkedinUrl) {
        const currentStats = getVoyagerStats();
        if (currentStats.dailyCount < currentStats.dailyLimit) {
          try {
            const profile = await getLinkedInProfile(candidate.linkedinUrl);
            if (profile) {
              profilesEnriched++;
              candidate.profileData = {
                summary: profile.summary,
                experiences: profile.experiences,
                education: profile.education,
                skills: profile.skills,
                languages: profile.languages,
                certifications: profile.certifications,
              };
              // Extract company domain from current experience for email finding
              if (enrichEmails && !candidate.email && profile.experiences?.[0]?.company) {
                const companyName = profile.experiences[0].company;
                // Try to find email if we can derive a domain
                try {
                  const domainGuess = companyName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
                  const emailResult = await findEmailByPattern(candidate.firstName, candidate.lastName, domainGuess);
                  if (emailResult.email) {
                    candidate.email = emailResult.email;
                    candidate.emailMethod = emailResult.method;
                    emailsFound++;
                  }
                } catch (err) {
                  logger.debug({ name: `${candidate.firstName} ${candidate.lastName}`, err: err instanceof Error ? err.message : String(err) }, 'LinkedIn agent: email finding failed');
                }
              }
            }
          } catch (err) {
            logger.debug({ linkedinUrl: candidate.linkedinUrl, err: err instanceof Error ? err.message : String(err) }, 'LinkedIn agent: profile fetch failed');
          }
        }
      }

      candidates.push(candidate);
    }

    // 3. Save contacts and dispatch enrichment
    let saved = 0;
    let dispatched = 0;

    for (const candidate of candidates) {
      try {
        const contact = await this.saveOrUpdateContact({
          firstName: candidate.firstName || undefined,
          lastName: candidate.lastName || undefined,
          title: candidate.headline || undefined,
          companyName: candidate.currentCompany || undefined,
          linkedinUrl: candidate.linkedinUrl || undefined,
          email: candidate.email || undefined,
          source: 'linkedin_search',
          status: candidate.email ? 'enriched' : 'discovered',
          masterAgentId,
          rawData: {
            discoverySource: 'linkedin-agent',
            headline: candidate.headline,
            location: candidate.location,
            profileData: candidate.profileData,
            emailMethod: candidate.emailMethod,
          },
        });
        saved++;

        // Dispatch to enrichment for further data collection
        await this.dispatchNext('enrichment', {
          contactId: contact.id,
          masterAgentId,
          pipelineContext: data.pipelineContext,
        });
        dispatched++;
      } catch (err) {
        logger.warn({ name: `${candidate.firstName} ${candidate.lastName}`, err: err instanceof Error ? err.message : String(err) }, 'LinkedIn agent: save/dispatch failed');
      }
    }

    const result = {
      status: 'completed',
      candidates: candidates.length,
      profilesEnriched,
      emailsFound,
      saved,
      dispatched,
      keywords,
      location,
    };

    logger.info(result, 'LinkedIn agent: completed');
    return result;
  }
}
