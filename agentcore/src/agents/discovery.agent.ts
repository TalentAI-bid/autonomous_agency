import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents } from '../db/schema/index.js';
import { discoveryEngine } from '../tools/discovery-engine.js';
import type { DiscoveryParams } from '../tools/discovery-sources/types.js';
import type { PipelineContext } from '../types/pipeline-context.js';
import logger from '../utils/logger.js';

// ── FAANG / mega-corp blocklist ──────────────────────────────────────────────
const MEGA_CORP_DOMAINS = new Set([
  'google.com', 'meta.com', 'facebook.com', 'apple.com', 'amazon.com',
  'aws.amazon.com', 'netflix.com', 'microsoft.com',
  'oracle.com', 'salesforce.com', 'ibm.com', 'intel.com',
  'cisco.com', 'adobe.com', 'uber.com', 'airbnb.com', 'stripe.com', 'spotify.com',
]);

function isMegaCorp(domain: string): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace('www.', '');
  return MEGA_CORP_DOMAINS.has(d);
}

/** Domains that are platforms/aggregators — not the company itself */
const PLATFORM_DOMAINS = new Set([
  'linkedin.com', 'crunchbase.com', 'glassdoor.com', 'indeed.com',
  'ziprecruiter.com', 'monster.com', 'angel.co', 'lever.co',
  'greenhouse.io', 'workable.com', 'github.com',
]);

function isPlatformDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace('www.', '');
  return PLATFORM_DOMAINS.has(d) || [...PLATFORM_DOMAINS].some(p => d.endsWith(`.${p}`));
}

/** Domains that are content/news sites — the title is an article, not a company */
const CONTENT_SITE_DOMAINS = new Set([
  'investopedia.com', 'hbr.org', 'store.hbr.org', 'forbes.com',
  'medium.com', 'dev.to', 'techcrunch.com', 'wired.com', 'theverge.com',
  'bloomberg.com', 'reuters.com', 'bbc.com', 'nytimes.com', 'wsj.com',
  'wikipedia.org', 'en.wikipedia.org', 'reddit.com', 'quora.com',
  'youtube.com', 'stackoverflow.com', 'ficoforums.myfico.com',
  'amazon.com', 'goodreads.com',
]);

function isContentSite(domain: string): boolean {
  const d = domain.toLowerCase().replace('www.', '');
  return CONTENT_SITE_DOMAINS.has(d) || [...CONTENT_SITE_DOMAINS].some(p => d.endsWith(`.${p}`));
}

export class DiscoveryAgent extends BaseAgent {
  private _ctx: PipelineContext | undefined;

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this._ctx = this.getPipelineContext(input);

    if (input.deepDiscovery) {
      return this.executeDeepDiscovery(input);
    }

    const { searchQueries, maxResults = 10, masterAgentId, dryRun } = input as {
      searchQueries: string[];
      maxResults?: number;
      masterAgentId: string;
      dryRun?: boolean;
    };

    logger.info({ tenantId: this.tenantId, masterAgentId, queryCount: searchQueries.length }, 'DiscoveryAgent starting');
    await this.setCurrentAction('discovery_search', `Searching ${searchQueries.length} queries`);

    // Check for human instructions
    const humanInstruction = await this.checkHumanInstructions();
    if (humanInstruction) {
      logger.info({ masterAgentId, humanInstruction }, 'DiscoveryAgent received human instruction');
    }

    // Get useCase from PipelineContext or fall back to DB
    let useCase: string | undefined = this._ctx?.useCase;
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

    let candidatesFound = 0;
    let companiesFound = 0;
    let teamPagesProcessed = 0;
    let skipped = 0;
    let megaCorpFiltered = 0;
    let enrichmentDispatched = 0;

