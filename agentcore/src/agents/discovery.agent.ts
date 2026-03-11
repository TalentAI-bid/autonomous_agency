import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, opportunities } from '../db/schema/index.js';
import {
  buildSystemPrompt as classificationSystemPrompt,
  buildUserPrompt as classificationUserPrompt,
  type ClassifiedResult,
} from '../prompts/classification.prompt.js';
import { discoveryEngine } from '../tools/discovery-engine.js';
import type { DiscoveryParams } from '../tools/discovery-sources/types.js';
import type { PipelineContext } from '../types/pipeline-context.js';
import logger from '../utils/logger.js';

// ── FAANG / mega-corp blocklist (Problem 4) ──────────────────────────────────
const MEGA_CORP_DOMAINS = new Set([
  'google.com', 'meta.com', 'facebook.com', 'apple.com', 'amazon.com',
  'aws.amazon.com', 'netflix.com', 'microsoft.com', 'github.com',
  'linkedin.com', 'oracle.com', 'salesforce.com', 'ibm.com', 'intel.com',
  'cisco.com', 'adobe.com', 'uber.com', 'airbnb.com', 'stripe.com', 'spotify.com',
]);

function isMegaCorp(domain: string): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace('www.', '');
  return MEGA_CORP_DOMAINS.has(d);
}

export class DiscoveryAgent extends BaseAgent {
  private _ctx: PipelineContext | undefined;

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    this._ctx = this.getPipelineContext(input);

    if (input.deepDiscovery) {
      return this.executeDeepDiscovery(input);
    }

