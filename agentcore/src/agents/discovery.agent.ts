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

/** Low-value domains — never scrape, skip entirely */
const SKIP_DOMAINS = new Set([
  'youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'wikipedia.org', 'en.wikipedia.org', 'britannica.com', 'worldhistory.org',
  'goodreads.com', 'amazon.com', 'ebay.com',
  'stackoverflow.com', 'stackexchange.com',
  'investopedia.com', 'hbr.org', 'store.hbr.org',
  'nytimes.com', 'wsj.com', 'bbc.com', 'cnn.com',
  'eventbrite.com', 'meetup.com', 'gisgeography.com',
  'ficoforums.myfico.com',
]);

function shouldSkipDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace('www.', '');
  return SKIP_DOMAINS.has(d) || [...SKIP_DOMAINS].some(p => d.endsWith(`.${p}`));
}

/** LLM extraction result from a scraped page */
interface PageExtraction {
  type: 'company_page' | 'directory' | 'team_page' | 'job_listing' | 'person_profile' | 'irrelevant';
  companies: Array<{
    name: string;
    domain?: string;
    industry?: string;
    description?: string;
    size?: string;
    location?: string;
    funding?: string;
  }>;
  people: Array<{
    name: string;
    title?: string;
    company?: string;
  }>;
}

