import { eq, and, ilike } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents } from '../db/schema/index.js';
import { emailIntelligenceEngine } from '../tools/email-intelligence.js';
import { findEmailByPattern } from '../tools/email-finder.tool.js';

import { SMART_MODEL } from '../tools/together-ai.tool.js';
import { isMegaCorp, shouldSkipDomain } from '../utils/domain-blocklist.js';
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

/** Quick DNS check — returns false if the domain doesn't resolve (avoids circuit-breaker spam). */
async function domainResolves(url: string): Promise<boolean> {
  try {
    const hostname = new URL(url).hostname;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`https://${hostname}`, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

/** Pull discovery-source signals out of an existing company.rawData so they survive enrichment overwrites. */
function extractPreservedDiscoveryData(rawData: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!rawData) return {};
  const preservedKeys = [
    'discoveryQuery', 'discoveryUrl', 'hiringSignal', 'hiringVerified',
    'job_title', 'job_url', 'job_source', 'extractedFrom', 'entityType',
    'discoverySource', 'originalLocation',
  ];
  const out: Record<string, unknown> = {};
  for (const k of preservedKeys) {
    if (rawData[k] !== undefined) out[k] = rawData[k];
  }
  return out;
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

// Priority titles for email verification — tech/engineering roles are most valuable
const PRIORITY_TITLES = ['cto', 'vp engineering', 'head of engineering', 'director of engineering', 'vp technology', 'head of technology', 'technical director', 'chief technology', 'engineering manager', 'head of product', 'dsi', 'directeur technique', 'responsable technique', 'directeur informatique'];
const SKIP_TITLES = ['ceo', 'coo', 'cfo', 'chief executive', 'chief operating', 'chief financial', 'président', 'directeur général', 'pdg'];

/** Validate LLM-returned domain — reject industry descriptions, garbage strings */
function isValidDomain(domain: string | undefined | null): string | undefined {
  if (!domain) return undefined;
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (!trimmed.includes('.')) return undefined;
  if (trimmed.includes(' ')) return undefined;
  if (trimmed.length > 253) return undefined;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(trimmed)) return undefined;
  return trimmed.replace(/^www\./, '');
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

    // NOTE: SearXNG budget guard removed — discovery now goes through smart-crawler
    // (Google/Brave/DDG) with its own in-process rate limiter. SearXNG is only a
    // last-resort fallback inside specific lookups.

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
    // Skip invalid company names early (avoids wasting LLM calls)
    if (!contactCompanyName || contactCompanyName === '...' || contactCompanyName === '…' || /^\.{2,}$/.test(contactCompanyName)) {
      logger.warn({ contactId, contactCompanyName }, 'Skipping enrichment: invalid company name');
      await this.clearCurrentAction();
      return { contactId, status: 'skipped', reason: 'invalid_company_name' };
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

    // ── Phase 1: Multi-source data collection (scrape existing URLs only) ──

    let githubContent = '';
    let githubReposContent = '';
    let personalSiteContent = '';
    let linkedinContent = '';
    let twitterContent = '';

    // Quick company domain lookup
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

    // Scrape existing URLs only — no SERP searches
    const sourceResults = useCase === 'sales'
      ? await this.runSalesSourceSearches(contactId, knownCompanyDomain, contact, (c) => { linkedinContent = c; }, (c) => { personalSiteContent = c; })
      : await this.runRecruitmentSourceSearches(contactId, contact as any, (c) => { linkedinContent = c; }, (c) => { githubContent = c; }, (c) => { githubReposContent = c; }, (c) => { twitterContent = c; });

    sourceResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        logger.warn({ err: result.reason, contactId, source: i }, 'Source scrape failed');
      }
    });

    // ── Phase 2: Deep company enrichment ───────────────────────────────────

    let companyId = contact.companyId;
    let companyEnriched = false;

    if (contactCompanyName) {
      try {
        // Domain from company-finder — no SERP needed
        const companyDomain = knownCompanyDomain;
        let companyUrl = companyDomain ? `https://${companyDomain}` : undefined;

        // Validate domain resolves before scraping (avoids circuit-breaker spam)
        if (companyUrl && !(await domainResolves(companyUrl))) {
          logger.info({ contactId, contactCompanyName, companyUrl }, 'Skipping website scrape — domain does not resolve');
          companyUrl = undefined;
        }

        let homepageContent = '';
        let aboutPageContent = '';
        let careersPageContent = '';
        let teamPageContent = '';
        let linkedinCompanyContent = '';
        let linkedinCompanyUrl = '';

        if (companyUrl) {
          homepageContent = await this.scrapeUrl(companyUrl);
        }

        // Gate sub-page scrapes on homepage health
        const homepageOk = !!homepageContent && homepageContent.length > 200;
        if (companyUrl && !homepageOk) {
          logger.warn(
            { contactId, companyUrl, len: homepageContent?.length ?? 0 },
            'Enrichment: homepage unreachable/empty — skipping additional company-page scrapes',
          );
        }

        logger.info({ contactId, companyUrl, pipelineStep: 'scrape_company_website' }, 'Enrichment: scraping company website (contact path)');

        const companySourceResults = await Promise.allSettled([
          // Always attempt /about and /careers even if homepage was thin
          (async () => {
            if (!companyUrl) return;
            aboutPageContent = await this.scrapeUrl(new URL('/about', companyUrl).href);
          })(),
          (async () => {
            if (!companyUrl) return;
            careersPageContent = await this.scrapeUrl(new URL('/careers', companyUrl).href);
          })(),
          // Team page — try multiple paths (expensive, only when homepage looks healthy)
          (async () => {
            if (!companyUrl || !homepageOk) return;
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
        ]);

        companySourceResults.forEach((result, i) => {
          if (result.status === 'rejected') {
            const sourceNames = ['About', 'Careers', 'Team'];
            logger.warn({ err: result.reason, contactId, source: sourceNames[i] }, 'Company source scrape failed');
          }
        });

        // Extract LinkedIn URLs from ALL scraped company content
        const allCompanyContent = [homepageContent, aboutPageContent, careersPageContent, teamPageContent];
        const companyLiMatch = allCompanyContent.filter(Boolean).join('\n')
          .match(/https?:\/\/(www\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+/);
        if (companyLiMatch) {
          linkedinCompanyUrl = companyLiMatch[0];
          try {
            linkedinCompanyContent = await this.scrapeUrl(linkedinCompanyUrl);
            logger.info({ contactId, linkedinCompanyUrl }, 'LinkedIn company page found from scraped content');
          } catch { /* non-critical */ }
        }

        // Extract people LinkedIn URLs from scraped content
        const personLiRegex = /https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/g;
        const extractedPeopleLinkedinUrls: string[] = [];
        const combinedCompanyContent = allCompanyContent.filter(Boolean).join('\n');
        let pliMatch: RegExpExecArray | null;
        while ((pliMatch = personLiRegex.exec(combinedCompanyContent)) !== null) {
          const normalized = pliMatch[0].replace(/^http:/, 'https:');
          if (!extractedPeopleLinkedinUrls.includes(normalized)) extractedPeopleLinkedinUrls.push(normalized);
        }

        // Check if we have enough content for LLM deep analysis
        const totalScrapedLen = [homepageContent, aboutPageContent, careersPageContent, teamPageContent]
          .reduce((sum, s) => sum + (s?.length ?? 0), 0);

        if (totalScrapedLen < 200) {
          logger.warn({ contactId, contactCompanyName, totalScrapedLen }, 'Skipping LLM deep analysis — insufficient scraped content');
          let noContentPreservedData: Record<string, unknown> = {};
          if (contact.companyId) {
            try {
              const [existingCo] = await withTenant(this.tenantId, async (tx) => {
                return tx.select({ rawData: companies.rawData }).from(companies)
                  .where(eq(companies.id, contact.companyId!)).limit(1);
              });
              noContentPreservedData = extractPreservedDiscoveryData(existingCo?.rawData as Record<string, unknown> | null);
            } catch { /* non-critical */ }
          }
          const minimalCompany = await this.saveOrUpdateCompany({
            id: contact.companyId ?? undefined,
            name: contactCompanyName,
            domain: companyDomain || undefined,
            dataCompleteness: 10,
            rawData: { ...noContentPreservedData, enrichmentSkipped: 'no_content' },
          });
          companyId = minimalCompany.id;
          companyEnriched = true;
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(contacts).set({ companyId: minimalCompany.id, updatedAt: new Date() })
              .where(eq(contacts.id, contactId));
          });
        } else {

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
              crunchbaseContent: '',
              newsContent: '',
              glassdoorContent: '',
              searchResults: '',
            }),
          },
        ], 2, { model: SMART_MODEL });

        // Cap key people to prevent LLM over-generation
        if (deepCompany.keyPeople) deepCompany.keyPeople = deepCompany.keyPeople.slice(0, 5);

        // Validate: only keep key people whose names appear in actual scraped content
        if (deepCompany.keyPeople?.length) {
          const allScrapedText = [homepageContent, aboutPageContent, careersPageContent, teamPageContent]
            .filter(Boolean).join(' ').toLowerCase();
          deepCompany.keyPeople = deepCompany.keyPeople.filter(person => {
            const name = (person.name || '').trim();
            if (!name || name.length < 3) return false;
            if (!allScrapedText.includes(name.toLowerCase())) {
              logger.warn({ name, title: person.title }, 'Key person name NOT found in scraped content — removing hallucination');
              return false;
            }
            return true;
          });
        }

        // Match regex-extracted LinkedIn URLs to key people by name slug
        if (deepCompany.keyPeople?.length && extractedPeopleLinkedinUrls.length > 0) {
          const matchedUrls = new Set<string>();
          for (const person of deepCompany.keyPeople) {
            if (!person.name) continue;
            const nameSlug = person.name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            const match = extractedPeopleLinkedinUrls.find(url => {
              const slug = url.split('/in/')[1]?.split('/')[0]?.split('?')[0]?.toLowerCase() ?? '';
              return slug.includes(nameSlug) || nameSlug.includes(slug);
            });
            if (match) {
              (person as any).linkedinUrl = match;
              matchedUrls.add(match);
            }
          }
          (deepCompany as any)._unmatchedLinkedinUrls = extractedPeopleLinkedinUrls.filter(u => !matchedUrls.has(u));
        }

        // Calculate company data completeness
        const companyFields = [deepCompany.name, deepCompany.domain, deepCompany.industry, deepCompany.size, deepCompany.description, deepCompany.funding, deepCompany.linkedinUrl, deepCompany.foundedYear, deepCompany.headquarters, deepCompany.techStack?.length ? 'yes' : '', deepCompany.keyPeople?.length ? 'yes' : '', deepCompany.recentNews?.length ? 'yes' : '', deepCompany.products?.length ? 'yes' : '', deepCompany.competitors?.length ? 'yes' : ''];
        const companyFilledFields = companyFields.filter(f => f && String(f).length > 0).length;
        const companyDataCompleteness = Math.round((companyFilledFields / companyFields.length) * 100);

        // Save company with deep data (type guard: LLM may return object for name)
        const resolvedCompanyName = typeof deepCompany.name === 'object'
          ? (deepCompany.name as any).name || contactCompanyName
          : (deepCompany.name || contactCompanyName);

        // Fix A: preserve discovery signals from the existing row pinned by contact.companyId.
        // Without this, fuzzy name-matching may create a NEW company row and the original
        // discovery rawData (hiringSignal, job_url, ...) is orphaned on the old row.
        let preservedDiscoveryData: Record<string, unknown> = {};
        if (contact.companyId) {
          try {
            const [existingCompany] = await withTenant(this.tenantId, async (tx) => {
              return tx.select({ rawData: companies.rawData }).from(companies)
                .where(eq(companies.id, contact.companyId!))
                .limit(1);
            });
            preservedDiscoveryData = extractPreservedDiscoveryData(
              existingCompany?.rawData as Record<string, unknown> | null,
            );
          } catch (err) {
            logger.debug({ err, contactId, companyId: contact.companyId }, 'Failed to fetch existing company for discovery preservation');
          }
        }

        // Use homepage-extracted LinkedIn URL or LLM-returned one (simple regex validation)
        const resolvedLinkedinUrl = linkedinCompanyUrl
          || (deepCompany.linkedinUrl?.includes('linkedin.com/company/') ? deepCompany.linkedinUrl : undefined);

        const company = await this.saveOrUpdateCompany({
          id: contact.companyId ?? undefined,
          name: resolvedCompanyName,
          domain: isValidDomain(deepCompany.domain) || companyDomain || undefined,
          industry: deepCompany.industry || undefined,
          size: deepCompany.size || undefined,
          techStack: deepCompany.techStack?.length ? deepCompany.techStack : undefined,
          funding: deepCompany.funding || undefined,
          description: deepCompany.description || undefined,
          linkedinUrl: resolvedLinkedinUrl,
          dataCompleteness: companyDataCompleteness,
          rawData: {
            ...preservedDiscoveryData,
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
            painPoints: deepCompany.painPoints?.length ? deepCompany.painPoints : undefined,
            techGapScore: deepCompany.techGapScore ?? undefined,
            outreachAngle: deepCompany.outreachAngle || undefined,
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
          const keyPeopleToResearch = (deepCompany.keyPeople || [])
            .filter(p => !SKIP_TITLES.some(s => (p.title || '').toLowerCase().includes(s)))
            .sort((a, b) => {
              const aP = PRIORITY_TITLES.some(t => (a.title || '').toLowerCase().includes(t)) ? 0 : 1;
              const bP = PRIORITY_TITLES.some(t => (b.title || '').toLowerCase().includes(t)) ? 0 : 1;
              return aP - bP;
            })
            .slice(0, 3);
          const keyPeopleResults = await Promise.allSettled(
            keyPeopleToResearch.map(async (person) => {
              if (!person.name) return person;

              // LinkedIn URL only from regex match (set by slug-matching above, never from LLM)
              let personLinkedinUrl: string | undefined = (person as any).linkedinUrl || undefined;
              if (personLinkedinUrl) {
                const allContent = [homepageContent, aboutPageContent, careersPageContent, teamPageContent, linkedinCompanyContent].filter(Boolean).join('\n');
                if (!allContent.includes(personLinkedinUrl)) {
                  logger.warn({ person: person.name, fakeUrl: personLinkedinUrl }, 'LinkedIn URL not in scraped content — removing');
                  personLinkedinUrl = undefined;
                }
              }
              let personEmail = '';
              let emailMethod: string | undefined;
              let emailAttempts: number | undefined;

              // Find email for this person
              if (companyDomain) {
                try {
                  const nameParts = person.name.trim().split(/\s+/);
                  const firstName = nameParts[0] ?? '';
                  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1]! : '';
                  if (firstName && lastName) {
                    // PRIMARY: Pattern guesser + Reacher SMTP verification
                    const patternResult = await findEmailByPattern(firstName, lastName, companyDomain);
                    if (patternResult.email) {
                      personEmail = patternResult.email;
                      emailMethod = patternResult.method;
                      emailAttempts = patternResult.attempts;
                      logger.info({
                        contactId, personName: person.name, personEmail,
                        method: patternResult.method, attempts: patternResult.attempts,
                        cached: patternResult.method === 'cached_pattern',
                      }, 'Key person email found');
                    }
                    // FALLBACK: Old Generect/emailIntelligence method
                    if (!personEmail) {
                      const emailResult = await emailIntelligenceEngine.findEmail(firstName, lastName, companyDomain, this.tenantId, companyId ?? undefined);
                      if (emailResult.email) {
                        personEmail = emailResult.email;
                        emailMethod = 'generect_fallback';
                        logger.info({ contactId, personName: person.name, personEmail }, 'Key person email found via Generect fallback');
                      }
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

                // Name-based dedup: skip if contact with same name already exists for this company
                if (firstName && lastName) {
                  const existingByName = await withTenant(this.tenantId, async (tx) => {
                    return tx.select({ id: contacts.id }).from(contacts)
                      .where(and(
                        eq(contacts.tenantId, this.tenantId),
                        ilike(contacts.firstName, firstName),
                        ilike(contacts.lastName, lastName),
                        eq(contacts.companyId, company.id)
                      ))
                      .limit(1);
                  });
                  if (existingByName.length > 0) {
                    logger.debug({ person: person.name }, 'Contact already exists — skipping');
                    return { ...person, linkedinUrl: personLinkedinUrl || '', email: personEmail };
                  }
                }

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
                    ...(emailMethod ? { emailMethod } : {}),
                    ...(emailAttempts !== undefined ? { emailAttempts } : {}),
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

              return { ...person, linkedinUrl: personLinkedinUrl || '', email: personEmail };
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

        // Create standalone contacts for unmatched LinkedIn URLs found in scraped HTML
        const unmatchedUrls = (deepCompany as any)._unmatchedLinkedinUrls as string[] | undefined;
        if (unmatchedUrls?.length) {
          for (const url of unmatchedUrls.slice(0, 5)) {
            try {
              const slug = url.split('/in/')[1]?.split('/')[0] ?? '';
              const parts = slug.split('-').filter(Boolean);
              if (parts.length >= 2) {
                const firstName = parts[0]!;
                const lastName = parts.slice(1).join(' ');
                await this.saveOrUpdateContact({
                  firstName, lastName,
                  companyName: contactCompanyName,
                  companyId: company.id,
                  masterAgentId,
                  linkedinUrl: url,
                  source: 'web_search',
                  status: 'discovered',
                  rawData: { source: 'linkedin_regex_unmatched', parentContactId: contactId },
                });
              }
            } catch { /* non-fatal */ }
          }
        }
        } // end else (deep analysis with sufficient content)
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

        // Domain must come from company-finder — no SERP fallback
        if (!domain) {
          // Use knownCompanyDomain from earlier lookup as last resort
          domain = knownCompanyDomain || '';
        }

        if (domain) {
          // PRIMARY: Pattern guesser + Reacher SMTP verification
          const patternResult = await findEmailByPattern(contact.firstName!, contact.lastName!, domain);
          if (patternResult.email) {
            emailFound = patternResult.email;
            emailVerified = patternResult.method === 'smtp_verified';
            raw.emailMethod = patternResult.method;
            raw.emailAttempts = patternResult.attempts;
            logger.info({ contactId, email: emailFound, method: patternResult.method, attempts: patternResult.attempts }, 'Email found via pattern + Reacher');
          }
          // FALLBACK: Old Generect/emailIntelligence method
          if (!emailFound) {
            const result = await emailIntelligenceEngine.findEmail(contact.firstName!, contact.lastName!, domain, this.tenantId, companyId ?? undefined);
            if (result.email && result.confidence >= 50) {
              emailFound = result.email;
              emailVerified = result.confidence >= 80;
              raw.emailMethod = 'generect_fallback';
            }
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
            githubContent: githubContent || undefined,
            githubReposContent: githubReposContent || undefined,
            personalSiteContent: personalSiteContent || undefined,
            twitterContent: twitterContent || undefined,
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
      linkedinUrl: contact.linkedinUrl ?? undefined,
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

    // NOTE: SearXNG budget guard removed — see contact-path note. Smart-crawler
    // enforces its own per-domain delay and hourly cap.

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
        companyName === '...' || companyName === '…' || /^\.{2,}$/.test(companyName) ||
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

    // Domain from company-finder — no SERP needed
    const companyDomain = company.domain ?? undefined;
    let companyUrl = companyDomain ? `https://${companyDomain}` : undefined;

    // Validate domain resolves before scraping (avoids circuit-breaker spam)
    if (companyUrl && !(await domainResolves(companyUrl))) {
      logger.info({ companyId, companyName, companyUrl }, 'Skipping website scrape — domain does not resolve');
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(companies)
          .set({ domain: null, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
      });
      companyUrl = undefined;
    }

    try {
      let homepageContent = '';
      let aboutPageContent = '';
      let careersPageContent = '';
      let teamPageContent = '';
      let linkedinCompanyContent = '';
      let linkedinCompanyUrl = '';
      let crunchbaseContent = '';
      let newsContent = '';
      let glassdoorContent = '';

      // Load WTTJ content from rawData (saved by company-finder during discovery)
      const companyRawData = (company.rawData as Record<string, unknown>) ?? {};
      const wttjContent = (companyRawData.wttjContent as string) || '';
      const wttjTeamContent = (companyRawData.wttjTeamContent as string) || '';
      const wttjTechContent = (companyRawData.wttjTechContent as string) || '';

      if (companyUrl) {
        homepageContent = await this.scrapeUrl(companyUrl);
      }

      // Gate the company-website sources on homepage health (see contact-path location for rationale).
      const homepageOk = !!homepageContent && homepageContent.length > 200;
      if (companyUrl && !homepageOk) {
        logger.warn(
          { companyId, companyUrl, len: homepageContent?.length ?? 0 },
          'Enrichment: homepage unreachable/empty — skipping additional company-page scrapes',
        );
      }

      logger.info({ companyId, companyUrl, pipelineStep: 'scrape_company_website' }, 'Enrichment: scraping company website');

      const companySourceResults = await Promise.allSettled([
        // Always attempt /about and /careers even if homepage was thin — these paths
        // often work when root redirects or returns minimal HTML
        (async () => { if (!companyUrl) return; aboutPageContent = await this.scrapeUrl(new URL('/about', companyUrl).href); })(),
        (async () => { if (!companyUrl) return; careersPageContent = await this.scrapeUrl(new URL('/careers', companyUrl).href); })(),
        // Team page — try multiple paths (expensive, so only when homepage looks healthy)
        (async () => {
          if (!companyUrl || !homepageOk) return;
          for (const path of ['/team', '/about', '/about-us', '/leadership', '/our-team', '/people', '/management', '/company/team']) {
            try {
              const url = new URL(path, companyUrl).href;
              const content = await this.scrapeUrl(url);
              if (content && content.length > 200) { teamPageContent = content; break; }
            } catch { /* try next path */ }
          }
        })(),
      ]);

      companySourceResults.forEach((result, i) => {
        if (result.status === 'rejected') {
          const sourceNames = ['About', 'Careers', 'Team'];
          logger.warn({ err: result.reason, companyId, source: sourceNames[i] }, 'Company source scrape failed');
        }
      });

      // Use WTTJ team content as fallback if real team page scraping returned nothing
      if (!teamPageContent && wttjTeamContent) {
        teamPageContent = wttjTeamContent;
        logger.info({ companyId }, 'Using WTTJ team content as team page fallback');
      }

      // Extract LinkedIn URLs from ALL scraped company content
      const allCompanyContent = [homepageContent, aboutPageContent, careersPageContent, teamPageContent];
      const companyLiMatch = allCompanyContent.filter(Boolean).join('\n')
        .match(/https?:\/\/(www\.)?linkedin\.com\/company\/[a-zA-Z0-9_-]+/);
      if (companyLiMatch) {
        linkedinCompanyUrl = companyLiMatch[0];
        try {
          linkedinCompanyContent = await this.scrapeUrl(linkedinCompanyUrl);
          logger.info({ companyId, linkedinCompanyUrl }, 'LinkedIn company page found from scraped content');
        } catch { /* non-critical */ }
      }

      // Extract people LinkedIn URLs for Voyager enrichment
      const personLiRegex = /https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/g;
      const extractedPeopleLinkedinUrls: string[] = [];
      const combinedCompanyContent = allCompanyContent.filter(Boolean).join('\n');
      let pliMatch: RegExpExecArray | null;
      while ((pliMatch = personLiRegex.exec(combinedCompanyContent)) !== null) {
        const normalized = pliMatch[0].replace(/^http:/, 'https:');
        if (!extractedPeopleLinkedinUrls.includes(normalized)) extractedPeopleLinkedinUrls.push(normalized);
      }

      // Check if we have enough content for LLM deep analysis
      const totalScrapedLen = [homepageContent, aboutPageContent, careersPageContent, teamPageContent, wttjContent, wttjTechContent]
        .reduce((sum, s) => sum + (s?.length ?? 0), 0);

      if (totalScrapedLen < 200) {
        logger.warn({ companyId, companyName, totalScrapedLen }, 'Skipping LLM deep analysis — insufficient scraped content');
        await this.saveOrUpdateCompany({
          id: companyId,
          name: companyName,
          domain: companyDomain || undefined,
          dataCompleteness: 10,
          rawData: { ...(company.rawData as Record<string, unknown> ?? {}), enrichmentSkipped: 'no_content' },
        });
        await this.clearCurrentAction();
        return { companyId, companyName, status: 'skipped', reason: 'no_scraped_content', dataCompleteness: 10 };
      }

      const deepCompany = await this.extractJSON<DeepCompanyProfile>([
        { role: 'system', content: companyDeepSystemPrompt(buildMissionContextString(ctx)) },
        {
          role: 'user',
          content: companyDeepUserPrompt({
            companyName,
            domain: companyDomain,
            homepageContent: homepageContent || wttjContent,
            aboutPageContent,
            careersPageContent,
            teamPageContent,
            linkedinCompanyContent,
            crunchbaseContent: '',
            newsContent: '',
            glassdoorContent: '',
            searchResults: wttjTechContent ? `WTTJ TECH PAGE:\n${wttjTechContent}` : '',
          }),
        },
      ], 2, { model: SMART_MODEL });

      // Cap key people to prevent LLM over-generation
      if (deepCompany.keyPeople) deepCompany.keyPeople = deepCompany.keyPeople.slice(0, 5);

      // Validate: only keep key people whose names appear in actual scraped content
      if (deepCompany.keyPeople?.length) {
        const allScrapedText = [homepageContent, aboutPageContent, careersPageContent, teamPageContent, wttjContent, wttjTeamContent, wttjTechContent]
          .filter(Boolean).join(' ').toLowerCase();
        deepCompany.keyPeople = deepCompany.keyPeople.filter(person => {
          const name = (person.name || '').trim();
          if (!name || name.length < 3) return false;
          if (!allScrapedText.includes(name.toLowerCase())) {
            logger.warn({ name, title: person.title }, 'Key person name NOT found in scraped content — removing hallucination');
            return false;
          }
          return true;
        });
      }

      // Match regex-extracted LinkedIn URLs to key people by name slug
      if (deepCompany.keyPeople?.length && extractedPeopleLinkedinUrls.length > 0) {
        const matchedUrls = new Set<string>();
        for (const person of deepCompany.keyPeople) {
          if (!person.name) continue;
          const nameSlug = person.name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          const match = extractedPeopleLinkedinUrls.find(url => {
            const slug = url.split('/in/')[1]?.split('/')[0]?.split('?')[0]?.toLowerCase() ?? '';
            return slug.includes(nameSlug) || nameSlug.includes(slug);
          });
          if (match) {
            (person as any).linkedinUrl = match;
            matchedUrls.add(match);
          }
        }
        (deepCompany as any)._unmatchedLinkedinUrls = extractedPeopleLinkedinUrls.filter(u => !matchedUrls.has(u));
      }

      // Calculate company data completeness
      const companyFields = [deepCompany.name, deepCompany.domain, deepCompany.industry, deepCompany.size, deepCompany.description, deepCompany.funding, deepCompany.linkedinUrl, deepCompany.foundedYear, deepCompany.headquarters, deepCompany.techStack?.length ? 'yes' : '', deepCompany.keyPeople?.length ? 'yes' : '', deepCompany.recentNews?.length ? 'yes' : '', deepCompany.products?.length ? 'yes' : '', deepCompany.competitors?.length ? 'yes' : ''];
      const companyFilledFields = companyFields.filter(f => f && String(f).length > 0).length;
      const companyDataCompleteness = Math.round((companyFilledFields / companyFields.length) * 100);

      // Save enriched company data (type guard: LLM may return object for name)
      const resolvedName = typeof deepCompany.name === 'object'
        ? (deepCompany.name as any).name || companyName
        : (deepCompany.name || companyName);

      // Fix A: pin the row by id so fuzzy name-match cannot create a new row and orphan
      // discovery signals (hiringSignal, job_url, ...). The full prior rawData is also
      // spread here for explicit clarity.
      const preservedDiscoveryDataCO = extractPreservedDiscoveryData(
        company.rawData as Record<string, unknown> | null,
      );

      // Use homepage-extracted LinkedIn URL or LLM-returned one (simple regex validation)
      const resolvedLinkedinUrl = linkedinCompanyUrl
        || (deepCompany.linkedinUrl?.includes('linkedin.com/company/') ? deepCompany.linkedinUrl : undefined);

      await this.saveOrUpdateCompany({
        id: companyId,
        name: resolvedName,
        domain: isValidDomain(deepCompany.domain) || companyDomain || undefined,
        industry: deepCompany.industry || undefined,
        size: deepCompany.size || undefined,
        techStack: deepCompany.techStack?.length ? deepCompany.techStack : undefined,
        funding: deepCompany.funding || undefined,
        description: deepCompany.description || undefined,
        linkedinUrl: resolvedLinkedinUrl,
        dataCompleteness: companyDataCompleteness,
        rawData: {
          ...preservedDiscoveryDataCO,
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
          painPoints: deepCompany.painPoints?.length ? deepCompany.painPoints : undefined,
          techGapScore: deepCompany.techGapScore ?? undefined,
          outreachAngle: deepCompany.outreachAngle || undefined,
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

        const priorityPeople = (deepCompany.keyPeople || [])
          .filter(p => !SKIP_TITLES.some(s => (p.title || '').toLowerCase().includes(s)))
          .sort((a, b) => {
            const aP = PRIORITY_TITLES.some(t => (a.title || '').toLowerCase().includes(t)) ? 0 : 1;
            const bP = PRIORITY_TITLES.some(t => (b.title || '').toLowerCase().includes(t)) ? 0 : 1;
            return aP - bP;
          })
          .slice(0, 3);

        logger.info({ companyId, companyName, keyPeopleCount: priorityPeople.length }, 'Finding emails for team members');

        for (const person of priorityPeople) {
          if (!person.name) continue;
          const nameParts = person.name.trim().split(/\s+/);
          const firstName = nameParts[0] ?? '';
          const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
          if (!firstName || !lastName) continue;

          // Name-based dedup: skip if contact with same name already exists for this company
          const existingByName = await withTenant(this.tenantId, async (tx) => {
            return tx.select({ id: contacts.id }).from(contacts)
              .where(and(
                eq(contacts.tenantId, this.tenantId),
                ilike(contacts.firstName, firstName),
                ilike(contacts.lastName, lastName),
                eq(contacts.companyId, companyId)
              ))
              .limit(1);
          });
          if (existingByName.length > 0) {
            logger.debug({ person: person.name }, 'Team member already exists — skipping');
            continue;
          }

          // LinkedIn URL only from regex match (set by slug-matching above, never from LLM)
          let personLinkedinUrl: string | undefined = (person as any).linkedinUrl || undefined;
          if (personLinkedinUrl) {
            const allContent = [homepageContent, aboutPageContent, careersPageContent, teamPageContent, linkedinCompanyContent].filter(Boolean).join('\n');
            if (!allContent.includes(personLinkedinUrl)) {
              logger.warn({ person: person.name, fakeUrl: personLinkedinUrl }, 'LinkedIn URL not in scraped content — removing');
              personLinkedinUrl = undefined;
            }
          }

          // 2. Find email via pattern guesser + Reacher, then Generect fallback
          let personEmail = '';
          let emailMethod: string | undefined;
          let emailAttempts: number | undefined;
          {
            const emailDomain = companyDomain || companyName;
            try {
              // PRIMARY: Pattern guesser + Reacher SMTP verification
              if (emailDomain.includes('.') && !emailDomain.includes(' ')) {
                const patternResult = await findEmailByPattern(firstName, lastName, emailDomain);
                if (patternResult.email) {
                  personEmail = patternResult.email;
                  emailMethod = patternResult.method;
                  emailAttempts = patternResult.attempts;
                  logger.info({
                    personName: person.name, email: personEmail,
                    method: patternResult.method, attempts: patternResult.attempts,
                    cached: patternResult.method === 'cached_pattern',
                  }, 'Email found for team member');
                }
              }
              // FALLBACK: Old Generect/emailIntelligence method
              if (!personEmail) {
                const emailResult = await emailIntelligenceEngine.findEmail(firstName, lastName, emailDomain, this.tenantId, companyId);
                if (emailResult.email) {
                  personEmail = emailResult.email;
                  emailMethod = emailResult.method || 'generect_fallback';
                  logger.info({ personName: person.name, email: personEmail, confidence: emailResult.confidence, method: emailResult.method }, 'Email found for team member via Generect fallback');
                }
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
                ...(emailMethod ? { emailMethod } : {}),
                ...(emailAttempts !== undefined ? { emailAttempts } : {}),
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

        // Create standalone contacts for unmatched LinkedIn URLs found in scraped HTML
        const unmatchedUrls = (deepCompany as any)._unmatchedLinkedinUrls as string[] | undefined;
        if (unmatchedUrls?.length) {
          for (const url of unmatchedUrls.slice(0, 5)) {
            try {
              const slug = url.split('/in/')[1]?.split('/')[0] ?? '';
              const parts = slug.split('-').filter(Boolean);
              if (parts.length >= 2) {
                const firstName = parts[0]!;
                const lastName = parts.slice(1).join(' ');
                await this.saveOrUpdateContact({
                  firstName, lastName,
                  companyName,
                  companyId,
                  masterAgentId,
                  linkedinUrl: url,
                  source: 'web_search',
                  status: 'discovered',
                  rawData: { source: 'linkedin_regex_unmatched' },
                });
              }
            } catch { /* non-fatal */ }
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


  // ── Source search methods (scrape existing URLs only — no SERP) ─────────

  private async runRecruitmentSourceSearches(
    contactId: string,
    contact: { linkedinUrl: string | null; rawData: Record<string, unknown> | null },
    setLinkedinContent: (s: string) => void,
    setGithubContent: (s: string) => void,
    setGithubReposContent: (s: string) => void,
    setTwitterContent: (s: string) => void,
  ): Promise<PromiseSettledResult<void>[]> {
    const raw = (contact.rawData ?? {}) as Record<string, unknown>;
    return Promise.allSettled([
      // LinkedIn: scrape if URL already known (from candidate-finder or linkedin-agent)
      (async () => {
        if (contact.linkedinUrl) {
          setLinkedinContent(await this.scrapeUrl(contact.linkedinUrl));
          logger.info({ contactId }, 'LinkedIn scraped from existing URL');
        }
      })(),

      // GitHub: scrape if URL in rawData
      (async () => {
        const githubUrl = raw.githubUrl as string | undefined;
        if (githubUrl) {
          setGithubContent(await this.scrapeUrl(githubUrl));
          logger.info({ contactId, githubUrl }, 'GitHub profile scraped from existing URL');
          try {
            const reposUrl = `${githubUrl.replace(/\/$/, '')}?tab=repositories&sort=stars`;
            setGithubReposContent(await this.scrapeUrl(reposUrl));
          } catch {}
        }
      })(),

      // Twitter: scrape if URL in rawData
      (async () => {
        const twitterUrl = raw.twitterUrl as string | undefined;
        if (twitterUrl) {
          setTwitterContent(await this.scrapeUrl(twitterUrl));
          logger.info({ contactId, twitterUrl }, 'Twitter scraped from existing URL');
        }
      })(),
    ]);
  }

  private async runSalesSourceSearches(
    contactId: string,
    companyDomain: string | undefined,
    contact: { linkedinUrl: string | null },
    setLinkedinContent: (s: string) => void,
    setPersonalSiteContent: (s: string) => void,
  ): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled([
      // LinkedIn: scrape if URL already known
      (async () => {
        if (contact.linkedinUrl) {
          setLinkedinContent(await this.scrapeUrl(contact.linkedinUrl));
          logger.info({ contactId }, 'LinkedIn scraped from existing URL (sales)');
        }
      })(),

      // Team page: scrape directly from company domain
      (async () => {
        if (!companyDomain) return;
        for (const path of ['/team', '/about-us', '/leadership', '/our-team', '/people']) {
          try {
            const url = `https://${companyDomain}${path}`;
            const content = await this.scrapeUrl(url);
            if (content && content.length > 200) {
              setPersonalSiteContent(content);
              logger.info({ contactId, url }, 'Company team page scraped (sales)');
              break;
            }
          } catch { /* try next path */ }
        }
      })(),
    ]);
  }
}