    const { searchQueries, maxResults = 10, masterAgentId, dryRun, opportunityFocused } = input as {
      searchQueries: string[];
      maxResults?: number;
      masterAgentId: string;
      dryRun?: boolean;
      opportunityFocused?: boolean;
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
    let jobListingsProcessed = 0;
    let decisionMakersFound = 0;
    let teamPagesProcessed = 0;
    let directoryPagesProcessed = 0;
    let irrelevantFiltered = 0;
    let skipped = 0;
    let megaCorpFiltered = 0;
    let opportunitiesCreated = 0;
    let enrichmentDispatched = 0;

    // Pool of discovered company IDs to batch-dispatch to enrichment
    const companyPool: { companyId: string; companyName: string; domain?: string }[] = [];

    // Build ICP exclusion context for classification
    const icpExclusion = this.buildICPExclusion();

    for (const query of searchQueries) {
      const results = await this.trackAction('search_executed', query, () => this.searchWeb(query, maxResults as number));

      if (results.length === 0) continue;

      // Batch-classify all results from this query via LLM
      const indexed = results.map((r, i) => ({
        index: i,
        url: r.url,
        title: r.title ?? '',
        snippet: r.snippet ?? '',
      }));

      let classified: ClassifiedResult[];
      try {
        classified = await this.extractJSON<ClassifiedResult[]>([
          { role: 'system', content: classificationSystemPrompt(useCase, this._ctx?.sales, icpExclusion) },
          { role: 'user', content: classificationUserPrompt(indexed, useCase) },
        ]);
      } catch (err) {
        logger.warn({ err, query }, 'Classification failed, skipping query batch');
        skipped += results.length;
        continue;
      }

      for (const item of classified) {
        const result = results[item.index];
        if (!result?.url) { skipped++; continue; }

        // Skip low-confidence classifications
        if (typeof item.confidence === 'number' && item.confidence < 0.4) {
          irrelevantFiltered++;
          continue;
        }

        // FAANG filter for sales mode (Problem 4)
        if (useCase === 'sales' && item.extractedCompany) {
          let extractedDomain: string | undefined;
          try { extractedDomain = new URL(result.url).hostname.replace('www.', ''); } catch { /* ignore */ }
          if (extractedDomain && isMegaCorp(extractedDomain)) {
            megaCorpFiltered++;
            continue;
          }
        }

        if (item.classification === 'candidate_profile' || item.classification === 'decision_maker') {
          await this.handleCandidate(result, item, query, masterAgentId, dryRun);
          if (item.classification === 'decision_maker') {
            decisionMakersFound++;
          } else {
            candidatesFound++;
          }
        } else if (item.classification === 'company_page') {
          const companyResult = await this.handleCompany(result, item, query, useCase);
          if (companyResult) companyPool.push(companyResult);
          companiesFound++;
        } else if (item.classification === 'team_page') {
          await this.handleTeamPage(result, item, query, masterAgentId, dryRun);
          teamPagesProcessed++;
        } else if (item.classification === 'content_with_companies') {
          const contentCompanies = await this.handleContentWithCompanies(result, item, query, useCase, masterAgentId);
          companyPool.push(...contentCompanies);
          companiesFound += (item.extractedCompanies?.length ?? 0);
        } else if (item.classification === 'directory_page') {
          const dirCompanies = await this.handleDirectoryPage(result, item, query, useCase);
          companyPool.push(...dirCompanies);
          directoryPagesProcessed++;
        } else if (item.classification === 'job_listing') {
          const { opportunityCreated, company: jobCompany } = await this.handleJobListing(result, item, query, useCase, masterAgentId, opportunityFocused);
          if (opportunityCreated) opportunitiesCreated++;
          if (jobCompany) companyPool.push(jobCompany);
          jobListingsProcessed++;
        } else {
          irrelevantFiltered++;
        }
      }

      // Flush company pool when it reaches 10
      if (companyPool.length >= 10) {
        enrichmentDispatched += await this.flushCompanyPool(companyPool, masterAgentId);
      }
    }

    // Final flush of remaining companies in pool
    if (companyPool.length > 0) {
      enrichmentDispatched += await this.flushCompanyPool(companyPool, masterAgentId);
    }

    // Log incomplete companies (no domain) as agent room discovery details
    // Companies with dataCompleteness 0 are already filtered from company lists by routes

    this.sendMessage(null, 'reasoning', {
      action: 'discovery_completed',
      classified: { candidates: candidatesFound, decisionMakers: decisionMakersFound, companies: companiesFound, teamPages: teamPagesProcessed, directoryPages: directoryPagesProcessed, jobListings: jobListingsProcessed, irrelevant: irrelevantFiltered, megaCorpFiltered },
      enrichmentDispatched,
      queryCount: searchQueries.length,
    });

    this.logActivity('discovery_completed', 'completed', {
      details: { candidatesFound, decisionMakersFound, companiesFound, teamPagesProcessed, directoryPagesProcessed, jobListingsProcessed, opportunitiesCreated, enrichmentDispatched, irrelevantFiltered, megaCorpFiltered, skipped },
    });
    await this.clearCurrentAction();

    logger.info(
      { tenantId: this.tenantId, candidatesFound, decisionMakersFound, companiesFound, teamPagesProcessed, directoryPagesProcessed, jobListingsProcessed, opportunitiesCreated, enrichmentDispatched, irrelevantFiltered, megaCorpFiltered, skipped },
      'DiscoveryAgent completed',
    );

    return { candidatesFound, decisionMakersFound, companiesFound, teamPagesProcessed, directoryPagesProcessed, jobListingsProcessed, opportunitiesCreated, enrichmentDispatched, irrelevantFiltered, megaCorpFiltered, skipped };
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

  // ── Domain resolution (Problem 5) ──────────────────────────────────────────

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
            await this.redis.setex(cacheKey, 30 * 86400, hostname);
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
            await this.redis.setex(cacheKey, 30 * 86400, domain);
            return domain;
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      logger.debug({ err, companyName }, 'Domain resolution failed');
    }