    for (const query of searchQueries) {
      const results = await this.trackAction('search_executed', query, () => this.searchWeb(query, maxResults as number));

      if (results.length === 0) continue;

      // Direct URL-pattern routing — no LLM classification
      for (const result of results) {
        if (!result.url) continue;
        const url = result.url.toLowerCase();

        try {
          if (url.includes('linkedin.com/in/')) {
            // LinkedIn profile → save contact → dispatch document agent
            await this.handleLinkedInProfile(result, query, masterAgentId, dryRun);
            candidatesFound++;
          } else if (url.includes('linkedin.com/company/')) {
            // LinkedIn company page → save company → dispatch enrichment
            const company = await this.handleCompanyUrl(result, query, useCase);
            if (company) {
              enrichmentDispatched += await this.dispatchCompanyEnrichment(company, masterAgentId);
              companiesFound++;
            }
          } else if (/\/(team|about|leadership|people|our-team|about-us)\b/i.test(result.url)) {
            // Team/about page → scrape for team members
            const companyName = result.title?.split(/[|–—-]/)[0]?.trim() || 'Unknown';
            await this.handleTeamPage(result, companyName, query, masterAgentId, dryRun);
            teamPagesProcessed++;
          } else {
            // Any other URL → extract company from title/domain → dispatch enrichment
            const company = await this.handleCompanyUrl(result, query, useCase);
            if (company) {
              enrichmentDispatched += await this.dispatchCompanyEnrichment(company, masterAgentId);
              companiesFound++;
            } else {
              skipped++;
            }
          }
        } catch (err) {
          logger.warn({ err, url: result.url, query }, 'Failed to process discovery result');
          skipped++;
        }
      }

      // Diagnostic logging
      logger.info({
        query,
        resultCount: results.length,
        processed: { candidates: candidatesFound, companies: companiesFound, teamPages: teamPagesProcessed, skipped },
        sampleUrls: results.slice(0, 3).map(r => r.url),
      }, 'Discovery query processed');
    }

    this.sendMessage(null, 'reasoning', {
      action: 'discovery_completed',
      classified: { candidates: candidatesFound, companies: companiesFound, teamPages: teamPagesProcessed, megaCorpFiltered },
      enrichmentDispatched,
      queryCount: searchQueries.length,
    });

    this.logActivity('discovery_completed', 'completed', {
      details: { candidatesFound, companiesFound, teamPagesProcessed, enrichmentDispatched, megaCorpFiltered, skipped },
    });
    await this.clearCurrentAction();

    logger.info(
      { tenantId: this.tenantId, candidatesFound, companiesFound, teamPagesProcessed, enrichmentDispatched, megaCorpFiltered, skipped },
      'DiscoveryAgent completed',
    );

