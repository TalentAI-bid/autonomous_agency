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
  // Social media & forums
  'youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'discord.com', 'app.slack.com', 'zoom.us', 'telegram.org',
  // Reference / encyclopedias
  'wikipedia.org', 'en.wikipedia.org', 'britannica.com', 'worldhistory.org',
  'merriam-webster.com', 'dictionary.com',
  // E-commerce / consumer
  'amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'bestbuy.com',
  'aliexpress.com', 'wish.com', 'goodreads.com', 'carfax.com',
  // Q&A / developer forums
  'stackoverflow.com', 'stackexchange.com', 'serverfault.com',
  'superuser.com', 'askubuntu.com', 'stackinfra.com',
  // Developer tools / code hosting
  'github.com', 'gitlab.com', 'bitbucket.org',
  'npmjs.com', 'pypi.org', 'rubygems.org',
  // Tutorial / learning sites
  'cplusplus.com', 'geeksforgeeks.org', 'w3schools.com', 'tutorialspoint.com',
  'freecodecamp.org', 'codecademy.com', 'openstax.org',
  // Developer blogs / content
  'medium.com', 'dev.to', 'news.ycombinator.com', 'hackernews.com',
  // Academic / research
  'arxiv.org', 'researchgate.net', 'scholar.google.com',
  'collegeconfidential.com', 'talk.collegeconfidential.com',
  // Google services
  'docs.google.com', 'drive.google.com', 'sheets.google.com',
  // News / media
  'investopedia.com', 'hbr.org', 'store.hbr.org',
  'nytimes.com', 'wsj.com', 'bbc.com', 'cnn.com',
  'forbes.com', 'businessinsider.com', 'techcrunch.com',
  // Events / misc
  'eventbrite.com', 'meetup.com', 'gisgeography.com',
  'ficoforums.myfico.com',
  // Adult
  'pornhub.com', 'xvideos.com',
  // Job boards (not target companies)
  'indeed.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
  // Community sub-domains
  'community.shopify.com',
]);

function shouldSkipDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace('www.', '');
  return SKIP_DOMAINS.has(d) || [...SKIP_DOMAINS].some(p => d.endsWith(`.${p}`));
}

/** Detect dead/invalid LinkedIn profile URLs from search result metadata */
function isDeadLinkedInProfile(title: string, snippet: string, url: string): boolean {
  const t = (title || '').toLowerCase();
  const s = (snippet || '').toLowerCase();
  // LinkedIn 404/login pages in search results
  if (t.includes('page not found') || t.includes('page doesn\'t exist')) return true;
  if (t === 'linkedin' || t === 'linkedin login' || t === 'sign in | linkedin') return true;
  // Very short titles with no name info (just "LinkedIn")
  if (t.replace(/\s*\|\s*linkedin\s*/gi, '').trim().length < 3) return true;
  // Snippet indicates removed profile
  if (s.includes('this page doesn\'t exist') || s.includes('page you requested doesn\'t exist')) return true;
  if (s.includes('this profile is not available') || s.includes('profile not found')) return true;
  // URL validation: must have a valid slug after /in/
  const slugMatch = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!slugMatch || slugMatch[1]!.length < 2) return true;
  // Reject obviously non-profile slugs
  const slug = slugMatch[1]!.toLowerCase();
  if (['404', 'error', 'login', 'signup', 'pub', 'directory'].includes(slug)) return true;
  return false;
}