    await this.redis.setex(cacheKey, 7 * 86400, 'NOT_FOUND').catch(() => {});
    return undefined;
  }

  // ── Handler methods ────────────────────────────────────────────────────────

  private async handleCandidate(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    const isLinkedIn = result.url.includes('linkedin.com/in/');

    // Parse name from LLM extraction
    const nameParts = (item.extractedName ?? '').split(/\s+/);
    const firstName = nameParts[0] || undefined;
    const lastName = nameParts.slice(1).join(' ') || undefined;

    // Create company record if company name was extracted
    let companyId: string | undefined;
    if (item.extractedCompany) {
      try {
        const company = await this.saveOrUpdateCompany({
          name: item.extractedCompany,
          rawData: { discoveredVia: 'candidate_classification', discoveryQuery: query },
        });
        companyId = company.id;
      } catch (err) {
        logger.warn({ err, companyName: item.extractedCompany }, 'Failed to create company for candidate');
      }
    }

    const contact = await this.saveOrUpdateContact({
      linkedinUrl: isLinkedIn ? result.url : undefined,
      firstName,
      lastName,
      title: item.extractedTitle || undefined,
      companyName: item.extractedCompany || undefined,
      companyId: companyId || undefined,
      source: isLinkedIn ? 'linkedin_search' : 'web_search',
      status: 'discovered',
      rawData: {
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        query,
        classificationConfidence: item.confidence,
        classificationReasoning: item.reasoning,
        classification: item.classification,
      },
    });

    if (isLinkedIn) {
      // LinkedIn profiles go through document agent for full scrape first
      await this.dispatchNext('document', {
        url: result.url,
        type: 'linkedin_profile',
        contactId: contact.id,
        masterAgentId,
        pipelineContext: this._ctx,
        dryRun,
      });
    } else {
      // Non-LinkedIn candidates go straight to enrichment
      await this.dispatchNext('enrichment', {
        contactId: contact.id,
        masterAgentId,
        pipelineContext: this._ctx,
        dryRun,
      });
    }

    await this.emitEvent('contact:discovered', {
      contactId: contact.id,
      source: isLinkedIn ? 'linkedin_search' : 'web_search',
      url: result.url,
      classification: item.classification,
    });
  }

  private async handleTeamPage(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    const companyName = item.extractedCompany || result.title.split(/[|–—-]/)[0]?.trim() || 'Unknown';

    // Save the company — resolve domain if URL is a third-party site
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
          classificationConfidence: item.confidence,
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

  // ── Directory/list page handler (Problem 3) ─────────────────────────────────

  private async handleDirectoryPage(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    useCase?: string,
  ): Promise<{ companyId: string; companyName: string; domain?: string }[]> {
    const discoveredCompanies: { companyId: string; companyName: string; domain?: string }[] = [];

    // Skip known non-directory sites
    const skipDomains = ['stackoverflow.com', 'stackexchange.com', 'reddit.com',
      'github.com', 'medium.com', 'quora.com', 'wikipedia.org', 'w3schools.com',
      'developer.mozilla.org', 'docs.google.com'];
    try {
      const host = new URL(result.url).hostname.replace('www.', '');
      if (skipDomains.some(d => host.endsWith(d))) return discoveredCompanies;
    } catch { /* continue */ }

    let pageContent = '';
    try {
      pageContent = await this.scrapeUrl(result.url);
    } catch (err) {
      logger.warn({ err, url: result.url }, 'Failed to scrape directory page');
      return discoveredCompanies;
    }

    if (!pageContent || pageContent.length < 100) return discoveredCompanies;

    interface DirectoryCompany { name: string; domain?: string; description?: string; url?: string; }
    let companies: DirectoryCompany[] = [];
    try {
      const extraction = await this.extractJSON<{ companies: DirectoryCompany[] }>([
        {
          role: 'system',
          content: `You extract REAL company/organization names from business directory pages.

RULES:
- Return ONLY actual company or organization names
- NEVER return article titles, question titles, page headers, or section headings
- NEVER return strings containing "?" or "[duplicate]"
- Company names are typically 1-5 words, proper nouns
- If the page is not a business directory (e.g. it's a forum, Q&A site, tutorial), return an empty array

Return valid JSON.`,
        },
        {
          role: 'user',
          content: `Extract companies from this page. Return JSON: { "companies": [{ "name": "Company Name", "domain": "company.com", "description": "Brief desc", "url": "https://..." }] }\n\nPAGE:\n${pageContent.slice(0, 6000)}`,
        },
      ]);
      companies = extraction.companies ?? [];
    } catch (err) {
      logger.warn({ err, url: result.url }, 'Failed to extract companies from directory page');
      return discoveredCompanies;
    }

    for (const company of companies.slice(0, 20)) {
      if (!company.name) continue;

      // Skip mega-corps in sales mode
      if (useCase === 'sales' && company.domain && isMegaCorp(company.domain)) continue;

      // Resolve domain if not provided
      let domain = company.domain;
      if (!domain && company.url) {
        try { domain = new URL(company.url).hostname.replace('www.', ''); } catch { /* ignore */ }
      }
      if (!domain) {
        domain = await this.resolveCompanyDomain(company.name);
      }

      const savedCompany = await this.saveOrUpdateCompany({
        name: company.name,
        domain,
        rawData: {
          ...(domain ? {} : { domainStatus: 'unresolved' }),
          directorySource: result.url,
          directoryTitle: result.title,
          discoveryQuery: query,
          description: company.description,
        },
      });

      discoveredCompanies.push({ companyId: savedCompany.id, companyName: company.name, domain });

      if (!domain) {
        await this.emitEvent('company:domain_unresolved', { companyId: savedCompany.id, companyName: company.name });
        this.sendMessage(null, 'reasoning', {
          action: 'company_discovered_incomplete',
          companyName: company.name,
          companyId: savedCompany.id,
          reason: 'no_domain_resolved',
          source: result.url,
        });
      }
    }

    logger.info({ url: result.url, companiesExtracted: companies.length }, 'Directory page processed');
    return discoveredCompanies;
  }

  private async handleJobListing(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    useCase?: string,
    masterAgentId?: string,
    opportunityFocused?: boolean,
  ): Promise<{ opportunityCreated: boolean; company: { companyId: string; companyName: string; domain?: string } | null }> {
    const companyName = item.extractedCompany || result.title.split(/[|–—-]/)[0]?.trim() || 'Unknown';

    // Resolve actual company domain (Problem 5 — job board URLs give wrong domains)
    let domain: string | undefined;
    try {
      const urlDomain = new URL(result.url).hostname.replace('www.', '');
      // If URL is a job board, resolve the actual company domain
      const jobBoardDomains = ['indeed.com', 'glassdoor.com', 'linkedin.com', 'ziprecruiter.com', 'monster.com', 'angel.co', 'lever.co', 'greenhouse.io', 'workable.com'];
      if (jobBoardDomains.some(jb => urlDomain.includes(jb))) {
        domain = await this.resolveCompanyDomain(companyName);
      } else {
        domain = urlDomain;
      }
    } catch { /* ignore */ }

    // Skip mega-corps in sales mode
    if (useCase === 'sales' && domain && isMegaCorp(domain)) return { opportunityCreated: false, company: null };

    const company = await this.saveOrUpdateCompany({
      name: companyName,
      domain,
      rawData: {
        ...(domain ? {} : { domainStatus: 'unresolved' }),
        jobListings: [
          {
            title: item.extractedJobTitle || result.title,
            skills: item.extractedRequiredSkills ?? [],
            url: result.url,
            snippet: result.snippet,
            discoveryQuery: query,
          },
        ],
      },
    });

    if (!domain) {
      await this.emitEvent('company:domain_unresolved', { companyId: company.id, companyName });
    }

    // Create opportunity record for sales mode (hiring signal = buying intent)
    let opportunityCreated = false;
    if (useCase === 'sales' && masterAgentId) {
      try {
        const technologies = item.extractedRequiredSkills ?? [];
        // Hiring signal = moderate-to-high intent (70-80)
        const buyingIntent = opportunityFocused ? 80 : 70;

        await withTenant(this.tenantId, async (tx) => {
          await tx.insert(opportunities).values({
            tenantId: this.tenantId,
            masterAgentId,
            title: `Hiring: ${item.extractedJobTitle || result.title}`.slice(0, 500),
            description: result.snippet,
            opportunityType: 'hiring_signal',
            source: 'web_discovery',
            sourceUrl: result.url,
            sourcePlatform: (() => {
              try { return new URL(result.url).hostname; } catch { return undefined; }
            })(),
            companyName,
            companyDomain: domain,
            technologies,
            buyingIntentScore: buyingIntent,
            urgency: 'soon',
            status: 'new',
            companyId: company.id,
          });
        });
        opportunityCreated = true;
      } catch (err) {
        logger.warn({ err, companyName, url: result.url }, 'Failed to create opportunity from job listing');
      }
    }

    await this.emitEvent('company:job_listing', {
      companyId: company.id,
      companyName,
      jobTitle: item.extractedJobTitle || result.title,
      url: result.url,
      opportunityCreated,
    });

    return { opportunityCreated, company: { companyId: company.id, companyName, domain } };
  }

  private async handleCompany(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    useCase?: string,
  ): Promise<{ companyId: string; companyName: string; domain?: string } | null> {
    // Extract domain from URL
    let domain: string | undefined;
    try {
      const urlDomain = new URL(result.url).hostname.replace('www.', '');
      // If URL is LinkedIn/Crunchbase, resolve real domain (Problem 5)
      if (urlDomain.includes('linkedin.com') || urlDomain.includes('crunchbase.com')) {
        const companyName = item.extractedCompany || item.extractedName || 'Unknown';
        domain = await this.resolveCompanyDomain(companyName);
      } else {
        domain = urlDomain;
      }
    } catch { /* ignore */ }

    const companyName = item.extractedCompany || item.extractedName || result.title.split(/[|–—-]/)[0]?.trim() || 'Unknown';

    // Skip mega-corps in sales mode
    if (useCase === 'sales' && domain && isMegaCorp(domain)) return null;

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
        classificationConfidence: item.confidence,
      },
    });

    if (!domain) {
      await this.emitEvent('company:domain_unresolved', { companyId: company.id, companyName });
      // Log incomplete company as agent room discovery detail
      this.sendMessage(null, 'reasoning', {
        action: 'company_discovered_incomplete',
        companyName,
        companyId: company.id,
        reason: 'no_domain_resolved',
        source: result.url,
      });
    }

    await this.emitEvent('company:discovered', {
      companyId: company.id,
      name: companyName,
      domain,
      url: result.url,
    });

    return { companyId: company.id, companyName, domain };
  }

  // ── Content with company mentions handler ───────────────────────────────────

  private async handleContentWithCompanies(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    useCase?: string,
    _masterAgentId?: string,
  ): Promise<{ companyId: string; companyName: string; domain?: string }[]> {
    const companyNames = item.extractedCompanies ?? [];
    const discoveredCompanies: { companyId: string; companyName: string; domain?: string }[] = [];
    if (companyNames.length === 0) return discoveredCompanies;

    for (const companyName of companyNames.slice(0, 15)) {
      if (!companyName || companyName.length < 2) continue;

      // Skip mega-corps in sales mode
      if (useCase === 'sales') {
        const lcName = companyName.toLowerCase();
        if (MEGA_CORP_DOMAINS.has(`${lcName}.com`) || isMegaCorp(lcName)) continue;
      }

      try {
        const domain = await this.resolveCompanyDomain(companyName);

        // Skip mega-corps by resolved domain
        if (useCase === 'sales' && domain && isMegaCorp(domain)) continue;

        const savedCompany = await this.saveOrUpdateCompany({
          name: companyName,
          domain,
          rawData: {
            ...(domain ? {} : { domainStatus: 'unresolved' }),
            contentSource: result.url,
            contentTitle: result.title,
            discoveryQuery: query,
          },
        });

        discoveredCompanies.push({ companyId: savedCompany.id, companyName, domain });

        if (!domain) {
          await this.emitEvent('company:domain_unresolved', { companyId: savedCompany.id, companyName });
          this.sendMessage(null, 'reasoning', {
            action: 'company_discovered_incomplete',
            companyName,
            companyId: savedCompany.id,
            reason: 'no_domain_resolved',
            source: result.url,
          });
        }
      } catch (err) {
        logger.warn({ err, companyName, url: result.url }, 'Failed to process company from content');
      }
    }

    logger.info({ url: result.url, companiesExtracted: companyNames.length }, 'Content with companies processed');
    return discoveredCompanies;
  }

  // ── Batch dispatch companies to enrichment ──────────────────────────────────

  private async flushCompanyPool(
    pool: { companyId: string; companyName: string; domain?: string }[],
    masterAgentId: string,
  ): Promise<number> {
    let dispatched = 0;
    const toDispatch = pool.splice(0, pool.length); // drain the pool

    for (const entry of toDispatch) {
      // Only dispatch enrichment for companies that have a domain
      if (!entry.domain) continue;

      try {
        await this.dispatchNext('enrichment', {
          companyId: entry.companyId,
          masterAgentId,
          pipelineContext: this._ctx,
        });
        dispatched++;
      } catch (err) {
        logger.warn({ err, companyId: entry.companyId, companyName: entry.companyName }, 'Failed to dispatch company enrichment');
      }
    }

    if (dispatched > 0) {
      this.sendMessage('enrichment', 'data_handoff', {
        action: 'batch_company_enrichment',
        companyCount: dispatched,
        companies: toDispatch.filter(e => e.domain).map(e => ({ companyId: e.companyId, companyName: e.companyName, domain: e.domain })),
      });
      logger.info({ masterAgentId, dispatched }, 'Flushed company pool to enrichment');
    }

    return dispatched;
  }

  // ── ICP exclusion context builder ──────────────────────────────────────────

  private buildICPExclusion(): { excludeCompanies?: string[]; companySizeRange?: string } | undefined {
    if (!this._ctx) return undefined;
    const parts: { excludeCompanies?: string[]; companySizeRange?: string } = {};

    // Build exclude list from mega-corp domains
    const excludeList = [...MEGA_CORP_DOMAINS].map(d => d.replace('.com', ''));
    parts.excludeCompanies = excludeList;

    // Company size range from sales config
    const sizeRange = this._ctx.sales?.salesStrategy?.companyQualificationCriteria?.sizeRange;
    if (sizeRange) {
      parts.companySizeRange = `${sizeRange.min ?? 10}-${sizeRange.max ?? 2000} employees`;
    } else if (this._ctx.sales?.companySizes?.length) {
      parts.companySizeRange = this._ctx.sales.companySizes.join(', ');
    }

    return parts;
  }
}