    return { candidatesFound, companiesFound, teamPagesProcessed, enrichmentDispatched, megaCorpFiltered, skipped };
  }

  private async executeDeepDiscovery(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId, discoveryParams, dryRun } = input as {
      masterAgentId: string;
      discoveryParams: DiscoveryParams;
      dryRun?: boolean;
    };

    logger.info(
      { tenantId: this.tenantId, masterAgentId, params: discoveryParams },
      'DiscoveryAgent starting deep discovery',
    );
    await this.setCurrentAction('deep_discovery', 'Running deep discovery engine');

    const discoveryResult = await this.trackAction('deep_discovery_search', JSON.stringify(discoveryParams).slice(0, 100), () =>
      discoveryEngine.discoverCompanies(discoveryParams, this.tenantId),
    );

    let companiesFound = 0;
    let peopleFound = 0;
    const companyNameToId = new Map<string, string>();

    for (const company of discoveryResult.companies) {
      try {
        // Skip mega-corps in sales mode
        if (this._ctx?.useCase === 'sales' && company.domain && isMegaCorp(company.domain)) continue;

        const savedCompany = await this.saveOrUpdateCompany({
          name: company.name,
          domain: company.domain,
          linkedinUrl: company.linkedinUrl,
          industry: company.industry || undefined,
          size: company.size || undefined,
          techStack: company.techStack?.length ? company.techStack : undefined,
          funding: company.funding || undefined,
          description: company.description || undefined,
          rawData: {
            discoveryEngine: true,
            foundedYear: company.foundedYear,
            headquarters: company.headquarters,
            sources: company.sources,
            confidence: company.confidence,
            dataCompleteness: company.dataCompleteness,
          },
        });
        companyNameToId.set(company.name.toLowerCase(), savedCompany.id);
        companiesFound++;
      } catch (err) {
        logger.warn({ err, company: company.name }, 'Failed to save discovered company');
      }
    }

    for (const person of discoveryResult.people) {
      try {
        const firstName = person.firstName ?? person.fullName?.split(/\s+/)[0];
        const lastName = person.lastName ?? person.fullName?.split(/\s+/).slice(1).join(' ');

        const companyId = person.companyName
          ? companyNameToId.get(person.companyName.toLowerCase())
          : undefined;

        const contact = await this.saveOrUpdateContact({
          firstName,
          lastName,
          title: person.title,
          companyName: person.companyName,
          companyId: companyId || undefined,
          linkedinUrl: person.linkedinUrl,
          source: 'web_search',
          status: 'discovered',
          rawData: {
            discoveryEngine: true,
            sources: person.sources,
            confidence: person.confidence,
            email: person.email,
            githubUrl: person.githubUrl,
            twitterUrl: person.twitterUrl,
            location: person.location,
            skills: person.skills,
          },
        });

        if (person.confidence >= 60) {
          await this.dispatchNext('enrichment', {
            contactId: contact.id,
            masterAgentId,
            pipelineContext: this._ctx,
            dryRun: dryRun || undefined,
          });
        }
        peopleFound++;
      } catch (err) {
        logger.warn({ err, person: person.fullName }, 'Failed to save discovered person');
      }
    }

    this.logActivity('deep_discovery_completed', 'completed', {
      details: { companiesFound, peopleFound, metadata: discoveryResult.metadata },
    });
    await this.clearCurrentAction();

    logger.info(
      {
        tenantId: this.tenantId,
        companiesFound,
        peopleFound,
        metadata: discoveryResult.metadata,
      },
      'Deep discovery completed',
    );

    return { companiesFound, peopleFound, metadata: discoveryResult.metadata };
  }

  // ── Domain resolution ──────────────────────────────────────────────────────

  private async resolveCompanyDomain(companyName: string): Promise<string | undefined> {
    const cacheKey = `domain-resolve:${companyName.toLowerCase()}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached === 'NOT_FOUND' ? undefined : cached;
    } catch { /* continue */ }

    try {
      const results = await this.searchWeb(`"${companyName}" official website`, 5);
      for (const r of results) {
        try {
          const hostname = new URL(r.url).hostname.replace('www.', '');
          if (!hostname.includes('linkedin.com') && !hostname.includes('glassdoor.com') &&
              !hostname.includes('indeed.com') && !hostname.includes('crunchbase.com') &&
              !hostname.includes('wikipedia.org') && !hostname.includes('twitter.com') &&
              !hostname.includes('facebook.com')) {
            await this.redis.setex(cacheKey, 14 * 86400, hostname);
            return hostname;
          }
        } catch { /* skip bad URL */ }
      }

      // Fallback: LinkedIn company page
      const liResults = await this.searchWeb(`"${companyName}" site:linkedin.com/company`, 3);
      const liUrl = liResults.find(r => r.url.includes('linkedin.com/company/'))?.url;
      if (liUrl) {
        try {
          const pageContent = await this.scrapeUrl(liUrl);
          const websiteMatch = pageContent.match(/(?:Website|External link|Company website)[\s:]*(?:<[^>]+>)*(https?:\/\/[^\s<"]+)/i);
          if (websiteMatch?.[1]) {
            const domain = new URL(websiteMatch[1]).hostname.replace('www.', '');
            await this.redis.setex(cacheKey, 14 * 86400, domain);
            return domain;
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      logger.debug({ err, companyName }, 'Domain resolution failed');
    }

    await this.redis.setex(cacheKey, 86400, 'NOT_FOUND').catch(() => {}); // 1 day
    return undefined;
  }

  // ── Handler methods ────────────────────────────────────────────────────────

  /**
   * Handle a LinkedIn profile URL — extract name/title/company from title,
   * save contact, dispatch to document agent for scraping.
   */
  private async handleLinkedInProfile(
    result: { url: string; title: string; snippet: string },
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    // Parse LinkedIn title format: "John Smith - CTO at TechCo | LinkedIn"
    const titleText = (result.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();

    let firstName: string | undefined;
    let lastName: string | undefined;
    let title: string | undefined;
    let companyName: string | undefined;

    // Pattern: "Name - Title at Company"
    const match = titleText.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s+at\s+|\s+@\s+)(.+)$/i);
    if (match) {
      const nameParts = match[1]!.trim().split(/\s+/);
      firstName = nameParts[0] || undefined;
      lastName = nameParts.slice(1).join(' ') || undefined;
      title = match[2]!.trim() || undefined;
      companyName = match[3]!.trim() || undefined;
    } else {
      // Fallback: just extract name from before first separator
      const nameParts = titleText.split(/[-–—|]/)[0]?.trim().split(/\s+/) ?? [];
      firstName = nameParts[0] || undefined;
      lastName = nameParts.slice(1).join(' ') || undefined;
    }

    // Save company if extracted
    let companyId: string | undefined;
    if (companyName) {
      try {
        const company = await this.saveOrUpdateCompany({
          name: companyName,
          rawData: { discoveredVia: 'linkedin_profile', discoveryQuery: query },
        });
        companyId = company.id;
      } catch (err) {
        logger.debug({ err, companyName }, 'Failed to create company for LinkedIn profile');
      }
    }

    const contact = await this.saveOrUpdateContact({
      linkedinUrl: result.url,
      firstName,
      lastName,
      title,
      companyName,
      companyId,
      source: 'linkedin_search',
      status: 'discovered',
      rawData: {
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        query,
      },
    });

    // LinkedIn profiles go through document agent for full scrape first
    await this.dispatchNext('document', {
      url: result.url,
      type: 'linkedin_profile',
      contactId: contact.id,
      masterAgentId,
      pipelineContext: this._ctx,
      dryRun,
    });

    await this.emitEvent('contact:discovered', {
      contactId: contact.id,
      source: 'linkedin_search',
      url: result.url,
    });
  }

  /**
   * Handle any URL as a potential company source — extract company name
   * from title, resolve domain, save company.
   */
  private async handleCompanyUrl(
    result: { url: string; title: string; snippet: string },
    query: string,
    useCase?: string,
  ): Promise<{ companyId: string; companyName: string; domain?: string } | null> {
    // Extract company name from title — take first segment before separator
    let companyName = result.title?.split(/[|–—]/)[0]?.trim();
    // If first segment contains " - " (with spaces), split again — avoids grabbing article titles
    if (companyName && companyName.includes(' - ')) {
      companyName = companyName.split(' - ')[0]?.trim();
    }
    if (!companyName || companyName.length < 2) return null;

    // Validate company name
    try {
      // Use the base-agent's validation via saveOrUpdateCompany — it will throw if invalid
      // But first check basic patterns to avoid unnecessary work
      if (companyName.length > 80 || companyName.split(/\s+/).length > 8) return null;
      if (/^(how|what|why|when|where|which|can|does|should|is)\s/i.test(companyName)) return null;
      if (/\?\s*$/.test(companyName)) return null;
    } catch { return null; }

    // Extract domain from URL
    let domain: string | undefined;
    try {
      const urlDomain = new URL(result.url).hostname.replace('www.', '');
      if (isPlatformDomain(urlDomain)) {
        // Platform URL (LinkedIn, Crunchbase, etc.) — resolve real company domain
        domain = await this.resolveCompanyDomain(companyName);
      } else if (isContentSite(urlDomain)) {
        // Content/news site — title is an article, not a company
        return null;
      } else {
        domain = urlDomain;
      }
    } catch { /* ignore */ }

    // Skip mega-corps in sales mode
    if (useCase === 'sales' && domain && isMegaCorp(domain)) return null;

    try {
      const company = await this.saveOrUpdateCompany({
        name: companyName,
        domain,
        linkedinUrl: result.url.includes('linkedin.com/company/') ? result.url : undefined,
        rawData: {
          ...(domain ? {} : { domainStatus: 'unresolved' }),
          discoveryUrl: result.url,
          discoveryTitle: result.title,
          discoverySnippet: result.snippet,
          discoveryQuery: query,
        },
      });

      if (!domain) {
        await this.emitEvent('company:domain_unresolved', { companyId: company.id, companyName });
      }

      await this.emitEvent('company:discovered', {
        companyId: company.id,
        name: companyName,
        domain,
        url: result.url,
      });

      return { companyId: company.id, companyName, domain };
    } catch (err) {
      logger.debug({ err, companyName, url: result.url }, 'Failed to save company from URL');
      return null;
    }
  }

  /**
   * Handle a team/about page — scrape for team members and dispatch enrichment.
   */
  private async handleTeamPage(
    result: { url: string; title: string; snippet: string },
    companyName: string,
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    // Save the company
    let domain: string | undefined;
    try {
      domain = new URL(result.url).hostname.replace('www.', '');
    } catch { /* ignore */ }

    const savedCompany = await this.saveOrUpdateCompany({
      name: companyName,
      domain,
      rawData: {
        teamPageUrl: result.url,
        discoveryQuery: query,
      },
    });

    // Scrape the team page to extract people
    let pageContent = '';
    try {
      pageContent = await this.scrapeUrl(result.url);
    } catch (err) {
      logger.warn({ err, url: result.url }, 'Failed to scrape team page');
      return;
    }

    if (!pageContent || pageContent.length < 100) return;

    // Use LLM to extract people from the team page
    interface TeamMember { name: string; title: string; }
    let members: TeamMember[] = [];
    try {
      const extraction = await this.extractJSON<{ members: TeamMember[] }>([
        {
          role: 'system',
          content: `You are an expert at extracting team member information from company pages. Extract all people listed on the page with their name and title. Focus on leadership and decision-maker roles (C-suite, VP, Director, Head of, Manager). Return valid JSON.`,
        },
        {
          role: 'user',
          content: `Extract team members from this page content. Return JSON: { "members": [{ "name": "Full Name", "title": "Job Title" }] }\n\nPAGE CONTENT:\n${pageContent.slice(0, 5000)}`,
        },
      ]);
      members = extraction.members ?? [];
    } catch (err) {
      logger.warn({ err, url: result.url }, 'Failed to extract team members from page');
      return;
    }

    // Create contacts for each extracted member and dispatch enrichment
    for (const member of members.slice(0, 10)) {
      if (!member.name) continue;

      const nameParts = member.name.trim().split(/\s+/);
      const firstName = nameParts[0] || undefined;
      const lastName = nameParts.slice(1).join(' ') || undefined;

      const contact = await this.saveOrUpdateContact({
        firstName,
        lastName,
        title: member.title || undefined,
        companyName,
        companyId: savedCompany.id,
        source: 'web_search',
        status: 'discovered',
        rawData: {
          url: result.url,
          teamPageSource: true,
          query,
        },
      });

      await this.dispatchNext('enrichment', {
        contactId: contact.id,
        masterAgentId,
        pipelineContext: this._ctx,
        dryRun,
      });
    }

    await this.emitEvent('team_page:processed', {
      companyName,
      url: result.url,
      membersExtracted: members.length,
    });

    logger.info({ url: result.url, companyName, membersExtracted: members.length }, 'Team page processed');
  }

  // ── Immediate company enrichment dispatch ───────────────────────────────────

  private async dispatchCompanyEnrichment(
    entry: { companyId: string; companyName: string; domain?: string },
    masterAgentId: string,
  ): Promise<number> {
    try {
      await this.dispatchNext('enrichment', {
        companyId: entry.companyId,
        masterAgentId,
        pipelineContext: this._ctx,
      });

      this.sendMessage('enrichment', 'data_handoff', {
        action: 'company_enrichment_dispatch',
        companyId: entry.companyId,
        companyName: entry.companyName,
        domain: entry.domain,
      });

      return 1;
    } catch (err) {
      logger.warn({ err, companyId: entry.companyId, companyName: entry.companyName }, 'Failed to dispatch company enrichment');
      return 0;
    }
  }
}