const FAST_MODEL = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';

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

    // Get useCase
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

    let companiesFound = 0;
    let candidatesFound = 0;
    let pagesScraped = 0;
    let skipped = 0;
    let enrichmentDispatched = 0;

    for (const query of searchQueries) {
      const results = await this.trackAction('search_executed', query, () => this.searchWeb(query, maxResults as number));
      if (results.length === 0) continue;

      // Process top 5 most promising results per query (scraping budget)
      const prioritized = this.prioritizeResults(results);

      for (const result of prioritized) {
        if (!result.url) continue;

        try {
          const url = result.url.toLowerCase();

          // ── LinkedIn profiles go to document agent (no scrape needed here) ──
          if (url.includes('linkedin.com/in/')) {
            await this.handleLinkedInProfile(result, query, masterAgentId, dryRun);
            candidatesFound++;
            continue;
          }

          // ── Skip low-value domains entirely ──
          let hostname = '';
          try { hostname = new URL(result.url).hostname.replace('www.', ''); } catch { /* skip */ }
          if (hostname && shouldSkipDomain(hostname)) {
            skipped++;
            continue;
          }

          // ── Skip mega-corps in sales mode ──
          if (useCase === 'sales' && hostname && isMegaCorp(hostname)) {
            skipped++;
            continue;
          }

          // ── Core: Scrape the page, then LLM classify + extract ──
          let pageContent = '';
          try {
            pageContent = await this.scrapeUrl(result.url);
            pagesScraped++;
          } catch (err) {
            logger.debug({ err, url: result.url }, 'Failed to scrape URL');
            skipped++;
            continue;
          }

          if (!pageContent || pageContent.length < 100) {
            skipped++;
            continue;
          }

          // Combined classify + extract in one LLM call
          const extraction = await this.classifyAndExtract(
            result.title, result.url, result.snippet, pageContent,
          );

          if (!extraction || extraction.type === 'irrelevant') {
            skipped++;
            continue;
          }

          // ── Save extracted companies ──
          for (const co of extraction.companies) {
            if (!co.name || co.name.length < 2) continue;
            if (useCase === 'sales' && co.domain && isMegaCorp(co.domain)) continue;

            try {
              const saved = await this.saveOrUpdateCompany({
                name: co.name,
                domain: co.domain || (hostname && !shouldSkipDomain(hostname) ? hostname : undefined),
                industry: co.industry || undefined,
                size: co.size || undefined,
                description: co.description || undefined,
                funding: co.funding || undefined,
                rawData: {
                  discoveryUrl: result.url,
                  discoveryQuery: query,
                  extractedFrom: extraction.type,
                  location: co.location || undefined,
                },
              });

              enrichmentDispatched += await this.dispatchCompanyEnrichment(
                { companyId: saved.id, companyName: co.name, domain: co.domain },
                masterAgentId,
              );
              companiesFound++;
            } catch (err) {
              logger.debug({ err, name: co.name }, 'Failed to save extracted company');
            }
          }

          // ── Save extracted people ──
          for (const person of extraction.people.slice(0, 10)) {
            if (!person.name) continue;
            const nameParts = person.name.trim().split(/\s+/);
            try {
              const contact = await this.saveOrUpdateContact({
                firstName: nameParts[0] || undefined,
                lastName: nameParts.slice(1).join(' ') || undefined,
                title: person.title || undefined,
                companyName: person.company || undefined,
                source: 'web_search',
                status: 'discovered',
                rawData: { url: result.url, query, pageType: extraction.type },
              });

              await this.dispatchNext('enrichment', {
                contactId: contact.id,
                masterAgentId,
                pipelineContext: this._ctx,
                dryRun,
              });
              candidatesFound++;
            } catch (err) {
              logger.debug({ err, name: person.name }, 'Failed to save extracted person');
            }
          }
        } catch (err) {
          logger.warn({ err, url: result.url, query }, 'Failed to process discovery result');
          skipped++;
        }
      }

      // Diagnostic logging per query
      logger.info({
        query,
        resultCount: results.length,
        processed: { companies: companiesFound, candidates: candidatesFound, pagesScraped, skipped },
      }, 'Discovery query processed');
    }

    this.sendMessage(null, 'reasoning', {
      action: 'discovery_completed',
      classified: { companies: companiesFound, candidates: candidatesFound, pagesScraped },
      enrichmentDispatched,
      queryCount: searchQueries.length,
    });

    this.logActivity('discovery_completed', 'completed', {
      details: { companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped },
    });
    await this.clearCurrentAction();

    logger.info(
      { tenantId: this.tenantId, companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped },
      'DiscoveryAgent completed',
    );

    return { companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped };
  }

  // ── Prioritize which results to scrape (budget: top 5 per query) ──────────

  private prioritizeResults(
    results: Array<{ url: string; title: string; snippet: string }>,
  ): Array<{ url: string; title: string; snippet: string }> {
    const scored = results.map(r => {
      let score = 0;
      const url = r.url.toLowerCase();
      const title = (r.title || '').toLowerCase();

      // High value: LinkedIn profiles and company pages
      if (url.includes('linkedin.com/in/')) score += 10;
      if (url.includes('linkedin.com/company/')) score += 8;

      // High value: Company homepages (short paths)
      try {
        const pathname = new URL(r.url).pathname;
        if (pathname === '/' || pathname === '') score += 7;
        if (/^\/(about|team|leadership|our-team|people)\/?$/i.test(pathname)) score += 9;
        if (/^\/(careers|jobs)\/?$/i.test(pathname)) score += 5;
      } catch { /* skip */ }

      // Medium: Crunchbase, Wellfound, directory sites
      if (url.includes('crunchbase.com/organization/')) score += 6;
      if (url.includes('wellfound.com/company/')) score += 6;

      // Medium: Title signals company list/directory
      if (/\b(companies|startups|firms|agencies)\b/i.test(title)) score += 4;
      if (/\b(top|best|leading|fastest)\b/i.test(title)) score += 3;

      // Low: News articles (scrape only if nothing better)
      if (/\b(news|article|blog|opinion|review)\b/i.test(title)) score -= 2;

      // Skip: Known bad domains
      try {
        const hostname = new URL(r.url).hostname.replace('www.', '');
        if (shouldSkipDomain(hostname)) score -= 100;
      } catch { /* skip */ }

      return { ...r, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // ── Combined classify + extract in one LLM call ──────────────────────────

  private async classifyAndExtract(
    title: string,
    url: string,
    snippet: string,
    pageContent: string,
  ): Promise<PageExtraction | null> {
    try {
      const extraction = await this.extractJSON<PageExtraction>([
        {
          role: 'system',
          content: `You analyze web page content and extract business data.

Given a page's content, URL, and title, you must:
1. Classify the page type
2. Extract ALL companies and/or people mentioned

Page types:
- "company_page" = a single company's own website/profile
- "directory" = a list/article mentioning multiple companies
- "team_page" = a company page showing team members
- "job_listing" = a job posting (the hiring company is valuable data)
- "person_profile" = an individual's profile page
- "irrelevant" = login pages, generic content, error pages, encyclopedia, event registration, geographic info

For EACH company found, extract: name, domain (if visible), industry, description (1 sentence), size, location, funding.
For EACH person found, extract: name, title, company they work at.

Return ONLY valid JSON. If the page is irrelevant, return { "type": "irrelevant", "companies": [], "people": [] }.
Do NOT invent data — only extract what is clearly stated on the page.`,
        },
        {
          role: 'user',
          content: `Title: "${title}"
URL: ${url}
Snippet: ${snippet || 'N/A'}

PAGE CONTENT (first 4000 chars):
${pageContent.slice(0, 4000)}`,
        },
      ], undefined, { model: FAST_MODEL, temperature: 0 });

      return extraction;
    } catch (err) {
      logger.warn({ err, url }, 'classifyAndExtract LLM call failed');
      return null;
    }
  }

  // ── LinkedIn profile handler (unchanged — profiles go to document agent) ──

  private async handleLinkedInProfile(
    result: { url: string; title: string; snippet: string },
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    const titleText = (result.title || '').replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();

    let firstName: string | undefined;
    let lastName: string | undefined;
    let title: string | undefined;
    let companyName: string | undefined;

    const match = titleText.match(/^(.+?)\s*[-–—]\s*(.+?)(?:\s+at\s+|\s+@\s+)(.+)$/i);
    if (match) {
      const nameParts = match[1]!.trim().split(/\s+/);
      firstName = nameParts[0] || undefined;
      lastName = nameParts.slice(1).join(' ') || undefined;
      title = match[2]!.trim() || undefined;
      companyName = match[3]!.trim() || undefined;
    } else {
      const nameParts = titleText.split(/[-–—|]/)[0]?.trim().split(/\s+/) ?? [];
      firstName = nameParts[0] || undefined;
      lastName = nameParts.slice(1).join(' ') || undefined;
    }

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
      rawData: { url: result.url, title: result.title, snippet: result.snippet, query },
    });

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

  // ── Company enrichment dispatch ───────────────────────────────────────────

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

  // ── Deep discovery (unchanged) ────────────────────────────────────────────

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
      { tenantId: this.tenantId, companiesFound, peopleFound, metadata: discoveryResult.metadata },
      'Deep discovery completed',
    );

    return { companiesFound, peopleFound, metadata: discoveryResult.metadata };
  }
}
