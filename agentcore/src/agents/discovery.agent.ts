import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents } from '../db/schema/index.js';
import { discoveryEngine } from '../tools/discovery-engine.js';
import type { DiscoveryParams } from '../tools/discovery-sources/types.js';
import type { PipelineContext } from '../types/pipeline-context.js';
import { isMegaCorp, shouldSkipDomain, SKIP_DOMAINS } from '../utils/domain-blocklist.js';
import logger from '../utils/logger.js';

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
  paris: 'france', lyon: 'france', marseille: 'france', toulouse: 'france', nantes: 'france', bordeaux: 'france', lille: 'france', strasbourg: 'france', nice: 'france', rennes: 'france', montpellier: 'france', grenoble: 'france', rouen: 'france', toulon: 'france', dijon: 'france', angers: 'france', brest: 'france', 'clermont-ferrand': 'france', 'aix-en-provence': 'france', metz: 'france', tours: 'france', amiens: 'france', limoges: 'france', perpignan: 'france', orléans: 'france',
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

/** TLD → country mapping for domain-based location fallback */
const TLD_TO_COUNTRY: Record<string, string> = {
  fr: 'france', de: 'germany', es: 'spain', it: 'italy', nl: 'netherlands',
  be: 'belgium', ch: 'switzerland', at: 'austria', pt: 'portugal',
  ie: 'ireland', uk: 'uk', 'co.uk': 'uk',
};

