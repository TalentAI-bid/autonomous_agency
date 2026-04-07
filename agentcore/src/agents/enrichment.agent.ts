import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents } from '../db/schema/index.js';
import { emailIntelligenceEngine } from '../tools/email-intelligence.js';
import { isMegaCorp, shouldSkipDomain, isJunkUrl } from '../utils/domain-blocklist.js';
import { type SearchResult } from '../tools/searxng.tool.js';
import {
  buildSystemPrompt as candidateSystemPrompt,
  buildUserPrompt as candidateUserPrompt,
  type CandidateProfile,
} from '../prompts/candidate-profile.prompt.js';
import {
  buildSystemPrompt as companyDeepSystemPrompt,
  buildUserPrompt as companyDeepUserPrompt,
  type DeepCompanyProfile,
} from '../prompts/company-deep.prompt.js';
import {
  buildSystemPrompt as searchKeywordsSystemPrompt,
  buildUserPrompt as searchKeywordsUserPrompt,
  type GeneratedSearchQueries,
} from '../prompts/search-keywords.prompt.js';
import { EFFECTIVE_RATE_LIMIT } from '../tools/searxng.tool.js';
import logger from '../utils/logger.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMissionContextString(ctx: unknown): string | undefined {
  const c = ctx as
    | {
        missionText?: string;
        useCase?: string;
        sales?: { services?: string[]; valueProposition?: string; industries?: string[] };
        recruitment?: { requiredSkills?: string[]; experienceLevel?: string };
        targetRoles?: string[];
      }
    | undefined;
  if (!c) return undefined;
  const parts: string[] = [];
  if (c.missionText) parts.push(`Mission: ${c.missionText}`);
  if (c.useCase) parts.push(`Use case: ${c.useCase}`);
  if (c.sales?.services?.length) parts.push(`Services being sold: ${c.sales.services.join(', ')}`);
  if (c.sales?.valueProposition) parts.push(`Value proposition: ${c.sales.valueProposition}`);
  if (c.sales?.industries?.length) parts.push(`Target industries: ${c.sales.industries.join(', ')}`);
  if (c.recruitment?.requiredSkills?.length) parts.push(`Skills sought: ${c.recruitment.requiredSkills.join(', ')}`);
  if (c.targetRoles?.length) parts.push(`Target roles: ${c.targetRoles.join(', ')}`);
  return parts.length ? parts.join('\n') : undefined;
}

