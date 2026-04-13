import type { FastifyInstance } from 'fastify';
import { getLinkedInProfile, getLinkedInCompany, searchLinkedInPeople, getVoyagerStats } from '../tools/linkedin-voyager.tool.js';
import { findEmailByPattern } from '../tools/email-finder.tool.js';
import { withTenant } from '../config/database.js';
import { contacts } from '../db/schema/index.js';
import logger from '../utils/logger.js';

export default async function linkedinRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/linkedin/stats — Voyager rate limit stats
  fastify.get('/stats', async () => {
    return getVoyagerStats();
  });

  // POST /api/linkedin/profile — Fetch a single LinkedIn profile
  fastify.post<{
    Body: { linkedin_url: string };
  }>('/profile', async (request, reply) => {
    const { linkedin_url } = request.body;
    if (!linkedin_url) {
      return reply.status(400).send({ error: 'linkedin_url is required' });
    }

    const profile = await getLinkedInProfile(linkedin_url);
    if (!profile) {
      return reply.status(404).send({ error: 'Profile not found or Voyager unavailable' });
    }

    return { success: true, profile };
  });

  // POST /api/linkedin/company — Fetch a single LinkedIn company
  fastify.post<{
    Body: { linkedin_url: string };
  }>('/company', async (request, reply) => {
    const { linkedin_url } = request.body;
    if (!linkedin_url) {
      return reply.status(400).send({ error: 'linkedin_url is required' });
    }

    const company = await getLinkedInCompany(linkedin_url);
    if (!company) {
      return reply.status(404).send({ error: 'Company not found or Voyager unavailable' });
    }

    return { success: true, company };
  });

  // POST /api/linkedin/search — Search for people on LinkedIn
  fastify.post<{
    Body: { keywords: string; location?: string; count?: number; start?: number };
  }>('/search', async (request, reply) => {
    const { keywords, location, count, start } = request.body;
    if (!keywords) {
      return reply.status(400).send({ error: 'keywords is required' });
    }

    const result = await searchLinkedInPeople(keywords, location || '', count || 10, start || 0);
    return { success: true, ...result };
  });

  // POST /api/linkedin/headhunt — Full pipeline: search + profile + email + save
  fastify.post<{
    Body: {
      keywords: string;
      location?: string;
      count?: number;
      enrichEmails?: boolean;
      masterAgentId?: string;
    };
  }>('/headhunt', async (request, reply) => {
    const { keywords, location, count = 10, enrichEmails = true, masterAgentId } = request.body;
    const tenantId = request.tenantId;

    if (!keywords) {
      return reply.status(400).send({ error: 'keywords is required' });
    }

    // Check budget
    const stats = getVoyagerStats();
    if (stats.dailyCount >= stats.dailyLimit) {
      return reply.status(429).send({
        error: 'LinkedIn Voyager daily limit reached',
        dailyCount: stats.dailyCount,
        dailyLimit: stats.dailyLimit,
      });
    }

    logger.info({ tenantId, keywords, location, count, enrichEmails }, 'LinkedIn headhunt: starting');

    // 1. Search
    const searchResult = await searchLinkedInPeople(keywords, location || '', count);
    if (searchResult.results.length === 0) {
      return { success: true, candidates: [], total: 0, message: 'No results found' };
    }

    // 2. Enrich each result
    const candidates: Array<{
      firstName: string;
      lastName: string;
      headline: string;
      location: string;
      linkedinUrl: string;
      currentCompany: string;
      email?: string;
      emailMethod?: string;
      profile?: Record<string, unknown>;
      saved?: boolean;
      contactId?: string;
    }> = [];

    for (const result of searchResult.results) {
      const candidate: (typeof candidates)[number] = {
        firstName: result.firstName,
        lastName: result.lastName,
        headline: result.headline || '',
        location: result.location || '',
        linkedinUrl: result.profileUrl || '',
        currentCompany: result.currentCompany || '',
      };

      // Full profile
      if (candidate.linkedinUrl) {
        const currentStats = getVoyagerStats();
        if (currentStats.dailyCount < currentStats.dailyLimit) {
          try {
            const profile = await getLinkedInProfile(candidate.linkedinUrl);
            if (profile) {
              candidate.profile = {
                summary: profile.summary,
                experiences: profile.experiences,
                education: profile.education,
                skills: profile.skills,
                languages: profile.languages,
                certifications: profile.certifications,
              };

              // Email finding from company domain
              if (enrichEmails && profile.experiences?.[0]?.company) {
                try {
                  const companyName = profile.experiences[0].company;
                  const domainGuess = companyName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
                  const emailResult = await findEmailByPattern(candidate.firstName, candidate.lastName, domainGuess);
                  if (emailResult.email) {
                    candidate.email = emailResult.email;
                    candidate.emailMethod = emailResult.method;
                  }
                } catch {}
              }
            }
          } catch {}
        }
      }

      // Save to contacts table
      try {
        const [saved] = await withTenant(tenantId, async (tx) => {
          return tx.insert(contacts).values({
            tenantId,
            masterAgentId: masterAgentId || undefined,
            firstName: candidate.firstName || undefined,
            lastName: candidate.lastName || undefined,
            title: candidate.headline || undefined,
            companyName: candidate.currentCompany || undefined,
            linkedinUrl: candidate.linkedinUrl || undefined,
            email: candidate.email || undefined,
            source: 'linkedin_search',
            status: candidate.email ? 'enriched' : 'discovered',
            rawData: {
              discoverySource: 'linkedin-headhunt-api',
              headline: candidate.headline,
              location: candidate.location,
              profile: candidate.profile,
              emailMethod: candidate.emailMethod,
            },
          }).onConflictDoNothing().returning({ id: contacts.id });
        });
        if (saved) {
          candidate.saved = true;
          candidate.contactId = saved.id;
        }
      } catch (err) {
        logger.warn({ name: `${candidate.firstName} ${candidate.lastName}`, err: err instanceof Error ? err.message : String(err) }, 'Headhunt: save contact failed');
      }

      candidates.push(candidate);
    }

    const emailsFound = candidates.filter(c => c.email).length;
    const savedCount = candidates.filter(c => c.saved).length;

    logger.info({ tenantId, keywords, total: candidates.length, emailsFound, saved: savedCount }, 'LinkedIn headhunt: completed');

    return {
      success: true,
      total: searchResult.total,
      candidates,
      metrics: {
        searched: searchResult.results.length,
        profilesEnriched: candidates.filter(c => c.profile).length,
        emailsFound,
        saved: savedCount,
      },
    };
  });
}