/** Check if a company's extracted location matches any target location */
function matchesTargetLocation(companyLocation: string | undefined, targetLocations: string[]): boolean {
  if (!targetLocations.length) return true; // no filter active
  if (!companyLocation) return false; // unknown location + targets set → reject

  const loc = companyLocation.toLowerCase().trim();
  // Reject sentinel/placeholder strings the LLM sometimes emits
  if (!loc || loc === 'unknown' || loc === 'n/a' || loc === 'none' || loc === 'null') return false;

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
    hiringSignal?: 'job_posting' | 'career_page' | 'hiring_text' | 'growth_signal' | 'none';
    jobTitle?: string;
    jobLocation?: string;
    jobSource?: string;
    jobUrl?: string;
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
    let domainFiltered = 0;
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
      const lowerQ = query.toLowerCase();
      if (lowerQ.includes('reddit.com') || lowerQ.includes(' reddit ') || lowerQ.startsWith('reddit ')) {
        try {
          const { searchRedditIntelligence } = await import('../tools/discovery-sources/reddit-intelligence.js');
          const cleanQuery = query.replace(/\breddit(?:\.com)?\b/gi, '').replace(/\s+/g, ' ').trim();
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
            domainFiltered++;
            logger.debug({ url: result.url, hostname }, 'Filtered result: blocked domain');
            continue;
          }

          // ── Skip mega-corps in sales mode ──
          if (useCase === 'sales' && hostname && isMegaCorp(hostname)) {
            domainFiltered++;
            logger.debug({ url: result.url, hostname }, 'Filtered result: mega-corp domain');
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

            // ── Hiring signal filter: reject companies with no hiring signals ──
            const hiringSignal = co.hiringSignal || 'none';
            if (hiringSignal === 'none') {
              logger.debug({ name: co.name, hiringSignal }, 'Skipping company: no hiring signal');
              skipped++;
              continue;
            }

            // Bonus for strong hiring signals
            if ((hiringSignal === 'job_posting' || hiringSignal === 'career_page') && typeof co.relevanceScore === 'number') {
              co.relevanceScore = Math.min(100, co.relevanceScore + 10);
            }

            // Relevance gate: higher threshold for weak hiring signals
            const relevanceThreshold = (hiringSignal === 'job_posting' || hiringSignal === 'career_page') ? 40 : 55;
            if (missionContext && typeof co.relevanceScore === 'number' && co.relevanceScore < relevanceThreshold) {
              logger.debug({ name: co.name, relevanceScore: co.relevanceScore, hiringSignal, threshold: relevanceThreshold, reason: co.relevanceReason }, 'Skipping company: below relevance threshold');
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

            // ── Hiring verification: independent SearXNG query ──
            const verifyTargetRole = this._ctx?.targetRoles?.[0] || this._ctx?.recruitment?.requiredSkills?.[0] || '';
            const verifyTargetLocation = this._ctx?.locations?.[0] || '';
            const verifyQuery = `"${co.name}" ${verifyTargetRole} hiring ${verifyTargetLocation}`.trim();
            let hiringVerified = false;
            try {
              const verifyResults = await this.searchWeb(verifyQuery, 5);
              const HIRING_KEYWORDS = /\b(hiring|jobs?|careers?|recrut|offre.{0,5}emploi|cdi|nous recrutons|join our team|we are hiring|poste)\b/i;
              hiringVerified = verifyResults.some(r =>
                HIRING_KEYWORDS.test(r.title || '') || HIRING_KEYWORDS.test(r.snippet || ''),
              );
            } catch (err) {
              logger.debug({ err, name: co.name }, 'Hiring verification query failed');
            }
            logger.info({ name: co.name, hiringVerified, query: verifyQuery }, `Hiring verified for ${co.name}: ${hiringVerified}`);

            // Apply -30 score penalty if not independently verified
            if (!hiringVerified && typeof co.relevanceScore === 'number') {
              co.relevanceScore = Math.max(0, co.relevanceScore - 30);
            }

            // Reject if not verified AND final score below 50
            if (!hiringVerified && (typeof co.relevanceScore !== 'number' || co.relevanceScore < 50)) {
              logger.debug({ name: co.name, relevanceScore: co.relevanceScore }, 'Skipping company: hiring not verified and score too low');
              skipped++;
              continue;
            }

            // Skip companies not matching target locations (unknown location → reject when targets set)
            if (this._ctx?.locations?.length) {
              let locationMatch = matchesTargetLocation(co.location, this._ctx.locations);

              // Domain TLD fallback: if location missing/wrong but TLD matches a target country, accept
              if (!locationMatch && co.domain) {
                const parts = co.domain.toLowerCase().split('.');
                const tldShort = parts[parts.length - 1] || '';
                const tldLong = parts.slice(-2).join('.');
                const country = TLD_TO_COUNTRY[tldLong] || TLD_TO_COUNTRY[tldShort];
                if (country && this._ctx.locations.some(t => t.toLowerCase().includes(country))) {
                  locationMatch = true;
                  logger.debug({ name: co.name, domain: co.domain, country }, 'Location accepted via TLD fallback');
                }
              }

              if (!locationMatch) {
                logger.info(
                  { name: co.name, location: co.location ?? 'unknown', domain: co.domain, targets: this._ctx.locations },
                  `Location rejected: ${co.name} location=${co.location ?? 'unknown'} not in ${this._ctx.locations.join(',')}`,
                );
                skipped++;
                continue;
              }
            }

            // ── Company relevance validation ──
            const coIndustryLower = (co.industry || '').toLowerCase();
            const coEntityType = (co.entityType || '').toLowerCase();
            const coNameLower = co.name.toLowerCase();

            // Skip recruitment agencies — we want companies HIRING, not agencies
            const recruitmentKeywords = ['recruitment', 'staffing', 'recrutement', 'hr services', 'human resources services', 'talent acquisition', 'executive search', 'headhunting', 'interim', 'travail temporaire', 'intérim'];
            if (recruitmentKeywords.some(kw => coIndustryLower.includes(kw) || coNameLower.includes(kw))) {
              logger.debug({ name: co.name, industry: co.industry }, 'Skipping company: recruitment agency');
              skipped++;
              continue;
            }

            // Skip government entities unless mission targets government
            const targetGov = this._ctx?.sales?.industries?.some(i => /government|public|gouv/i.test(i));
            const govKeywords = ['government', 'public administration', 'ville de', 'mairie', 'communauté', 'département', 'préfecture', 'ministère', 'collectivité', 'municipalit'];
            if (!targetGov && (coEntityType === 'government' || govKeywords.some(kw => coIndustryLower.includes(kw) || coNameLower.includes(kw)))) {
              logger.debug({ name: co.name, entityType: co.entityType, industry: co.industry }, 'Skipping company: government entity');
              skipped++;
              continue;
            }

            // Skip mega-corps (10000+ employees) unless mission targets enterprise
            const sizeNum = parseInt(co.size || '', 10);
            const targetEnterprise = this._ctx?.sales?.companySizes?.some(s => /enterprise|10000|large/i.test(s));
            if (!targetEnterprise && (sizeNum >= 10000 || isMegaCorp(co.domain || ''))) {
              logger.debug({ name: co.name, size: co.size, domain: co.domain }, 'Skipping company: mega-corp');
              skipped++;
              continue;
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
                  hiringSignal,
                  hiringVerified,
                  ...(co.jobTitle && { job_title: co.jobTitle }),
                  ...(co.jobLocation && { job_location: co.jobLocation }),
                  ...(co.jobSource && { job_source: co.jobSource }),
                  ...(co.jobUrl && { job_url: co.jobUrl }),
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
        processed: { companies: companiesFound, candidates: candidatesFound, pagesScraped, skipped, domainFiltered },
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
      details: { companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped, domainFiltered },
    });
    await this.clearCurrentAction();

    logger.info(
      { tenantId: this.tenantId, totalQueries: searchQueries.length, queriesWithResults, queriesEmpty, companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped, domainFiltered },
      'DiscoveryAgent completed',
    );

    return { companiesFound, candidatesFound, pagesScraped, enrichmentDispatched, skipped, domainFiltered };
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

      // Highest value: Job boards and career pages (hiring signals)
      if (url.includes('indeed.com') || url.includes('indeed.fr')) score += 10;
      if (url.includes('welcometothejungle.com') || url.includes('welcome-to-the-jungle.com')) score += 10;
      if (url.includes('free-work.com')) score += 10;
      if (url.includes('apec.fr')) score += 10;
      if (url.includes('glassdoor.com') || url.includes('glassdoor.fr')) score += 9;
      if (url.includes('linkedin.com/jobs/')) score += 10;

      // High value: Career/jobs paths on company sites
      try {
        const pathname = new URL(r.url).pathname;
        if (/\/(careers|jobs|join-us|recrutement|nous-rejoindre|emploi)/i.test(pathname)) score += 11;
        if (pathname === '/' || pathname === '') score += 4;
        if (/^\/(about|team|leadership|our-team|people)\/?$/i.test(pathname)) score += 6;
      } catch { /* skip */ }

      // Title signals: hiring intent
      if (/\b(hiring|job|jobs|career|careers|recrutement|offre|emploi|recrut|poste|CDI|CDD)\b/i.test(title)) score += 6;

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
          content: `You are analyzing web pages to find COMPANIES THAT ARE ACTIVELY HIRING for a specific role.
${missionBlock}
CRITICAL RULES:
- You are looking for JOB POSTINGS, CAREER PAGES, and HIRING ANNOUNCEMENTS — not general company information.
- For job board pages (Indeed, LinkedIn Jobs, Glassdoor, Welcome to the Jungle, Free-Work, APEC, IrishJobs, Monster, SimplyHired):
  Extract EACH individual job listing as a separate company entry. The company is the EMPLOYER listed in the job posting, NOT the job board itself.
  Extract: company name (the employer), the job title posted, location from the posting, industry of the employer.
  The domain should be the EMPLOYER's website domain, NOT the job board URL (not indeed.com, not linkedin.com, not welcometothejungle.com).
  Set hiringSignal to "job_posting". Set jobTitle to the role being hired. Set jobLocation to the location in the posting. Set jobSource to the job board name.
- For company career pages (URLs containing /careers, /jobs, /join-us, /recrutement, /nous-rejoindre):
  Extract the company that owns the career page and the specific roles they are hiring for.
  Set hiringSignal to "career_page". Set jobTitle to the most relevant open role found.
- For pages with hiring language ("We are hiring", "Join our team", "Nous recrutons", "Rejoignez-nous", "Postuler"):
  Extract the company and set hiringSignal to "hiring_text".
- For pages about company growth, funding, or expansion (but no specific job postings):
  Set hiringSignal to "growth_signal".
- For generic company pages with NO job postings or hiring signals whatsoever:
  Set hiringSignal to "none" and relevanceScore to maximum 15. We do NOT want companies that merely exist — we want companies that are HIRING.

HIRING SIGNAL SCORING — relevanceScore must reflect hiring intent:
- Job posting found for a matching role = base 70, up to 95 if role+location match mission perfectly
- Career page with open roles matching mission = base 60, up to 85
- "We are hiring" / "Join our team" text = base 45, up to 65
- Recent funding/growth news (likely to hire) = base 30, up to 45
- No hiring signal at all = maximum 15, mark as irrelevant

Page types:
- "job_listing" = a job board page or career page with specific job postings
- "company_page" = a single organization's own website/profile
- "institution_page" = a university, research institution, or government agency page
- "directory" = a list/article mentioning multiple organizations
- "team_page" = an organization page showing team members/faculty/staff
- "person_profile" = an individual's profile page
- "irrelevant" = login pages, generic content, error pages, encyclopedia, event registration, geographic info, pages with no hiring signals

For EACH organization found, extract: name, domain (the EMPLOYER's actual website domain — NOT the job board domain), industry, description (1 sentence), size, location (MUST include country — e.g. "Paris, France" or "Lyon, France"), funding, entityType ("company", "university", "government", "ngo", "agency", "institution"), relevanceScore (0-100), relevanceReason, hiringSignal ("job_posting", "career_page", "hiring_text", "growth_signal", or "none"), jobTitle (the specific role being hired if found), jobLocation (location from the job posting), jobSource (job board name if applicable), jobUrl (URL of the specific posting if available).

⚠️ DOMAIN RULE — READ CAREFULLY:
The domain field must be the company's ACTUAL website. NOT the URL of the page you are reading.

Example: If you are reading glassdoor.com/Jobs/Doctolib and see a job from Doctolib, the domain is "doctolib.com" NOT "glassdoor.com".
Example: If you are reading linkedin.com/jobs/view/... posted by Acme Corp, the domain is "acme.com" (or empty if not stated in the content), NOT "linkedin.com".
Example: If you are reading indeed.fr/jobs?... posted by BlaBlaCar, the domain is "blablacar.com", NOT "indeed.fr".
Example: If you are reading welcometothejungle.com/fr/companies/criteo, the domain is "criteo.com", NOT "welcometothejungle.com".

If you cannot determine the company's real domain from the page content, set domain to empty string. An empty domain is better than a wrong domain.

⚠️ JOB BOARD RULE:
For job board pages, the company is the EMPLOYER, not the job board.
- Indeed is NOT a company to extract.
- LinkedIn is NOT a company to extract.
- Glassdoor is NOT a company to extract.
- Welcome to the Jungle is NOT a company to extract.
- Free-Work is NOT a company to extract.
- APEC is NOT a company to extract.
- Monster is NOT a company to extract.
Extract the companies whose jobs are LISTED on the board.

⚠️ The "location" field is CRITICAL. Always include the country. Infer from domain (.fr = France, .de = Germany, .co.uk = UK) or page content if not stated explicitly.
⚠️ NAME RULE: The "name" must be the EMPLOYER company name. Never use person names, job board names, "Self-employed", "Unknown", "N/A", or SEC filing formats as company names.

For EACH person found, extract: name, title/role, organization they work at.

Return ONLY valid JSON. If the page is irrelevant or has no hiring signals, return { "type": "irrelevant", "companies": [], "people": [] }.
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