export class EnrichmentAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, companyId: inputCompanyId, masterAgentId, dryRun } = input as {
      contactId?: string;
      companyId?: string;
      masterAgentId: string;
      dryRun?: boolean;
    };

    // ── Company-only enrichment path ─────────────────────────────────────────
    if (inputCompanyId && !contactId) {
      return this.executeCompanyOnly(inputCompanyId, masterAgentId, input);
    }

    if (!contactId) throw new Error('Either contactId or companyId must be provided');

    logger.info({ tenantId: this.tenantId, contactId }, 'EnrichmentAgent starting');

    // Check SearXNG budget — skip enrichment if exhausted
    try {
      const searchCount = await this.redis.get(`tenant:${this.tenantId}:ratelimit:search`);
      const count = searchCount ? parseInt(searchCount, 10) : 0;
      const remaining = EFFECTIVE_RATE_LIMIT - count;
      if (remaining < 50) {
        const ttl = await this.redis.ttl(`tenant:${this.tenantId}:ratelimit:search`);
        logger.warn({ tenantId: this.tenantId, contactId, remaining, count, ttl }, 'SearXNG budget exhausted — skipping enrichment');
        await this.clearCurrentAction();
        return { enriched: false, reason: 'search_budget_exhausted', remaining };
      }
      if (remaining < 200) {
        const ttl = await this.redis.ttl(`tenant:${this.tenantId}:ratelimit:search`);
        logger.warn({ tenantId: this.tenantId, contactId, remaining, ttl }, 'SearXNG budget low');
      }
    } catch {
      // Redis check failure is non-critical, continue
    }

    await this.setCurrentAction('enrichment', `Enriching contact ${contactId.slice(0, 8)}`);

    // Check for human instructions
    const humanInstruction = await this.checkHumanInstructions();
    if (humanInstruction) {
      logger.info({ contactId, humanInstruction }, 'EnrichmentAgent received human instruction');
    }

    // 1. Load contact
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    // Hard cap on retries to prevent queue explosion
    const retryCount = (input.retryCount as number) ?? 0;
    if (retryCount > 3) {
      logger.warn({ contactId, retryCount }, 'Enrichment max retries exceeded — archiving');
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts).set({ status: 'archived', updatedAt: new Date() }).where(eq(contacts.id, contactId));
      });
      await this.clearCurrentAction();
      return { contactId, status: 'max_retries_exceeded' };
    }

    // Skip contacts with non-Latin names (SearXNG can't search Chinese/Arabic/etc.)
    const fullNameCheck = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
    if (fullNameCheck && !/[a-zA-Z]/.test(fullNameCheck)) {
      logger.info({ contactId, name: fullNameCheck }, 'Skipping enrichment: non-Latin name (SearXNG cannot search)');
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts).set({ status: 'archived', updatedAt: new Date() }).where(eq(contacts.id, contactId));
      });
      await this.clearCurrentAction();
      return { contactId, status: 'archived', reason: 'non_latin_name' };
    }

    const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const contactTitle = contact.title ?? '';
    let contactCompanyName = contact.companyName ?? '';
    // Type guard: company name may be stored as JSON object string
    if (contactCompanyName.startsWith('{') && contactCompanyName.includes('"name"')) {
      try {
        const parsed = JSON.parse(contactCompanyName);
        contactCompanyName = parsed.name || contactCompanyName;
      } catch { /* keep original */ }
    }
    const raw = (contact.rawData as Record<string, unknown>) ?? {};

    // Get useCase from PipelineContext or fall back to DB
    const ctx = this.getPipelineContext(input);
    let useCase: string | undefined = ctx?.useCase;
    if (!useCase) {
      try {
        const [agent] = await withTenant(this.tenantId, async (tx) => {
          return tx.select({ useCase: masterAgents.useCase }).from(masterAgents)
            .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
            .limit(1);
        });
        useCase = agent?.useCase;
      } catch (err) {
        logger.warn({ err, masterAgentId }, 'Failed to load useCase from master agent');
      }
    }

    // ── Phase 0: LLM brain — generate smart search queries ─────────────────

    const skills = (contact.skills as string[]) ?? [];
    const skillsStr = skills.slice(0, 3).join(' ');

    const smartQueries = await this.generateSmartQueries({
      companyName: contactCompanyName || 'Unknown',
      contactName: contactName || undefined,
      contactTitle: contactTitle || undefined,
    });

    // ── Phase 1: Multi-source data collection (6 parallel sources) ─────────

    let githubContent = '';
    let githubReposContent = '';
    let personalSiteContent = '';
    let linkedinContent = '';
    let linkedinSearchContent = '';
    let twitterContent = '';
    let stackOverflowContent = '';
    let devCommunityContent = '';
    let foundLinkedinUrl: string | null = null;

    // Quick company domain lookup for URL validation in source searches
    let knownCompanyDomain: string | undefined;
    if (contact.companyId) {
      try {
        const [comp] = await withTenant(this.tenantId, async (tx) => {
          return tx.select({ domain: companies.domain }).from(companies)
            .where(eq(companies.id, contact.companyId!))
            .limit(1);
        });
        if (comp?.domain) knownCompanyDomain = comp.domain.toLowerCase().replace(/^www\./, '');
      } catch { /* non-critical */ }
    }

    // Branch sources by use case
    const setFoundLinkedinUrl = (url: string) => { foundLinkedinUrl = url; };
    const sourceResults = useCase === 'sales'
      ? await this.runSalesSourceSearches(contactId, contactName, contactTitle, contactCompanyName, knownCompanyDomain, contact, smartQueries, (content) => { linkedinContent = content; }, (content) => { linkedinSearchContent = content; }, (content) => { twitterContent = content; }, (content) => { personalSiteContent = content; }, setFoundLinkedinUrl)
      : await this.runRecruitmentSourceSearches(contactId, contactName, contactTitle, contactCompanyName, skillsStr, contact, smartQueries, (content) => { linkedinContent = content; }, (content) => { linkedinSearchContent = content; }, (content) => { githubContent = content; }, (content) => { githubReposContent = content; }, (content) => { twitterContent = content; }, (content) => { stackOverflowContent = content; }, (content) => { personalSiteContent = content; }, (content) => { devCommunityContent = content; }, setFoundLinkedinUrl);

    // Log any failures from parallel sources
    sourceResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        const sourceNames = useCase === 'sales'
          ? ['LinkedIn', 'CompanyTeamPage', 'CompanyNews', 'IndustryPubs', 'Twitter/X', 'CompanyLinkedIn']
          : ['LinkedIn', 'GitHub', 'Twitter/X', 'StackOverflow', 'Blog/Portfolio', 'DevCommunity'];
        logger.warn({ err: result.reason, contactId, source: sourceNames[i] }, 'Source search failed');
      }
    });

    // ── Phase 2: Deep company enrichment ───────────────────────────────────

    let companyId = contact.companyId;
    let companyEnriched = false;

    if (contactCompanyName) {
      try {
        // Search for company website using LLM-generated smart queries (max 2)
        let companySearchResults: SearchResult[] = [];
        for (const query of smartQueries.companyWebsiteQueries.slice(0, 2)) {
          const results = await this.searchWeb(query, 10);
          companySearchResults.push(...results);
          if (results.length > 0) break;
        }
        // Fallback to hardcoded query if smart queries returned nothing
        if (companySearchResults.length === 0) {
          companySearchResults = await this.searchWeb(
            `${contactCompanyName} company official website -site:linkedin.com -site:indeed.com -site:glassdoor.com`,
          );
          if (companySearchResults.length === 0) {
            logger.warn({ companyName: contactCompanyName, queriesAttempted: Math.min(smartQueries.companyWebsiteQueries.length, 2) + 1 }, 'All company website search queries returned 0 results');
          }
        }
        const companyUrl = companySearchResults.find((r) => r.url.startsWith('https://') && !isJunkUrl(r.url))?.url;

        let homepageContent = '';
        let aboutPageContent = '';
        let careersPageContent = '';
        let teamPageContent = '';
        let linkedinCompanyContent = '';
        let crunchbaseContent = '';
        let newsContent = '';
        let glassdoorContent = '';
        let companyDomain: string | undefined;

        if (companyUrl) {
          try {
            companyDomain = new URL(companyUrl).hostname.replace('www.', '');
          } catch { /* ignore */ }

          // Scrape homepage
          homepageContent = await this.scrapeUrl(companyUrl);
        }

        // Run remaining 5 company sources + about/careers in parallel
        const companySourceResults = await Promise.allSettled([
          // Source 1b: About page
          (async () => {
            if (!companyUrl) return;
            aboutPageContent = await this.scrapeUrl(new URL('/about', companyUrl).href);
          })(),

          // Source 1c: Careers page
          (async () => {
            if (!companyUrl) return;
            careersPageContent = await this.scrapeUrl(new URL('/careers', companyUrl).href);
          })(),

          // Source 2: Team/Leadership page — try multiple paths
          (async () => {
            if (!companyUrl) return;
            for (const path of ['/team', '/about', '/about-us', '/leadership', '/our-team', '/people', '/management', '/company/team']) {
              try {
                const url = new URL(path, companyUrl).href;
                const content = await this.scrapeUrl(url);
                if (content && content.length > 200) {
                  teamPageContent = content;
                  logger.info({ contactId, teamUrl: url }, 'Team page scraped');
                  break;
                }
              } catch { /* try next path */ }
            }
          })(),

          // Source 3: LinkedIn + Crunchbase combined (1 SearXNG call instead of 2)
          (async () => {
            const query = `"${contactCompanyName}" LinkedIn OR Crunchbase OR funding`;
            const results = await this.searchWeb(query, 10);
            // Extract LinkedIn company URL
            const liUrl = results.find((r) => r.url.includes('linkedin.com/company/'))?.url;
            if (liUrl) {
              linkedinCompanyContent = await this.scrapeUrl(liUrl);
              logger.info({ contactId, liUrl }, 'LinkedIn company page scraped');
            }
            // Extract Crunchbase/funding URL
            const cbUrl = results.find((r) =>
              r.url.includes('crunchbase.com') || r.url.includes('techcrunch.com'),
            )?.url;
            if (cbUrl) {
              crunchbaseContent = await this.scrapeUrl(cbUrl);
              logger.info({ contactId, cbUrl }, 'Crunchbase/funding content scraped');
            } else {
              crunchbaseContent = results.filter(r => !r.url.includes('linkedin.com')).slice(0, 3).map((r) => `${r.title}: ${r.snippet}`).join('\n');
            }
          })(),

          // Source 4: Company news (1 SearXNG call)
          (async () => {
            const query = `${contactCompanyName} latest news 2026`;
            const results = await this.searchWeb(query, 5);
            newsContent = results.slice(0, 5).map((r) => `${r.title} (${r.url}): ${r.snippet}`).join('\n');
            logger.info({ contactId, resultsCount: results.length }, 'Company news gathered');
          })(),
        ]);

        // Log company source failures
        companySourceResults.forEach((result, i) => {
          if (result.status === 'rejected') {
            const sourceNames = ['About', 'Careers', 'Team', 'LinkedIn+Crunchbase', 'News'];
            logger.warn({ err: result.reason, contactId, source: sourceNames[i] }, 'Company source search failed');
          }
        });

        const searchSnippets = companySearchResults.map((r) => `${r.title}: ${r.snippet}`).join('\n');

        // Deep company enrichment via LLM
        const deepCompany = await this.extractJSON<DeepCompanyProfile>([
          { role: 'system', content: companyDeepSystemPrompt(buildMissionContextString(ctx)) },
          {
            role: 'user',
            content: companyDeepUserPrompt({
              companyName: contactCompanyName,
              domain: companyDomain,
              homepageContent,
              aboutPageContent,
              careersPageContent,
              teamPageContent,
              linkedinCompanyContent,
              crunchbaseContent,
              newsContent,
              glassdoorContent,
              searchResults: searchSnippets,
            }),
          },
        ]);

        // Calculate company data completeness
        const companyFields = [deepCompany.name, deepCompany.domain, deepCompany.industry, deepCompany.size, deepCompany.description, deepCompany.funding, deepCompany.linkedinUrl, deepCompany.foundedYear, deepCompany.headquarters, deepCompany.techStack?.length ? 'yes' : '', deepCompany.keyPeople?.length ? 'yes' : '', deepCompany.recentNews?.length ? 'yes' : '', deepCompany.products?.length ? 'yes' : '', deepCompany.competitors?.length ? 'yes' : ''];
        const companyFilledFields = companyFields.filter(f => f && String(f).length > 0).length;
        const companyDataCompleteness = Math.round((companyFilledFields / companyFields.length) * 100);

        // Save company with deep data (type guard: LLM may return object for name)
        const resolvedCompanyName = typeof deepCompany.name === 'object'
          ? (deepCompany.name as any).name || contactCompanyName
          : (deepCompany.name || contactCompanyName);
        const company = await this.saveOrUpdateCompany({
          name: resolvedCompanyName,
          domain: deepCompany.domain || companyDomain || undefined,
          industry: deepCompany.industry || undefined,
          size: deepCompany.size || undefined,
          techStack: deepCompany.techStack?.length ? deepCompany.techStack : undefined,
          funding: deepCompany.funding || undefined,
          description: deepCompany.description || undefined,
          linkedinUrl: deepCompany.linkedinUrl || undefined,
          dataCompleteness: companyDataCompleteness,
          rawData: {
            products: deepCompany.products,
            foundedYear: deepCompany.foundedYear,
            headquarters: deepCompany.headquarters,
            cultureValues: deepCompany.cultureValues,
            recentNews: deepCompany.recentNews,
            openPositions: deepCompany.openPositions,
            keyPeople: deepCompany.keyPeople,
            competitors: deepCompany.competitors,
            contactEmail: deepCompany.contactEmail || undefined,
            hiringContactEmails: deepCompany.hiringContactEmails?.length ? deepCompany.hiringContactEmails : undefined,
            glassdoorRating: deepCompany.glassdoorRating || undefined,
            employeeCount: deepCompany.employeeCount || undefined,
            recentFunding: deepCompany.recentFunding || undefined,
            teamPageUrl: deepCompany.teamPageUrl || undefined,
          },
        });

        companyId = company.id;
        companyEnriched = true;

        // Link contact to company
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(contacts)
            .set({ companyId: company.id, updatedAt: new Date() })
            .where(eq(contacts.id, contactId));
        });

        // ── Phase 2b: Key person deep research ──────────────────────────────
        if (deepCompany.keyPeople?.length && companyDomain) {
          const keyPeopleToResearch = deepCompany.keyPeople.slice(0, 3);
          const keyPeopleResults = await Promise.allSettled(
            keyPeopleToResearch.map(async (person) => {
              if (!person.name) return person;

              let personLinkedinUrl = person.linkedinUrl || '';
              let personEmail = person.email || '';

              // Search LinkedIn for this person if no URL yet
              if (!personLinkedinUrl) {
                try {
                  const query = `site:linkedin.com/in/ "${person.name}" "${contactCompanyName}"`;
                  const results = await this.searchWeb(query, 3);
                  personLinkedinUrl = results.find((r) => r.url.includes('linkedin.com/in/'))?.url ?? '';
                  if (personLinkedinUrl) {
                    logger.info({ contactId, personName: person.name, personLinkedinUrl }, 'Key person LinkedIn found');
                  }
                } catch (err) {
                  logger.warn({ err, contactId, personName: person.name }, 'Key person LinkedIn search failed');
                }
              }

              // Find email for this person
              if (!personEmail && companyDomain) {
                try {
                  const nameParts = person.name.trim().split(/\s+/);
                  const firstName = nameParts[0] ?? '';
                  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1]! : '';
                  if (firstName && lastName) {
                    const emailResult = await emailIntelligenceEngine.findEmail(firstName, lastName, companyDomain, this.tenantId, companyId ?? undefined);
                    if (emailResult.email) {
                      personEmail = emailResult.email;
                      logger.info({ contactId, personName: person.name, personEmail }, 'Key person email found');
                    }
                  }
                } catch (err) {
                  logger.warn({ err, contactId, personName: person.name }, 'Key person email search failed');
                }
              }

              // Create a contact record for the key person
              try {
                const nameParts = person.name.trim().split(/\s+/);
                const firstName = nameParts[0] ?? '';
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
                const keyPersonContact = await this.saveOrUpdateContact({
                  firstName,
                  lastName,
                  title: person.title || undefined,
                  companyName: contactCompanyName,
                  companyId: company.id,
                  masterAgentId,
                  linkedinUrl: personLinkedinUrl || undefined,
                  email: personEmail || undefined,
                  status: personEmail ? 'enriched' : 'discovered',
                  source: 'web_search',
                  rawData: {
                    source: 'key_person_enrichment',
                    department: person.department || undefined,
                    parentContactId: contactId,
                  },
                });
                logger.info({ contactId, personName: person.name, hasEmail: !!personEmail }, 'Key person contact created');

                // Dispatch to scoring if we have email
                if (personEmail && keyPersonContact.id) {
                  await this.dispatchNext('scoring', {
                    contactId: keyPersonContact.id,
                    masterAgentId,
                    pipelineContext: ctx,
                    dryRun,
                  });
                }
              } catch (err) {
                logger.warn({ err, contactId, personName: person.name }, 'Failed to create key person contact');
              }

              return { ...person, linkedinUrl: personLinkedinUrl, email: personEmail };
            }),
          );

          // Update keyPeople in company rawData with enriched data
          const enrichedKeyPeople = keyPeopleResults.map((r, i) =>
            r.status === 'fulfilled' ? r.value : keyPeopleToResearch[i],
          );

          await withTenant(this.tenantId, async (tx) => {
            const [existing] = await tx.select().from(companies).where(eq(companies.id, company.id)).limit(1);
            const existingRaw = (existing?.rawData as Record<string, unknown>) ?? {};
            await tx.update(companies)
              .set({
                rawData: { ...existingRaw, keyPeople: enrichedKeyPeople },
                updatedAt: new Date(),
              })
              .where(eq(companies.id, company.id));
          });

          logger.info({ contactId, keyPeopleCount: enrichedKeyPeople.length }, 'Key people enrichment completed');
        }
      } catch (err) {
        logger.warn({ err, contactId, companyName: contactCompanyName }, 'Deep company enrichment failed');
      }
    }

    // ── Phase 3: Email discovery ───────────────────────────────────────────

    let emailFound = contact.email;
    let emailVerified = contact.emailVerified ?? false;

    if (!emailFound && contact.firstName && contact.lastName && contactCompanyName) {
      try {
        let domain = '';
        if (companyId) {
          const [company] = await withTenant(this.tenantId, async (tx) => {
            return tx.select().from(companies)
              .where(eq(companies.id, companyId!))
              .limit(1);
          });
          domain = company?.domain ?? '';
        }

        if (!domain) {
          const domainResults = await this.searchWeb(`${contactCompanyName} official website`);
          const domainUrl = domainResults.find((r) =>
            !r.url.includes('linkedin.com') &&
            !r.url.includes('facebook.com') &&
            r.url.startsWith('https://'),
          )?.url;
          if (domainUrl) {
            try {
              domain = new URL(domainUrl).hostname.replace('www.', '');
            } catch { /* ignore */ }
          }
        }

        if (domain) {
          const result = await emailIntelligenceEngine.findEmail(contact.firstName!, contact.lastName!, domain, this.tenantId, companyId ?? undefined);
          if (result.email && result.confidence >= 50) {
            emailFound = result.email;
            emailVerified = result.confidence >= 80;
          }
        }
      } catch (err) {
        logger.warn({ err, contactId }, 'Email discovery failed');
      }
    }

    // ── Phase 4: LLM synthesis — merge all sources into CandidateProfile ──

    let profile: CandidateProfile | null = null;
    const searchSnippets = [
      raw.snippet ? `${raw.title}: ${raw.snippet}` : '',
    ].filter(Boolean).join('\n');

    try {
      profile = await this.extractJSON<CandidateProfile>([
        { role: 'system', content: candidateSystemPrompt(useCase) },
        {
          role: 'user',
          content: candidateUserPrompt({
            existingContact: {
              firstName: contact.firstName ?? undefined,
              lastName: contact.lastName ?? undefined,
              title: contact.title ?? undefined,
              companyName: contactCompanyName || undefined,
              location: contact.location ?? undefined,
              email: emailFound ?? undefined,
              linkedinUrl: contact.linkedinUrl ?? undefined,
              skills: (contact.skills as string[]) ?? undefined,
              experience: (contact.experience as Record<string, unknown>[]) ?? undefined,
              education: (contact.education as Record<string, unknown>[]) ?? undefined,
            },
            linkedinContent: linkedinContent || undefined,
            linkedinSearchContent: linkedinSearchContent || undefined,
            githubContent: githubContent || undefined,
            githubReposContent: githubReposContent || undefined,
            personalSiteContent: personalSiteContent || undefined,
            twitterContent: twitterContent || undefined,
            stackOverflowContent: stackOverflowContent || undefined,
            devCommunityContent: devCommunityContent || undefined,
            searchSnippets: searchSnippets || undefined,
          }),
        },
      ]);
    } catch (err) {
      logger.warn({ err, contactId }, 'LLM synthesis failed');
    }

    // ── Update contact with all enriched data ──────────────────────────────

    const updateData: Record<string, unknown> = {
      email: emailFound ?? undefined,
      emailVerified,
      companyId: companyId ?? undefined,
      linkedinUrl: foundLinkedinUrl ?? contact.linkedinUrl ?? undefined,
      updatedAt: new Date(),
    };

    if (profile) {
      updateData.firstName = profile.firstName || contact.firstName;
      updateData.lastName = profile.lastName || contact.lastName;
      updateData.title = profile.title || contact.title;
      updateData.companyName = profile.company || contactCompanyName;
      updateData.location = profile.location || contact.location;
      updateData.skills = profile.skills?.length ? profile.skills : contact.skills;
      updateData.experience = profile.experience?.length ? profile.experience : contact.experience;
      updateData.education = profile.education?.length ? profile.education : contact.education;
      updateData.rawData = {
        ...raw,
        githubUrl: profile.githubUrl || undefined,
        personalWebsite: profile.personalWebsite || undefined,
        twitterUrl: profile.twitterUrl || undefined,
        stackOverflowUrl: profile.stackOverflowUrl || undefined,
        mediumUrl: profile.mediumUrl || undefined,
        blogPosts: profile.blogPosts?.length ? profile.blogPosts : undefined,
        skillLevels: profile.skillLevels,
        openSourceContributions: profile.openSourceContributions,
        certifications: profile.certifications,
        languages: profile.languages,
        totalYearsExperience: profile.totalYearsExperience,
        seniorityLevel: profile.seniorityLevel,
        dataCompleteness: profile.dataCompleteness,
        summary: profile.summary,
        githubStats: profile.githubStats,
      };
    }

    // ── Phase 5: Quality gate (70% threshold with retry logic) ────────────

    const dataCompleteness = profile?.dataCompleteness ?? 0;

    // Save data completeness to contact record (integer column — must round)
    updateData.dataCompleteness = Math.round(dataCompleteness);

    const qualityDecision = dataCompleteness >= 40 ? 'pass' : (dataCompleteness >= 25 ? 'retry' : 'archive');
    this.sendMessage(null, 'reasoning', {
      contactName,
      dataCompleteness,
      decision: qualityDecision,
      emailFound: !!emailFound,
      companyEnriched,
    });

    if (dataCompleteness < 40) {
      // Fast-path: if we found an email, go directly to scoring regardless of completeness
      if (emailFound) {
        updateData.status = 'enriched';
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(contacts).set(updateData).where(eq(contacts.id, contactId));
        });

        await this.dispatchNext('scoring', { contactId, masterAgentId, pipelineContext: ctx, dryRun });

        this.logActivity('enrichment_completed_with_email', 'completed', {
          inputSummary: contactName,
          details: { contactId, dataCompleteness, emailFound, fastPath: true },
        });
        await this.clearCurrentAction();

        logger.info({ contactId, dataCompleteness, emailFound }, 'EnrichmentAgent: email fast-path → scoring');

        return {
          email: emailFound, emailVerified, companyEnriched, companyId,
          dataCompleteness, status: 'enriched_email_fastpath',
        };
      }

      const retryCount = (input.retryCount as number) ?? 0;

      if (dataCompleteness >= 25 && retryCount < 2) {
        // Retry enrichment with deeper search strategies
        updateData.status = 'discovered'; // keep in pipeline for retry

        await withTenant(this.tenantId, async (tx) => {
          await tx.update(contacts).set(updateData).where(eq(contacts.id, contactId));
        });

        await this.dispatchNext('enrichment', {
          contactId, masterAgentId,
          retryCount: retryCount + 1,
          deepMode: true,
          pipelineContext: ctx,
        });

        this.logActivity('quality_gate_retry', 'completed', {
          inputSummary: contactName,
          details: { contactId, dataCompleteness, retryCount: retryCount + 1 },
        });
        await this.clearCurrentAction();

        logger.info({ contactId, dataCompleteness, retryCount: retryCount + 1 }, 'EnrichmentAgent: retrying with deeper search');

        return {
          email: emailFound,
          emailVerified,
          companyEnriched,
          companyId,
          dataCompleteness,
          status: 'retry_enrichment',
          retryCount: retryCount + 1,
        };
      }

      // Retries exhausted but >= 25% — mark as enriched (partial) and still dispatch to scoring
      if (dataCompleteness >= 25) {
        updateData.status = 'enriched';
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(contacts).set(updateData).where(eq(contacts.id, contactId));
        });

        await this.dispatchNext('scoring', { contactId, masterAgentId, pipelineContext: ctx, dryRun });

        this.logActivity('enrichment_completed_partial', 'completed', {
          inputSummary: contactName,
          details: { contactId, dataCompleteness, retryCount, partial: true },
        });
        await this.clearCurrentAction();

        logger.info({ contactId, dataCompleteness, retryCount }, 'EnrichmentAgent: contact enriched (partial data)');

        return {
          email: emailFound, emailVerified, companyEnriched, companyId,
          dataCompleteness, status: 'enriched_partial',
        };
      }

      // Archive if < 25%
      updateData.status = 'archived';
      updateData.rawData = {
        ...(updateData.rawData as Record<string, unknown> ?? raw),
        skipReason: 'insufficient_data',
        dataCompleteness,
      };

      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts).set(updateData).where(eq(contacts.id, contactId));
      });

      this.logActivity('quality_gate_failed', 'completed', {
        inputSummary: contactName,
        details: { contactId, dataCompleteness, reason: 'insufficient_data', retryCount },
      });
      await this.clearCurrentAction();

      await this.emitEvent('contact:archived', {
        contactId,
        reason: 'insufficient_data',
        dataCompleteness,
      });

      logger.info({ contactId, dataCompleteness, retryCount }, 'EnrichmentAgent: contact archived (insufficient data)');

      return {
        email: emailFound,
        emailVerified,
        companyEnriched,
        companyId,
        dataCompleteness,
        status: 'archived',
        skipReason: 'insufficient_data',
      };
    }

    // Sufficient data — mark enriched and dispatch scoring
    updateData.status = 'enriched';

    await withTenant(this.tenantId, async (tx) => {
      await tx.update(contacts).set(updateData).where(eq(contacts.id, contactId));
    });

    this.sendMessage('scoring', 'data_handoff', {
      contactId,
      contactName,
      companyName: contactCompanyName,
      dataCompleteness,
    });

    await this.dispatchNext('scoring', { contactId, masterAgentId, pipelineContext: ctx, dryRun });

    await this.emitEvent('contact:enriched', {
      contactId,
      email: emailFound,
      emailVerified,
      companyEnriched,
      companyId,
      dataCompleteness,
    });

    this.logActivity('enrichment_completed', 'completed', {
      inputSummary: contactName,
      details: { contactId, emailFound: !!emailFound, emailVerified, companyEnriched, dataCompleteness },
    });
    await this.clearCurrentAction();

    logger.info({
      tenantId: this.tenantId, contactId, emailFound: !!emailFound, companyEnriched, dataCompleteness,
    }, 'EnrichmentAgent completed');

    return {
      email: emailFound,
      emailVerified,
      companyEnriched,
      companyId,
      dataCompleteness,
      status: 'enriched',
    };
  }

  // ── Company-only enrichment ──────────────────────────────────────────────

  private async executeCompanyOnly(
    companyId: string,
    masterAgentId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    logger.info({ tenantId: this.tenantId, companyId }, 'EnrichmentAgent starting (company-only)');

    // Check SearXNG budget — skip enrichment if exhausted
    try {
      const searchCount = await this.redis.get(`tenant:${this.tenantId}:ratelimit:search`);
      const count = searchCount ? parseInt(searchCount, 10) : 0;
      const remaining = EFFECTIVE_RATE_LIMIT - count;
      if (remaining < 50) {
        const ttl = await this.redis.ttl(`tenant:${this.tenantId}:ratelimit:search`);
        logger.warn({ tenantId: this.tenantId, companyId, remaining, count, ttl }, 'SearXNG budget exhausted — skipping company enrichment');
        return { enriched: false, reason: 'search_budget_exhausted', remaining };
      }
    } catch {
      // Redis check failure is non-critical, continue
    }

    await this.setCurrentAction('company_enrichment', `Enriching company ${companyId.slice(0, 8)}`);

    // Load company
    const [company] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!company) throw new Error(`Company ${companyId} not found`);

    // Type guard: company name may be stored as JSON object string
    let companyName = company.name;
    if (companyName && companyName.startsWith('{') && companyName.includes('"name"')) {
      try {
        const parsed = JSON.parse(companyName);
        companyName = parsed.name || companyName;
      } catch { /* keep original */ }
    }

    // Skip mega-corps and junk domains
    const companyDomainCheck = (company.domain ?? '').toLowerCase().replace('www.', '');
    if (companyDomainCheck && (isMegaCorp(companyDomainCheck) || shouldSkipDomain(companyDomainCheck))) {
      logger.info({ companyId, companyName, domain: companyDomainCheck }, 'Skipping enrichment for mega-corp/junk domain');
      await this.clearCurrentAction();
      return { companyId, companyName, status: 'skipped', reason: 'mega_corp_or_junk_domain' };
    }

    // Skip enrichment for companies with garbage/generic names
    if (!companyName || companyName.length < 2 || companyName === 'Unknown' ||
        /^(meet\s+the|top\s+\d+|best\s+\d+)\s/i.test(companyName) ||
        companyName.split(/\s+/).length > 8) {
      logger.warn({ companyId, companyName }, 'Skipping enrichment for invalid company name');
      this.logActivity('company_enrichment_skipped', 'skipped', {
        inputSummary: companyName || 'invalid',
        details: { companyId, reason: 'invalid_company_name' },
      });
      await this.clearCurrentAction();
      return { companyId, companyName, status: 'skipped', reason: 'invalid_company_name' };
    }

    const ctx = this.getPipelineContext(input);

    // ── Phase 0: LLM brain — generate smart search queries ─────────────
    const smartQueries = await this.generateSmartQueries({
      companyName,
      domain: company.domain ?? undefined,
      industry: company.industry ?? undefined,
    });

    // ── Phase 2: Deep company enrichment (same as contact path) ─────────
    let companyDomain = company.domain ?? undefined;

    // If no domain, try to resolve it using LLM-generated queries first
    if (!companyDomain) {
      const noiseDomains = ['linkedin.com', 'glassdoor.com', 'indeed.com', 'crunchbase.com', 'wikipedia.org', 'twitter.com', 'facebook.com'];
      for (const query of smartQueries.domainResolutionQueries.slice(0, 2)) {
        const results = await this.searchWeb(query, 5);
        for (const r of results) {
          try {
            const hostname = new URL(r.url).hostname.replace('www.', '');
            if (!noiseDomains.some(d => hostname.includes(d))) {
              companyDomain = hostname;
              break;
            }
          } catch { /* skip */ }
        }
        if (companyDomain) break;
      }
      if (companyDomain) {
        logger.info({ companyId, companyName, resolvedDomain: companyDomain }, 'Domain resolved via LLM smart queries');
      } else {
        logger.info({ companyId, companyName }, 'Proceeding with company enrichment without domain');
      }
    }

    try {
      // Search for company website using LLM-generated smart queries
      let companySearchResults: SearchResult[] = [];
      for (const query of smartQueries.companyWebsiteQueries.slice(0, 2)) {
        const results = await this.searchWeb(query, 10);
        companySearchResults.push(...results);
        if (results.length > 0) break;
      }
      // Fallback to hardcoded query if smart queries returned nothing
      if (companySearchResults.length === 0) {
        companySearchResults = await this.searchWeb(
          `${companyName} company official website -site:linkedin.com -site:indeed.com -site:glassdoor.com`,
        );
        if (companySearchResults.length === 0) {
          logger.warn({ companyName, queriesAttempted: Math.min(smartQueries.companyWebsiteQueries.length, 2) + 1 }, 'All company website search queries returned 0 results');
        }
      }
      const companyUrl = companySearchResults.find((r) => r.url.startsWith('https://') && !isJunkUrl(r.url))?.url;

      let homepageContent = '';
      let aboutPageContent = '';
      let careersPageContent = '';
      let teamPageContent = '';
      let linkedinCompanyContent = '';
      let crunchbaseContent = '';
      let newsContent = '';
      let glassdoorContent = '';

      if (companyUrl) {
        try {
          companyDomain = companyDomain || new URL(companyUrl).hostname.replace('www.', '');
        } catch { /* ignore */ }
        homepageContent = await this.scrapeUrl(companyUrl);
      }

      const companySourceResults = await Promise.allSettled([
        (async () => { if (!companyUrl) return; aboutPageContent = await this.scrapeUrl(new URL('/about', companyUrl).href); })(),
        (async () => { if (!companyUrl) return; careersPageContent = await this.scrapeUrl(new URL('/careers', companyUrl).href); })(),
        // Team page — try multiple paths
        (async () => {
          if (!companyUrl) return;
          for (const path of ['/team', '/about', '/about-us', '/leadership', '/our-team', '/people', '/management', '/company/team']) {
            try {
              const url = new URL(path, companyUrl).href;
              const content = await this.scrapeUrl(url);
              if (content && content.length > 200) { teamPageContent = content; break; }
            } catch { /* try next path */ }
          }
        })(),
        // LinkedIn + Crunchbase combined (1 SearXNG call instead of 2)
        (async () => {
          const query = `"${companyName}" LinkedIn OR Crunchbase OR funding`;
          const results = await this.searchWeb(query, 10);
          const liUrl = results.find((r) => r.url.includes('linkedin.com/company/'))?.url;
          if (liUrl) linkedinCompanyContent = await this.scrapeUrl(liUrl);
          const cbUrl = results.find((r) => r.url.includes('crunchbase.com') || r.url.includes('techcrunch.com'))?.url;
          if (cbUrl) crunchbaseContent = await this.scrapeUrl(cbUrl);
          else crunchbaseContent = results.filter(r => !r.url.includes('linkedin.com')).slice(0, 3).map((r) => `${r.title}: ${r.snippet}`).join('\n');
        })(),
        // Company news (1 SearXNG call)
        (async () => {
          const query = `${companyName} latest news 2026`;
          const results = await this.searchWeb(query, 5);
          newsContent = results.slice(0, 5).map((r) => `${r.title} (${r.url}): ${r.snippet}`).join('\n');
        })(),
      ]);

      companySourceResults.forEach((result, i) => {
        if (result.status === 'rejected') {
          const sourceNames = ['About', 'Careers', 'Team', 'LinkedIn+Crunchbase', 'News'];
          logger.warn({ err: result.reason, companyId, source: sourceNames[i] }, 'Company source search failed');
        }
      });

      const searchSnippets = companySearchResults.map((r) => `${r.title}: ${r.snippet}`).join('\n');

      const deepCompany = await this.extractJSON<DeepCompanyProfile>([
        { role: 'system', content: companyDeepSystemPrompt(buildMissionContextString(ctx)) },
        {
          role: 'user',
          content: companyDeepUserPrompt({
            companyName,
            domain: companyDomain,
            homepageContent,
            aboutPageContent,
            careersPageContent,
            teamPageContent,
            linkedinCompanyContent,
            crunchbaseContent,
            newsContent,
            glassdoorContent,
            searchResults: searchSnippets,
          }),
        },
      ]);

      // Calculate company data completeness
      const companyFields = [deepCompany.name, deepCompany.domain, deepCompany.industry, deepCompany.size, deepCompany.description, deepCompany.funding, deepCompany.linkedinUrl, deepCompany.foundedYear, deepCompany.headquarters, deepCompany.techStack?.length ? 'yes' : '', deepCompany.keyPeople?.length ? 'yes' : '', deepCompany.recentNews?.length ? 'yes' : '', deepCompany.products?.length ? 'yes' : '', deepCompany.competitors?.length ? 'yes' : ''];
      const companyFilledFields = companyFields.filter(f => f && String(f).length > 0).length;
      const companyDataCompleteness = Math.round((companyFilledFields / companyFields.length) * 100);

      // Save enriched company data (type guard: LLM may return object for name)
      const resolvedName = typeof deepCompany.name === 'object'
        ? (deepCompany.name as any).name || companyName
        : (deepCompany.name || companyName);
      await this.saveOrUpdateCompany({
        name: resolvedName,
        domain: deepCompany.domain || companyDomain || undefined,
        industry: deepCompany.industry || undefined,
        size: deepCompany.size || undefined,
        techStack: deepCompany.techStack?.length ? deepCompany.techStack : undefined,
        funding: deepCompany.funding || undefined,
        description: deepCompany.description || undefined,
        linkedinUrl: deepCompany.linkedinUrl || undefined,
        dataCompleteness: companyDataCompleteness,
        rawData: {
          ...(company.rawData as Record<string, unknown> ?? {}),
          products: deepCompany.products,
          foundedYear: deepCompany.foundedYear,
          headquarters: deepCompany.headquarters,
          cultureValues: deepCompany.cultureValues,
          recentNews: deepCompany.recentNews,
          openPositions: deepCompany.openPositions,
          keyPeople: deepCompany.keyPeople,
          competitors: deepCompany.competitors,
          contactEmail: deepCompany.contactEmail || undefined,
          hiringContactEmails: deepCompany.hiringContactEmails?.length ? deepCompany.hiringContactEmails : undefined,
          glassdoorRating: deepCompany.glassdoorRating || undefined,
          employeeCount: deepCompany.employeeCount || undefined,
          recentFunding: deepCompany.recentFunding || undefined,
          teamPageUrl: deepCompany.teamPageUrl || undefined,
        },
      });

      // Quality gate for company (30% threshold)
      const qualityDecision = companyDataCompleteness >= 30 ? 'enriched' : 'incomplete';
      this.sendMessage(null, 'reasoning', {
        action: 'company_enrichment_completed',
        companyName,
        companyId,
        dataCompleteness: companyDataCompleteness,
        decision: qualityDecision,
      });

      if (companyDataCompleteness < 30) {
        // Log as incomplete discovery detail in agent room
        this.sendMessage(null, 'reasoning', {
          action: 'company_discovered_incomplete',
          companyName,
          companyId,
          dataCompleteness: companyDataCompleteness,
          reason: 'insufficient_enrichment_data',
        });
      }

      // ── Team-to-contacts pipeline: find team → find emails → create contacts → scoring ──
      if (companyDataCompleteness >= 30 && deepCompany.keyPeople?.length) {
        const masterAgentId = input.masterAgentId as string;
        const ctx = this.getPipelineContext(input);

        logger.info({ companyId, companyName, keyPeopleCount: deepCompany.keyPeople.length }, 'Finding emails for team members');

        for (const person of deepCompany.keyPeople.slice(0, 10)) {
          if (!person.name) continue;
          const nameParts = person.name.trim().split(/\s+/);
          const firstName = nameParts[0] ?? '';
          const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
          if (!firstName || !lastName) continue;

          // 1. Search LinkedIn for this person
          let personLinkedinUrl = person.linkedinUrl || '';
          if (!personLinkedinUrl) {
            try {
              const liQuery = `site:linkedin.com/in/ "${person.name}" "${companyName}"`;
              const liResults = await this.searchWeb(liQuery, 3);
              personLinkedinUrl = liResults.find(r => r.url.includes('linkedin.com/in/'))?.url ?? '';
            } catch { /* continue */ }
          }

          // 2. Find email via email intelligence engine (Generect → SearXNG → GitHub → MX guess)
          let personEmail = person.email || '';
          if (!personEmail) {
            const emailDomain = companyDomain || companyName;
            try {
              const emailResult = await emailIntelligenceEngine.findEmail(firstName, lastName, emailDomain, this.tenantId, companyId);
              if (emailResult.email) {
                personEmail = emailResult.email;
                logger.info({ personName: person.name, email: personEmail, confidence: emailResult.confidence, method: emailResult.method }, 'Email found for team member');
              }
            } catch (err) {
              logger.warn({ err, personName: person.name }, 'Email finding failed for team member');
            }
          }

          // 2b. Verify email domain matches company domain
          if (personEmail && companyDomain) {
            const emailDomainPart = personEmail.split('@')[1]?.toLowerCase();
            const normalizedCompanyDomain = companyDomain.replace(/^www\./, '').toLowerCase();
            if (emailDomainPart && emailDomainPart !== normalizedCompanyDomain) {
              logger.warn({ personName: person.name, email: personEmail, companyDomain, emailDomain: emailDomainPart }, 'Email domain mismatch — discarding email');
              personEmail = '';
            }
          }

          // 3. Create contact record
          try {
            const contact = await this.saveOrUpdateContact({
              firstName,
              lastName,
              title: person.title || undefined,
              companyName,
              companyId,
              masterAgentId,
              linkedinUrl: personLinkedinUrl || undefined,
              email: personEmail || undefined,
              source: 'web_search',
              status: personEmail ? 'enriched' : 'discovered',
              rawData: {
                source: 'company_enrichment_team',
                department: person.department || undefined,
              },
            });

            // 4. Dispatch to scoring if we have email, otherwise dispatch to enrichment
            if (personEmail) {
              await this.dispatchNext('scoring', {
                contactId: contact.id,
                masterAgentId,
                pipelineContext: ctx,
                dryRun: input.dryRun,
              });
              logger.info({ companyName, personName: person.name, email: personEmail }, 'Team member dispatched to scoring');
            } else {
              await this.dispatchNext('enrichment', {
                contactId: contact.id,
                masterAgentId,
                pipelineContext: ctx,
                dryRun: input.dryRun,
              });
              logger.info({ companyName, personName: person.name }, 'Team member without email dispatched to enrichment');
            }
          } catch (err) {
            logger.debug({ err, personName: person.name }, 'Failed to create team member contact');
          }
        }
      }

      this.sendMessage('discovery', 'data_handoff', {
        action: 'company_enrichment_result',
        companyId,
        companyName,
        domain: companyDomain,
        dataCompleteness: companyDataCompleteness,
        enriched: companyDataCompleteness >= 30,
      });

      this.logActivity('company_enrichment_completed', 'completed', {
        inputSummary: companyName,
        details: { companyId, dataCompleteness: companyDataCompleteness, domain: companyDomain },
      });
      await this.clearCurrentAction();

      logger.info({ companyId, companyName, dataCompleteness: companyDataCompleteness }, 'EnrichmentAgent company-only completed');

      return {
        companyId,
        companyName,
        dataCompleteness: companyDataCompleteness,
        domain: companyDomain,
        status: qualityDecision,
      };
    } catch (err) {
      logger.warn({ err, companyId, companyName }, 'Company-only enrichment failed');
      this.logActivity('company_enrichment_failed', 'failed', {
        inputSummary: companyName,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.clearCurrentAction();
      throw err;
    }
  }

  // ── LLM-powered smart query generation ──────────────────────────────────

  private async generateSmartQueries(params: {
    companyName: string;
    domain?: string;
    contactName?: string;
    contactTitle?: string;
    industry?: string;
  }): Promise<GeneratedSearchQueries> {
    try {
      const queries = await this.extractJSON<GeneratedSearchQueries>([
        { role: 'system', content: searchKeywordsSystemPrompt() },
        { role: 'user', content: searchKeywordsUserPrompt(params) },
      ]);
      logger.info({
        companyName: params.companyName,
        reasoning: queries.reasoning,
        queryCount: {
          website: queries.companyWebsiteQueries?.length ?? 0,
          linkedin: queries.linkedinCompanyQueries?.length ?? 0,
          contact: queries.contactLinkedinQueries?.length ?? 0,
          github: queries.contactGithubQueries?.length ?? 0,
          social: queries.contactSocialQueries?.length ?? 0,
          domain: queries.domainResolutionQueries?.length ?? 0,
        },
      }, 'Smart query generation succeeded');
      return queries;
    } catch (err) {
      logger.warn({ err, companyName: params.companyName }, 'Smart query generation failed, using fallback templates');
      return this.buildFallbackQueries(params);
    }
  }

  private buildFallbackQueries(params: {
    companyName: string;
    domain?: string;
    contactName?: string;
    contactTitle?: string;
  }): GeneratedSearchQueries {
    const cn = params.companyName;
    const ct = params.contactName ?? '';
    const title = params.contactTitle ?? '';
    return {
      companyWebsiteQueries: [
        `${cn} company official website -site:linkedin.com -site:indeed.com -site:glassdoor.com`,
      ],
      linkedinCompanyQueries: [`site:linkedin.com/company/ "${cn}"`],
      contactLinkedinQueries: ct && cn ? [`"${ct}" "${cn}" site:linkedin.com/in`.trim()] : (ct ? [`"${ct}" "${title}" site:linkedin.com/in`.trim()] : []),
      contactGithubQueries: ct ? [`${ct} github`.trim()] : [],
      contactSocialQueries: ct ? [`site:twitter.com OR site:x.com "${ct}" ${title}`.trim()] : [],
      domainResolutionQueries: [`"${cn}" official website`],
      reasoning: 'Fallback to hardcoded templates',
    };
  }

  // ── Source search methods ────────────────────────────────────────────────

  private async runRecruitmentSourceSearches(
    contactId: string,
    contactName: string,
    contactTitle: string,
    contactCompanyName: string,
    skillsStr: string,
    contact: { linkedinUrl: string | null; skills: unknown; experience: unknown },
    smartQueries: GeneratedSearchQueries,
    setLinkedinContent: (s: string) => void,
    setLinkedinSearchContent: (s: string) => void,
    setGithubContent: (s: string) => void,
    setGithubReposContent: (s: string) => void,
    setTwitterContent: (s: string) => void,
    setStackOverflowContent: (s: string) => void,
    setPersonalSiteContent: (s: string) => void,
    setDevCommunityContent: (s: string) => void,
    setFoundLinkedinUrl: (s: string) => void,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([
      // Source 1: LinkedIn (using smart queries)
      (async () => {
        if (contact.linkedinUrl && !contact.skills && !contact.experience) {
          setLinkedinContent(await this.scrapeUrl(contact.linkedinUrl));
          logger.info({ contactId }, 'LinkedIn re-scraped from existing URL');
        } else if (!contact.linkedinUrl && contactName) {
          const queries = smartQueries.contactLinkedinQueries.length > 0
            ? smartQueries.contactLinkedinQueries
            : [`"${contactName}" "${contactCompanyName}" site:linkedin.com/in`.trim()];
          let found = false;
          for (const query of queries) {
            await sleep(3000);
            const results = await this.searchWeb(query, 5);
            const linkedinUrl = results.find((r) => r.url.includes('linkedin.com/in/'))?.url;
            if (linkedinUrl) {
              setLinkedinSearchContent(await this.scrapeUrl(linkedinUrl));
              setFoundLinkedinUrl(linkedinUrl);
              logger.info({ contactId, linkedinUrl }, 'LinkedIn profile found via smart search');
              found = true;
              break;
            }
          }
          if (!found) {
            // NOTE: do not overwrite an existing linkedinUrl with empty string;
            // setFoundLinkedinUrl is only invoked on hit so contact.linkedinUrl is preserved.
            logger.info({ contactId, contactName }, 'LinkedIn not found via search');
          }
        }
      })(),

      // Source 2: GitHub (using smart queries)
      (async () => {
        if (!contactName) return;
        const queries = smartQueries.contactGithubQueries.length > 0
          ? smartQueries.contactGithubQueries
          : [`${contactName} github ${skillsStr}`.trim()];
        let githubResults: SearchResult[] = [];
        for (const q of queries) {
          githubResults = await this.searchWeb(q, 5);
          if (githubResults.length > 0) break;
        }
        const githubUrl = githubResults.find((r) =>
          r.url.includes('github.com/') &&
          !r.url.includes('github.com/topics') &&
          !r.url.includes('github.com/search') &&
          !r.url.includes('github.com/orgs'),
        )?.url;

        if (githubUrl) {
          setGithubContent(await this.scrapeUrl(githubUrl));
          logger.info({ contactId, githubUrl }, 'GitHub profile scraped');
          try {
            const reposUrl = `${githubUrl.replace(/\/$/, '')}?tab=repositories&sort=stars`;
            setGithubReposContent(await this.scrapeUrl(reposUrl));
            logger.info({ contactId, reposUrl }, 'GitHub repos tab scraped');
          } catch (err) {
            logger.warn({ err, contactId }, 'GitHub repos tab scrape failed');
          }
        }
      })(),

      // Source 3: Twitter/X (using smart queries)
      (async () => {
        if (!contactName) return;
        const queries = smartQueries.contactSocialQueries.length > 0
          ? smartQueries.contactSocialQueries
          : [`site:twitter.com OR site:x.com "${contactName}" ${contactTitle || skillsStr}`.trim()];
        for (const query of queries) {
          const results = await this.searchWeb(query, 5);
          const twitterUrl = results.find((r) =>
            (r.url.includes('twitter.com/') || r.url.includes('x.com/')) &&
            !r.url.includes('/status/') &&
            !r.url.includes('/search'),
          )?.url;
          if (twitterUrl) {
            setTwitterContent(await this.scrapeUrl(twitterUrl));
            logger.info({ contactId, twitterUrl }, 'Twitter/X profile scraped');
            break;
          }
        }
      })(),

      // Source 4: Stack Overflow
      (async () => {
        if (!contactName) return;
        const query = `site:stackoverflow.com/users "${contactName}" ${skillsStr}`.trim();
        const results = await this.searchWeb(query, 5);
        const soUrl = results.find((r) => r.url.includes('stackoverflow.com/users/'))?.url;
        if (soUrl) {
          setStackOverflowContent(await this.scrapeUrl(soUrl));
          logger.info({ contactId, soUrl }, 'Stack Overflow profile scraped');
        }
      })(),

      // Source 5: Blog / Portfolio
      (async () => {
        if (!contactName || !contactTitle) return;
        const portfolioQuery = `${contactName} ${contactTitle} portfolio OR blog OR personal site`;
        const portfolioResults = await this.searchWeb(portfolioQuery, 5);
        const personalUrl = portfolioResults.find((r) =>
          !r.url.includes('linkedin.com') &&
          !r.url.includes('github.com') &&
          !r.url.includes('indeed.com') &&
          !r.url.includes('glassdoor.com') &&
          !r.url.includes('facebook.com') &&
          !r.url.includes('twitter.com') &&
          !r.url.includes('x.com'),
        )?.url;
        if (personalUrl) {
          setPersonalSiteContent(await this.scrapeUrl(personalUrl));
          logger.info({ contactId, personalUrl }, 'Personal site scraped');
        }
      })(),

      // Source 6: Dev Community (Medium / dev.to)
      (async () => {
        if (!contactName) return;
        const query = `site:medium.com OR site:dev.to "${contactName}" ${skillsStr}`.trim();
        const results = await this.searchWeb(query, 5);
        const devUrl = results.find((r) =>
          r.url.includes('medium.com/') || r.url.includes('dev.to/'),
        )?.url;
        if (devUrl) {
          setDevCommunityContent(await this.scrapeUrl(devUrl));
          logger.info({ contactId, devUrl }, 'Dev community profile scraped');
        }
      })(),
    ]);
  }

  private async runSalesSourceSearches(
    contactId: string,
    contactName: string,
    contactTitle: string,
    contactCompanyName: string,
    companyDomain: string | undefined,
    contact: { linkedinUrl: string | null; skills: unknown; experience: unknown },
    smartQueries: GeneratedSearchQueries,
    setLinkedinContent: (s: string) => void,
    setLinkedinSearchContent: (s: string) => void,
    setTwitterContent: (s: string) => void,
    setPersonalSiteContent: (s: string) => void,
    setFoundLinkedinUrl: (s: string) => void,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([
      // Source 1: LinkedIn profile (using smart queries)
      (async () => {
        if (contact.linkedinUrl && !contact.skills && !contact.experience) {
          setLinkedinContent(await this.scrapeUrl(contact.linkedinUrl));
          logger.info({ contactId }, 'LinkedIn re-scraped from existing URL');
        } else if (!contact.linkedinUrl && contactName) {
          const queries = smartQueries.contactLinkedinQueries.length > 0
            ? smartQueries.contactLinkedinQueries
            : [`"${contactName}" "${contactCompanyName}" site:linkedin.com/in`.trim()];
          let found = false;
          for (const query of queries) {
            await sleep(3000);
            const results = await this.searchWeb(query, 5);
            const linkedinUrl = results.find((r) => r.url.includes('linkedin.com/in/'))?.url;
            if (linkedinUrl) {
              setLinkedinSearchContent(await this.scrapeUrl(linkedinUrl));
              setFoundLinkedinUrl(linkedinUrl);
              logger.info({ contactId, linkedinUrl }, 'LinkedIn profile found via smart search (sales)');
              found = true;
              break;
            }
          }
          if (!found) {
            // NOTE: do not overwrite an existing linkedinUrl with empty string;
            // setFoundLinkedinUrl is only invoked on hit so contact.linkedinUrl is preserved.
            logger.info({ contactId, contactName }, 'LinkedIn not found via search');
          }
        }
      })(),

      // Source 2: Company team page (must be on company's own domain)
      (async () => {
        if (!contactCompanyName) return;
        const query = `"${contactCompanyName}" team OR leadership OR about-us`;
        const results = await this.searchWeb(query, 5);
        const teamUrl = results.find((r) => {
          if (!r.url.startsWith('https://')) return false;
          if (isJunkUrl(r.url)) return false;
          try {
            const urlHost = new URL(r.url).hostname.replace(/^www\./, '').toLowerCase();
            // If we know the company domain, URL must be on it
            if (companyDomain && !urlHost.endsWith(companyDomain)) return false;
          } catch { return false; }
          return true;
        })?.url;
        if (teamUrl) {
          const content = await this.scrapeUrl(teamUrl);
          setPersonalSiteContent(content); // reuse personalSiteContent slot for team page data
          logger.info({ contactId, teamUrl }, 'Company team page scraped (sales)');
        }
      })(),

      // Source 3: Company news
      (async () => {
        if (!contactCompanyName) return;
        const query = `"${contactCompanyName}" funding OR partnership OR announcement`;
        const results = await this.searchWeb(query, 5);
        const newsSnippets = results.slice(0, 5).map((r) => `${r.title}: ${r.snippet}`).join('\n');
        if (newsSnippets) {
          logger.info({ contactId, resultsCount: results.length }, 'Company news gathered (sales)');
        }
      })(),
    ]);
  }
}
