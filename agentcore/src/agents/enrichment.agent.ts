import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents } from '../db/schema/index.js';
import { findEmail } from '../tools/email-finder.tool.js';
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
import logger from '../utils/logger.js';

export class EnrichmentAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, masterAgentId, dryRun } = input as { contactId: string; masterAgentId: string; dryRun?: boolean };

    logger.info({ tenantId: this.tenantId, contactId }, 'EnrichmentAgent starting');

    // 1. Load contact
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    const contactName = [contact.firstName, contact.lastName].filter(Boolean).join(' ');
    const contactTitle = contact.title ?? '';
    const contactCompanyName = contact.companyName ?? '';
    const raw = (contact.rawData as Record<string, unknown>) ?? {};

    // Load useCase from master agent
    let useCase: string | undefined;
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

    // ── Phase 1: Multi-source data collection (6 parallel sources) ─────────

    let githubContent = '';
    let githubReposContent = '';
    let personalSiteContent = '';
    let linkedinContent = '';
    let linkedinSearchContent = '';
    let twitterContent = '';
    let stackOverflowContent = '';
    let devCommunityContent = '';

    const skills = (contact.skills as string[]) ?? [];
    const skillsStr = skills.slice(0, 3).join(' ');

    // Branch sources by use case
    const sourceResults = useCase === 'sales'
      ? await this.runSalesSourceSearches(contactId, contactName, contactTitle, contactCompanyName, contact, (content) => { linkedinContent = content; }, (content) => { linkedinSearchContent = content; }, (content) => { twitterContent = content; }, (content) => { personalSiteContent = content; })
      : await this.runRecruitmentSourceSearches(contactId, contactName, contactTitle, contactCompanyName, skillsStr, contact, (content) => { linkedinContent = content; }, (content) => { linkedinSearchContent = content; }, (content) => { githubContent = content; }, (content) => { githubReposContent = content; }, (content) => { twitterContent = content; }, (content) => { stackOverflowContent = content; }, (content) => { personalSiteContent = content; }, (content) => { devCommunityContent = content; });

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
        // Search for company website (exclude job boards and social)
        const companySearchResults = await this.searchWeb(
          `${contactCompanyName} company official website -site:linkedin.com -site:indeed.com -site:glassdoor.com`,
        );
        const companyUrl = companySearchResults.find((r) => r.url.startsWith('https://'))?.url;

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
            const teamPaths = ['/team', '/about/team', '/people', '/about-us/team', '/leadership'];
            for (const path of teamPaths) {
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

          // Source 3: LinkedIn company page
          (async () => {
            const query = `site:linkedin.com/company/ "${contactCompanyName}"`;
            const results = await this.searchWeb(query, 5);
            const liUrl = results.find((r) => r.url.includes('linkedin.com/company/'))?.url;
            if (liUrl) {
              linkedinCompanyContent = await this.scrapeUrl(liUrl);
              logger.info({ contactId, liUrl }, 'LinkedIn company page scraped');
            }
          })(),

          // Source 4: Crunchbase / Funding
          (async () => {
            const query = `${contactCompanyName} crunchbase OR funding OR series`;
            const results = await this.searchWeb(query, 5);
            const cbUrl = results.find((r) =>
              r.url.includes('crunchbase.com') || r.url.includes('techcrunch.com'),
            )?.url;
            if (cbUrl) {
              crunchbaseContent = await this.scrapeUrl(cbUrl);
              logger.info({ contactId, cbUrl }, 'Crunchbase/funding content scraped');
            } else {
              // Use search snippets as fallback
              crunchbaseContent = results.slice(0, 3).map((r) => `${r.title}: ${r.snippet}`).join('\n');
            }
          })(),

          // Source 5: Company news
          (async () => {
            const query = `${contactCompanyName} latest news 2026`;
            const results = await this.searchWeb(query, 5);
            // Use snippets from top news results
            newsContent = results.slice(0, 5).map((r) => `${r.title} (${r.url}): ${r.snippet}`).join('\n');
            logger.info({ contactId, resultsCount: results.length }, 'Company news gathered');
          })(),

          // Source 6: Glassdoor
          (async () => {
            const query = `site:glassdoor.com "${contactCompanyName}" reviews`;
            const results = await this.searchWeb(query, 5);
            const gdUrl = results.find((r) => r.url.includes('glassdoor.com'))?.url;
            if (gdUrl) {
              glassdoorContent = await this.scrapeUrl(gdUrl);
              logger.info({ contactId, gdUrl }, 'Glassdoor content scraped');
            }
          })(),
        ]);

        // Log company source failures
        companySourceResults.forEach((result, i) => {
          if (result.status === 'rejected') {
            const sourceNames = ['About', 'Careers', 'Team', 'LinkedIn', 'Crunchbase', 'News', 'Glassdoor'];
            logger.warn({ err: result.reason, contactId, source: sourceNames[i] }, 'Company source search failed');
          }
        });

        const searchSnippets = companySearchResults.map((r) => `${r.title}: ${r.snippet}`).join('\n');

        // Deep company enrichment via LLM
        const deepCompany = await this.extractJSON<DeepCompanyProfile>([
          { role: 'system', content: companyDeepSystemPrompt() },
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

        // Save company with deep data
        const company = await this.saveOrUpdateCompany({
          name: deepCompany.name || contactCompanyName,
          domain: deepCompany.domain || companyDomain || undefined,
          industry: deepCompany.industry || undefined,
          size: deepCompany.size || undefined,
          techStack: deepCompany.techStack?.length ? deepCompany.techStack : undefined,
          funding: deepCompany.funding || undefined,
          description: deepCompany.description || undefined,
          linkedinUrl: deepCompany.linkedinUrl || undefined,
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
          const keyPeopleToResearch = deepCompany.keyPeople.slice(0, 5);
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
                    const emailResult = await findEmail(this.tenantId, firstName, lastName, companyDomain);
                    if (emailResult) {
                      personEmail = emailResult.email;
                      logger.info({ contactId, personName: person.name, personEmail }, 'Key person email found');
                    }
                  }
                } catch (err) {
                  logger.warn({ err, contactId, personName: person.name }, 'Key person email search failed');
                }
              }

              // Create a contact record for the key person (status: 'discovered')
              try {
                const nameParts = person.name.trim().split(/\s+/);
                const firstName = nameParts[0] ?? '';
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
                await this.saveOrUpdateContact({
                  firstName,
                  lastName,
                  title: person.title || undefined,
                  companyName: contactCompanyName,
                  companyId: company.id,
                  linkedinUrl: personLinkedinUrl || undefined,
                  email: personEmail || undefined,
                  rawData: {
                    source: 'key_person_enrichment',
                    department: person.department || undefined,
                    parentContactId: contactId,
                  },
                });
                logger.info({ contactId, personName: person.name }, 'Key person contact created');
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
          const result = await findEmail(
            this.tenantId,
            contact.firstName!,
            contact.lastName!,
            domain,
          );
          if (result) {
            emailFound = result.email;
            emailVerified = result.verified;
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

    // ── Phase 5: Quality gate ──────────────────────────────────────────────

    const dataCompleteness = profile?.dataCompleteness ?? 0;

    if (dataCompleteness < 30) {
      // Insufficient data — archive and skip scoring
      updateData.status = 'archived';
      updateData.rawData = {
        ...(updateData.rawData as Record<string, unknown> ?? raw),
        skipReason: 'insufficient_data',
        dataCompleteness,
      };

      await withTenant(this.tenantId, async (tx) => {
        await tx.update(contacts).set(updateData).where(eq(contacts.id, contactId));
      });

      await this.emitEvent('contact:archived', {
        contactId,
        reason: 'insufficient_data',
        dataCompleteness,
      });

      logger.info({ contactId, dataCompleteness }, 'EnrichmentAgent: contact archived (insufficient data)');

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

    await this.dispatchNext('scoring', { contactId, masterAgentId, dryRun });

    await this.emitEvent('contact:enriched', {
      contactId,
      email: emailFound,
      emailVerified,
      companyEnriched,
      companyId,
      dataCompleteness,
    });

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

  // ── Source search methods ────────────────────────────────────────────────

  private async runRecruitmentSourceSearches(
    contactId: string,
    contactName: string,
    contactTitle: string,
    contactCompanyName: string,
    skillsStr: string,
    contact: { linkedinUrl: string | null; skills: unknown; experience: unknown },
    setLinkedinContent: (s: string) => void,
    setLinkedinSearchContent: (s: string) => void,
    setGithubContent: (s: string) => void,
    setGithubReposContent: (s: string) => void,
    setTwitterContent: (s: string) => void,
    setStackOverflowContent: (s: string) => void,
    setPersonalSiteContent: (s: string) => void,
    setDevCommunityContent: (s: string) => void,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([
      // Source 1: LinkedIn
      (async () => {
        if (contact.linkedinUrl && !contact.skills && !contact.experience) {
          setLinkedinContent(await this.scrapeUrl(contact.linkedinUrl));
          logger.info({ contactId }, 'LinkedIn re-scraped from existing URL');
        } else if (!contact.linkedinUrl && contactName) {
          const query = `site:linkedin.com/in/ "${contactName}" "${contactTitle}"`.trim();
          const results = await this.searchWeb(query, 5);
          const linkedinUrl = results.find((r) => r.url.includes('linkedin.com/in/'))?.url;
          if (linkedinUrl) {
            setLinkedinSearchContent(await this.scrapeUrl(linkedinUrl));
            logger.info({ contactId, linkedinUrl }, 'LinkedIn profile found via search');
          }
        }
      })(),

      // Source 2: GitHub
      (async () => {
        if (!contactName) return;
        const githubQuery = `${contactName} github ${skillsStr}`.trim();
        const githubResults = await this.searchWeb(githubQuery, 5);
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

      // Source 3: Twitter/X
      (async () => {
        if (!contactName) return;
        const query = `site:twitter.com OR site:x.com "${contactName}" ${contactTitle || skillsStr}`.trim();
        const results = await this.searchWeb(query, 5);
        const twitterUrl = results.find((r) =>
          (r.url.includes('twitter.com/') || r.url.includes('x.com/')) &&
          !r.url.includes('/status/') &&
          !r.url.includes('/search'),
        )?.url;
        if (twitterUrl) {
          setTwitterContent(await this.scrapeUrl(twitterUrl));
          logger.info({ contactId, twitterUrl }, 'Twitter/X profile scraped');
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
    contact: { linkedinUrl: string | null; skills: unknown; experience: unknown },
    setLinkedinContent: (s: string) => void,
    setLinkedinSearchContent: (s: string) => void,
    setTwitterContent: (s: string) => void,
    setPersonalSiteContent: (s: string) => void,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([
      // Source 1: LinkedIn profile
      (async () => {
        if (contact.linkedinUrl && !contact.skills && !contact.experience) {
          setLinkedinContent(await this.scrapeUrl(contact.linkedinUrl));
          logger.info({ contactId }, 'LinkedIn re-scraped from existing URL');
        } else if (!contact.linkedinUrl && contactName) {
          const query = `site:linkedin.com/in/ "${contactName}" "${contactTitle}"`.trim();
          const results = await this.searchWeb(query, 5);
          const linkedinUrl = results.find((r) => r.url.includes('linkedin.com/in/'))?.url;
          if (linkedinUrl) {
            setLinkedinSearchContent(await this.scrapeUrl(linkedinUrl));
            logger.info({ contactId, linkedinUrl }, 'LinkedIn profile found via search');
          }
        }
      })(),

      // Source 2: Company team page
      (async () => {
        if (!contactCompanyName) return;
        const query = `"${contactCompanyName}" team OR leadership OR about-us`;
        const results = await this.searchWeb(query, 5);
        const teamUrl = results.find((r) =>
          !r.url.includes('linkedin.com') &&
          !r.url.includes('glassdoor.com') &&
          r.url.startsWith('https://'),
        )?.url;
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
        // Store snippets as searchable content
        const newsSnippets = results.slice(0, 5).map((r) => `${r.title}: ${r.snippet}`).join('\n');
        if (newsSnippets) {
          logger.info({ contactId, resultsCount: results.length }, 'Company news gathered (sales)');
        }
      })(),

      // Source 4: Industry publications
      (async () => {
        if (!contactName || !contactCompanyName) return;
        const query = `"${contactName}" "${contactCompanyName}" interview OR conference OR speaking`;
        const results = await this.searchWeb(query, 5);
        if (results.length > 0) {
          logger.info({ contactId, resultsCount: results.length }, 'Industry publications found (sales)');
        }
      })(),

      // Source 5: Twitter/X
      (async () => {
        if (!contactName) return;
        const query = `site:twitter.com OR site:x.com "${contactName}" ${contactTitle}`.trim();
        const results = await this.searchWeb(query, 5);
        const twitterUrl = results.find((r) =>
          (r.url.includes('twitter.com/') || r.url.includes('x.com/')) &&
          !r.url.includes('/status/') &&
          !r.url.includes('/search'),
        )?.url;
        if (twitterUrl) {
          setTwitterContent(await this.scrapeUrl(twitterUrl));
          logger.info({ contactId, twitterUrl }, 'Twitter/X profile scraped (sales)');
        }
      })(),

      // Source 6: Company LinkedIn page
      (async () => {
        if (!contactCompanyName) return;
        const query = `site:linkedin.com/company/ "${contactCompanyName}"`;
        const results = await this.searchWeb(query, 5);
        const liUrl = results.find((r) => r.url.includes('linkedin.com/company/'))?.url;
        if (liUrl) {
          logger.info({ contactId, liUrl }, 'LinkedIn company page found (sales)');
        }
      })(),
    ]);
  }
}