/** City → country mapping for geographic hierarchy matching */
const CITY_TO_COUNTRY: Record<string, string> = {
  dublin: 'ireland', cork: 'ireland', galway: 'ireland', limerick: 'ireland',
  london: 'uk', manchester: 'uk', birmingham: 'uk', edinburgh: 'uk', glasgow: 'uk', bristol: 'uk', leeds: 'uk', cambridge: 'uk', oxford: 'uk',
  paris: 'france', lyon: 'france', marseille: 'france', toulouse: 'france', nantes: 'france',
  berlin: 'germany', munich: 'germany', hamburg: 'germany', frankfurt: 'germany', cologne: 'germany', stuttgart: 'germany',
  amsterdam: 'netherlands', rotterdam: 'netherlands', 'the hague': 'netherlands', utrecht: 'netherlands',
  madrid: 'spain', barcelona: 'spain', valencia: 'spain', seville: 'spain',
  rome: 'italy', milan: 'italy', turin: 'italy', florence: 'italy',
  lisbon: 'portugal', porto: 'portugal',
  stockholm: 'sweden', gothenburg: 'sweden', malmo: 'sweden',
  copenhagen: 'denmark', aarhus: 'denmark',
  oslo: 'norway', bergen: 'norway',
  helsinki: 'finland', espoo: 'finland',
  zurich: 'switzerland', geneva: 'switzerland', bern: 'switzerland', basel: 'switzerland',
  vienna: 'austria', graz: 'austria',
  brussels: 'belgium', antwerp: 'belgium',
  warsaw: 'poland', krakow: 'poland', wroclaw: 'poland',
  prague: 'czech republic', brno: 'czech republic',
  budapest: 'hungary',
  bucharest: 'romania', cluj: 'romania',
  sofia: 'bulgaria',
  athens: 'greece', thessaloniki: 'greece',
  tokyo: 'japan', osaka: 'japan',
  beijing: 'china', shanghai: 'china', shenzhen: 'china', guangzhou: 'china',
  mumbai: 'india', bangalore: 'india', delhi: 'india', hyderabad: 'india', pune: 'india', chennai: 'india',
  sydney: 'australia', melbourne: 'australia', brisbane: 'australia', perth: 'australia',
  toronto: 'canada', vancouver: 'canada', montreal: 'canada', ottawa: 'canada',
  'new york': 'usa', 'san francisco': 'usa', 'los angeles': 'usa', chicago: 'usa', austin: 'usa', seattle: 'usa', boston: 'usa', denver: 'usa',
  'tel aviv': 'israel', jerusalem: 'israel', haifa: 'israel',
  singapore: 'singapore',
  'buenos aires': 'argentina',
  'sao paulo': 'brazil', 'rio de janeiro': 'brazil',
  'mexico city': 'mexico',
};

/** Country aliases for flexible matching */
const COUNTRY_ALIASES: Record<string, string[]> = {
  uk: ['united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'],
  usa: ['united states', 'us', 'america', 'united states of america'],
  uae: ['united arab emirates'],
};

/** Check if a company's extracted location matches any target location */
function matchesTargetLocation(companyLocation: string | undefined, targetLocations: string[]): boolean {
  if (!targetLocations.length) return true; // no filter active
  if (!companyLocation) return false; // unknown location + targets set → reject

  const loc = companyLocation.toLowerCase().trim();

  return targetLocations.some(target => {
    const t = target.toLowerCase().trim();

    // Direct substring match (existing logic)
    if (loc.includes(t) || t.includes(loc)) return true;

    // Geographic hierarchy: check if company city maps to a target country
    for (const [city, country] of Object.entries(CITY_TO_COUNTRY)) {
      if (loc.includes(city)) {
        if (t === country || t.includes(country) || country.includes(t)) return true;
        // Check aliases
        const aliases = COUNTRY_ALIASES[country];
        if (aliases?.some(a => t.includes(a) || a.includes(t))) return true;
      }
    }

    // Check if target is a city and company location contains the country
    const targetCountry = CITY_TO_COUNTRY[t];
    if (targetCountry && loc.includes(targetCountry)) return true;

    // Country alias match
    for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
      const allForms = [canonical, ...aliases];
      const locMatchesAny = allForms.some(f => loc.includes(f));
      const targetMatchesAny = allForms.some(f => t.includes(f) || f.includes(t));
      if (locMatchesAny && targetMatchesAny) return true;
    }

    return false;
  });
}

/**
 * Simplify an over-quoted search query for retry.
 * Removes excess quoting — keeps max 2 quoted phrases and makes the rest unquoted keywords.
 * Example: '"société" "ESN" "DevOps" "services" "France"' → 'société ESN "DevOps" France'
 */
function simplifyQuery(query: string): string | null {
  // Don't simplify site:-scoped queries (LinkedIn, etc.)
  if (/site:\S+/.test(query)) return null;

  const quotedPhrases = query.match(/"[^"]+"/g) || [];
  if (quotedPhrases.length <= 2) return null; // already simple enough

  // Extract all terms (quoted and unquoted)
  const allTerms: string[] = [];
  let remaining = query;
  for (const phrase of quotedPhrases) {
    remaining = remaining.replace(phrase, '');
    allTerms.push(phrase.replace(/"/g, ''));
  }
  remaining.split(/\s+/).filter(t => t.length > 1 && !['OR', 'AND', 'NOT'].includes(t.toUpperCase())).forEach(t => allTerms.push(t));

  if (allTerms.length === 0) return null;

  const simplified = allTerms.slice(0, 4).join(' ');
  return simplified !== query ? simplified : null;
}

/** LLM extraction result from a scraped page */
interface PageExtraction {
  type: 'company_page' | 'directory' | 'team_page' | 'job_listing' | 'person_profile' | 'institution_page' | 'irrelevant';
  companies: Array<{
    name: string;
    domain?: string;
    industry?: string;
    description?: string;
    size?: string;
    location?: string;
    funding?: string;
    entityType?: string; // 'company' | 'university' | 'government' | 'ngo' | 'agency' | 'institution'
    relevanceScore?: number; // 0-100: how relevant to mission
    relevanceReason?: string;
  }>;
  people: Array<{
    name: string;
    title?: string;
    company?: string;
  }>;
}

const FAST_MODEL = 'openai.gpt-oss-120b-1:0';

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
    let queriesWithResults = 0;
    let queriesEmpty = 0;

    // Build rich mission context for LLM classification and relevance scoring
    let missionContext: string | undefined;
    if (this._ctx) {
      const parts: string[] = [];
      if (this._ctx.missionText) parts.push(`MISSION: ${this._ctx.missionText}`);
      if (this._ctx.sales?.industries?.length) parts.push(`Target industries: ${this._ctx.sales.industries.join(', ')}`);
      if (this._ctx.targetRoles?.length) parts.push(`Target roles: ${this._ctx.targetRoles.join(', ')}`);
      if (this._ctx.locations?.length) parts.push(`Target locations: ${this._ctx.locations.join(', ')}`);
      if (this._ctx.recruitment?.requiredSkills?.length) parts.push(`Required skills: ${this._ctx.recruitment.requiredSkills.join(', ')}`);
      if (this._ctx.sales?.techStack?.length) parts.push(`Tech signals: ${this._ctx.sales.techStack.join(', ')}`);
      const strategy = this._ctx.sales?.salesStrategy;
      if (strategy?.companyQualificationCriteria) {
        const cq = strategy.companyQualificationCriteria;
        if (cq.industries?.length) parts.push(`Qualification industries: ${cq.industries.join(', ')}`);
        if (cq.techSignals?.length) parts.push(`Tech signals: ${cq.techSignals.join(', ')}`);
        if (cq.redFlags?.length) parts.push(`RED FLAGS (reject if present): ${cq.redFlags.join(', ')}`);
        if (cq.sizeRange) parts.push(`Company size: ${cq.sizeRange.min ?? '?'}–${cq.sizeRange.max ?? '?'} employees`);
      }
      if (parts.length > 0) missionContext = parts.join('\n');
    }

    for (const query of searchQueries) {
      // ── Route Reddit queries to specialized Reddit intelligence handler ──
      if (query.includes('site:reddit.com')) {
        try {
          const { searchRedditIntelligence } = await import('../tools/discovery-sources/reddit-intelligence.js');
          const cleanQuery = query.replace(/site:reddit\.com\S*/gi, '').trim();
          const redditCompanies = await searchRedditIntelligence(
            { keywords: [cleanQuery], useCase: useCase as 'sales' | 'recruitment' | undefined, maxResults },
            this.tenantId,
          );
          for (const rc of redditCompanies) {
            if (!rc.name || rc.confidence < 40) continue;
            // Skip companies not matching target locations
            if (this._ctx?.locations?.length && (rc as any).location) {
              if (!matchesTargetLocation((rc as any).location, this._ctx.locations)) continue;
            }
            try {
              const saved = await this.saveOrUpdateCompany({
                name: rc.name,
                domain: rc.domain || undefined,
                industry: rc.industry || undefined,
                description: rc.description || undefined,
                size: rc.size || undefined,
                rawData: { ...rc.rawData, source: 'reddit_intelligence', discoveryQuery: query },
              });
              enrichmentDispatched += await this.dispatchCompanyEnrichment(
                { companyId: saved.id, companyName: rc.name, domain: rc.domain },
                masterAgentId,
              );
              companiesFound++;
            } catch (err) {
              logger.debug({ err, name: rc.name }, 'Failed to save Reddit-discovered company');
            }
          }
          logger.info({ query: cleanQuery, companiesFound: redditCompanies.length }, 'Reddit intelligence query processed');
          continue; // Skip normal web search for this query
        } catch (err) {
          logger.warn({ err, query }, 'Reddit intelligence search failed, falling back to web search');
        }
      }

      let results = await this.trackAction('search_executed', query, () => this.searchWeb(query, maxResults as number));

      // Retry with simplified query if original returned empty
      if (results.length === 0) {
        const simpler = simplifyQuery(query);
        if (simpler) {
          logger.info({ original: query, simplified: simpler, tenantId: this.tenantId }, 'Original query returned 0 results — retrying with simplified query');
          results = await this.trackAction('search_retry', simpler, () => this.searchWeb(simpler, maxResults as number));
        }
      }

      if (results.length === 0) {
        queriesEmpty++;
        logger.warn({ query, tenantId: this.tenantId, masterAgentId }, 'SearXNG returned 0 results for query (including retry)');
        continue;
      }
      queriesWithResults++;

      // Process top 5 most promising results per query (scraping budget)
      const prioritized = this.prioritizeResults(results);

      for (const result of prioritized) {
        if (!result.url) continue;

        try {
          const url = result.url.toLowerCase();

          // ── LinkedIn profiles go to document agent (no scrape needed here) ──
          if (url.includes('linkedin.com/in/')) {
            if (isDeadLinkedInProfile(result.title, result.snippet, result.url)) {
              logger.debug({ url: result.url, title: result.title }, 'Skipping dead/invalid LinkedIn profile');
              skipped++;
              continue;
            }
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
            result.title, result.url, result.snippet, pageContent, missionContext,
          );

          if (!extraction || extraction.type === 'irrelevant') {
            skipped++;
            continue;
          }

          // ── Save extracted companies ──
          for (const co of extraction.companies) {
            if (!co.name || co.name.length < 2) continue;
            if (useCase === 'sales' && co.domain && isMegaCorp(co.domain)) continue;

            // Relevance gate: skip companies below threshold when mission context is active
            if (missionContext && typeof co.relevanceScore === 'number' && co.relevanceScore < 40) {
              logger.debug({ name: co.name, relevanceScore: co.relevanceScore, reason: co.relevanceReason }, 'Skipping company: below relevance threshold');
              skipped++;
              continue;
            }

            // Industry filter: reject companies whose industry doesn't match target industries
            const targetIndustries = this._ctx?.sales?.industries;
            if (targetIndustries?.length && co.industry) {
              const coIndustry = co.industry.toLowerCase();
              const industryMatch = targetIndustries.some(target => {
                const t = target.toLowerCase();
                // Direct substring match
                if (coIndustry.includes(t) || t.includes(coIndustry)) return true;
                // Shared significant word match (words >4 chars)
                const coWords = coIndustry.split(/[\s,/&-]+/).filter(w => w.length > 4);
                const tWords = t.split(/[\s,/&-]+/).filter(w => w.length > 4);
                return coWords.some(cw => tWords.some(tw => cw === tw || cw.includes(tw) || tw.includes(cw)));
              });
              if (!industryMatch) {
                logger.debug({ name: co.name, industry: co.industry, targetIndustries }, 'Skipping company: industry mismatch');
                skipped++;
                continue;
              }
            }

            // Skip companies not matching target locations (unknown location → reject when targets set)
            if (this._ctx?.locations?.length) {
              if (!matchesTargetLocation(co.location, this._ctx.locations)) {
                logger.debug({ name: co.name, location: co.location ?? 'unknown', targets: this._ctx.locations }, 'Skipping company: location mismatch');
                skipped++;
                continue;
              }
            }

            try {
              const saved = await this.saveOrUpdateCompany({
                name: co.name,
                domain: co.domain || undefined,
                industry: co.industry || undefined,
                size: co.size || undefined,
                description: co.description || undefined,
                funding: co.funding || undefined,
                rawData: {
                  discoveryUrl: result.url,
                  discoveryQuery: query,
                  extractedFrom: extraction.type,
                  location: co.location || undefined,
                  entityType: co.entityType || 'company',
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

          // ── Save extracted people (only those with a valid company) ──
          for (const person of extraction.people.slice(0, 10)) {
            if (!person.name || !person.company) continue;

            // Skip people from junk/non-company domains
            const personCompanyLower = person.company.toLowerCase();
            const isJunkCompany = [...SKIP_DOMAINS].some(d => {
              const shortName = d.replace('.com', '').replace('.org', '').replace('.net', '');
              return personCompanyLower === shortName || personCompanyLower === d || personCompanyLower.includes(shortName);
            });
            if (isJunkCompany) {
              logger.debug({ name: person.name, company: person.company }, 'Skipping person: junk company');
              skipped++;
              continue;
            }

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

    if (companiesFound === 0 && candidatesFound === 0) {
      logger.warn(
        { tenantId: this.tenantId, masterAgentId, queryCount: searchQueries.length },
        'DiscoveryAgent found ZERO companies/candidates across all queries — SearXNG may be down or queries too specific',
      );
      this.sendMessage(null, 'system_alert', {
        action: 'discovery_empty',
        queryCount: searchQueries.length,
        message: `Discovery searched ${searchQueries.length} queries but found 0 new companies or contacts. Possible causes: (1) SearXNG is down or returning empty results, (2) search queries are too specific, (3) target niche is very narrow. Check SearXNG status at /api/health/services.`,
      });
      await this.emitEvent('pipeline:discovery_empty', { masterAgentId, queryCount: searchQueries.length });
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
      { tenantId: this.tenantId, totalQueries: searchQueries.length, queriesWithResults, queriesEmpty, companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped },
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
      let hostname = '';
      try { hostname = new URL(r.url).hostname.replace('www.', ''); } catch { /* skip */ }

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

      // Academic institutions
      if (url.includes('.edu/') || url.includes('.ac.uk/') || url.includes('.ac.') || /\.edu$/.test(url)) score += 7;
      // Government / NGO
      if (url.includes('.gov/') || url.includes('.gov.') || /\.gov$/.test(url)) score += 5;
      if (url.includes('.org/') && hostname && !shouldSkipDomain(hostname)) score += 3;

      // Medium: Title signals company list/directory
      if (/\b(companies|startups|firms|agencies)\b/i.test(title)) score += 4;
      if (/\b(top|best|leading|fastest)\b/i.test(title)) score += 3;
      // University/institution title signals
      if (/\b(university|universit[éeà]|université|college|faculty|department|school of|institute of|research center)\b/i.test(title)) score += 5;
      if (/\b(organizations|institutions|agencies|foundations|associations)\b/i.test(title)) score += 4;

      // Low: News articles (scrape only if nothing better)
      if (/\b(news|article|blog|opinion|review)\b/i.test(title)) score -= 2;

      // Skip: Known bad domains
      if (hostname && shouldSkipDomain(hostname)) score -= 100;

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
    missionContext?: string,
  ): Promise<PageExtraction | null> {
    try {
      const missionBlock = missionContext
        ? `\n--- MISSION CONTEXT (use this to score relevance) ---\n${missionContext}\n--- END MISSION CONTEXT ---\n\nIMPORTANT RELEVANCE RULES:\n- Only extract organizations that PLAUSIBLY match the mission above.\n- For each organization, assign a relevanceScore (0-100) based on how well it matches the mission's target industries, locations, skills/tech, and roles.\n- 80-100 = strong match (right industry, right location, right signals)\n- 50-79 = partial match (some criteria match)\n- 20-49 = weak match (tangential relation)\n- 0-19 = irrelevant (wrong industry, wrong country, no connection)\n- If the mission specifies a location (e.g. "Ireland"), companies NOT in that country should score below 30.\n- If the mission specifies an industry/service (e.g. "DevOps"), companies in unrelated industries should score below 30.\n- Provide a brief relevanceReason explaining the score.\n`
        : '';

      const extraction = await this.extractJSON<PageExtraction>([
        {
          role: 'system',
          content: `You analyze web page content and extract organizational and people data.

Given a page's content, URL, and title, you must:
1. Classify the page type
2. Extract organizations and people mentioned that are relevant to the mission
${missionBlock}
Page types:
- "company_page" = a single organization's own website/profile (commercial entity)
- "institution_page" = a university, research institution, or government agency page
- "directory" = a list/article mentioning multiple organizations
- "team_page" = an organization page showing team members/faculty/staff
- "job_listing" = a job/position posting (the hiring organization is valuable data)
- "person_profile" = an individual's profile page
- "irrelevant" = login pages, generic content, error pages, encyclopedia, event registration, geographic info

For EACH organization found, extract: name, domain (if visible), industry (or academic field/sector), description (1 sentence), size, location (MUST include country — e.g. "Paris, France" or "USA"), funding (use "N/A" for non-commercial entities like universities), entityType ("company", "university", "government", "ngo", "agency", "institution"), relevanceScore (0-100), relevanceReason (brief explanation).
⚠️ The "location" field is CRITICAL. Always include the country. Infer from domain (.fr = France, .de = Germany, .co.uk = UK) or page content if not stated explicitly.
⚠️ The "relevanceScore" field is CRITICAL. Score each entity based on how well it matches the mission context above.
For EACH person found, extract: name, title/role, organization they work at.

Return ONLY valid JSON. If the page is irrelevant, return { "type": "irrelevant", "companies": [], "people": [] }.
Do NOT invent data — only extract what is clearly stated on the page.`,
        },
        {
          role: 'user',
          content: `Title: "${title}"
URL: ${url}
Snippet: ${snippet || 'N/A'}

PAGE CONTENT (first 2000 chars):
${pageContent.slice(0, 2000)}`,
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
