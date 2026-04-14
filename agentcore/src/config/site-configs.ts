/**
 * Site Configuration Registry — known job boards and company databases.
 *
 * Each `SiteConfig` describes how to scrape a specific site:
 * - URL pattern + query/location params (or path-based when `searchParam === ''`)
 * - Cookie-banner dismissal JS (site-specific + generic fallback)
 * - Wait selectors / extra wait time
 * - Pagination strategy
 * - Per-domain delay (used by smart-crawler's in-process rate limiter)
 * - Allowed countries (ISO codes; `['all']` for global sites)
 *
 * The CompanyFinderAgent reads this registry to decide which sites to crawl
 * for a given mission. The smart-crawler.ts module consumes the configs.
 */

export interface SiteConfig {
  name: string;
  baseUrl: string;
  type: 'job_board' | 'company_database' | 'json_api';
  /** Query string key for the keyword. Empty string ⇒ append keyword to path. */
  searchParam: string;
  /** Optional location query key. Some sites encode location in the path instead. */
  locationParam?: string;
  /** Site-specific JS to dismiss cookie banner. May be empty. */
  cookieDismiss: string;
  /** Also try GENERIC_COOKIE_DISMISS after the site-specific JS. */
  genericCookieFallback: boolean;
  /** CSS selector to wait for before extracting content. */
  waitForSelector: string;
  /** Extra wait (ms) after the selector appears (for late-loading content). */
  waitMs: number;
  /** Max pages to fetch per keyword. */
  maxPages: number;
  /** Optional pagination key (e.g., 'page', 'start'). */
  nextPageParam?: string;
  /** 1 for 1-indexed page numbers; 25 for 0-indexed offsets in increments of 25, etc. */
  nextPageIncrement?: number;
  /** Min ms between requests to this domain (enforced in-process). */
  delayBetweenPages: number;
  /** Allowed countries (ISO 3166-1 alpha-2, lowercase) or ['all']. */
  countries: string[];
  /** Optional override headers (e.g., per-site Accept-Language). */
  headers?: Record<string, string>;
  /** Optional category for profile-search sources (used by candidate-finder). */
  profileType?: 'developer' | 'designer' | 'sales' | 'general';
  /**
   * Optional static query params appended to every request for this site.
   * Used by dev.to to force `filters=class_name:User` (returns users, not articles).
   * `crawlSite` merges these into the URLSearchParams before building the final URL.
   */
  extraQueryParams?: Record<string, string>;
}

/**
 * Generic cookie-banner dismissal JS — clicks Accept buttons across the most
 * common consent management platforms (OneTrust, Didomi, Cookiebot, etc.) and
 * any button whose visible text matches a known accept phrase.
 *
 * Designed to run inside Crawl4AI's `js_code` (top-level await is supported).
 */
export const GENERIC_COOKIE_DISMISS = `
const selectors = [
  'button[id*="accept"]', 'button[id*="agree"]', 'button[id*="consent"]',
  'button[class*="accept"]', 'button[class*="agree"]',
  '#onetrust-accept-btn-handler', '#didomi-notice-agree-button',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.cookie-consent-accept', '[data-testid="cookie-accept"]'
];
for (const sel of selectors) {
  const btn = document.querySelector(sel);
  if (btn) { btn.click(); break; }
}
document.querySelectorAll('button, a').forEach(el => {
  const text = (el.textContent || '').toLowerCase().trim();
  if (['accept','accepter','ok pour moi',"j'accepte",'agree','allow',
       'got it','ok','ich stimme zu','akzeptieren','aceptar','accetto',
       'tout accepter','accept all','accept cookies'].includes(text)) {
    el.click();
  }
});
await new Promise(r => setTimeout(r, 2000));
`;

/**
 * Tested SiteConfigs for known job boards / company databases.
 *
 * NOTE: Sites with `searchParam: ''` use a path-based search where the keyword
 * is appended to the URL path. The smart-crawler converts the keyword by
 * lowercasing, replacing spaces with `-`, and URL-encoding the result.
 *
 * Country codes follow ISO 3166-1 alpha-2 (lowercase). The mission analyzer
 * filters this registry by `targetCountry` against each entry's `countries`.
 */
export const SITE_CONFIGS: Record<string, SiteConfig> = {
  // ── Job Boards ────────────────────────────────────────────────────────────
  welcometothejungle: {
    name: 'Welcome to the Jungle',
    baseUrl: 'https://www.welcometothejungle.com/fr/jobs',
    type: 'job_board',
    searchParam: 'query',
    locationParam: 'refinementList[offices.country_code][]',
    cookieDismiss: `
      const btn = document.querySelector('#axeptio_btn_acceptAll');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '[data-testid="search-results"], .ais-Hits',
    waitMs: 3000,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 6000,
    countries: ['fr', 'be', 'lu', 'ch'],
    headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7' },
  },

  welcometothejungle_company: {
    name: 'WTTJ Company Page',
    baseUrl: 'https://www.welcometothejungle.com/fr/companies',
    type: 'company_database' as const,
    searchParam: '',
    cookieDismiss: `
      const btn = document.querySelector('#axeptio_btn_acceptAll');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '[data-testid="company-card"], .sc-company-header, body',
    waitMs: 3000,
    maxPages: 1,
    delayBetweenPages: 5000,
    countries: ['fr', 'be', 'lu', 'ch'],
    profileType: 'general' as const,
    headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7' },
  },

  freework: {
    name: 'Free-Work',
    baseUrl: 'https://www.free-work.com/fr/tech-it/jobs',
    type: 'job_board',
    searchParam: 'query',
    locationParam: 'locations',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: '.job-card, .listing-item, [class*="JobCard"]',
    waitMs: 2500,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['fr'],
    headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
  },

  linkedin_jobs: {
    name: 'LinkedIn Jobs',
    baseUrl: 'https://www.linkedin.com/jobs/search',
    type: 'job_board',
    searchParam: 'keywords',
    locationParam: 'location',
    cookieDismiss: `
      const btn = document.querySelector('button[action-type="ACCEPT"]');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '.jobs-search__results-list, .base-search-card',
    waitMs: 3500,
    maxPages: 2,
    nextPageParam: 'start',
    nextPageIncrement: 25,
    delayBetweenPages: 12000,
    countries: ['all'],
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },

  glassdoor: {
    name: 'Glassdoor',
    baseUrl: 'https://www.glassdoor.com/Job/jobs.htm',
    type: 'job_board',
    searchParam: 'sc.keyword',
    locationParam: 'locT',
    cookieDismiss: `
      const btn = document.querySelector('#onetrust-accept-btn-handler');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '.JobsList_jobListItem, [data-test="jobListing"]',
    waitMs: 3000,
    maxPages: 2,
    nextPageParam: 'p',
    nextPageIncrement: 1,
    delayBetweenPages: 8000,
    countries: ['us', 'gb', 'ca', 'au'],
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },

  stepstone: {
    name: 'StepStone',
    baseUrl: 'https://www.stepstone.de/jobs',
    type: 'job_board',
    searchParam: '',
    locationParam: 'where',
    cookieDismiss: `
      const btn = document.querySelector('#ccmgt_explicit_accept');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '[data-testid="job-item"], .res-1foik6i',
    waitMs: 3000,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 6000,
    countries: ['de', 'at'],
    headers: { 'Accept-Language': 'de-DE,de;q=0.9' },
  },

  dice: {
    name: 'Dice',
    baseUrl: 'https://www.dice.com/jobs',
    type: 'job_board',
    searchParam: 'q',
    locationParam: 'location',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: '[data-cy="card-title-link"], .search-result-job-title',
    waitMs: 2500,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['us'],
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },

  jobbank_ca: {
    name: 'Job Bank Canada',
    baseUrl: 'https://www.jobbank.gc.ca/jobsearch/jobsearch',
    type: 'job_board',
    searchParam: 'searchstring',
    locationParam: 'locationstring',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: '#ajaxupdateform article, .results-jobs',
    waitMs: 2500,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['ca'],
    headers: { 'Accept-Language': 'en-CA,en;q=0.9,fr-CA;q=0.7' },
  },

  irishjobs: {
    name: 'IrishJobs',
    baseUrl: 'https://www.irishjobs.ie/jobs',
    type: 'job_board',
    searchParam: '',
    locationParam: 'where',
    cookieDismiss: `
      const btn = document.querySelector('#ccmgt_explicit_accept');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '[data-testid="job-item"], .job-result',
    waitMs: 2500,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['ie'],
    headers: { 'Accept-Language': 'en-IE,en;q=0.9' },
  },

  infojobs: {
    name: 'InfoJobs',
    baseUrl: 'https://www.infojobs.net/jobsearch/search-results/list.xhtml',
    type: 'job_board',
    searchParam: '',
    locationParam: 'provinceIds',
    cookieDismiss: `
      const btn = document.querySelector('#didomi-notice-agree-button');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '.ij-OfferCardContent, .offer-list-item',
    waitMs: 2500,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['es'],
    headers: { 'Accept-Language': 'es-ES,es;q=0.9' },
  },

  cvkeskus: {
    name: 'CV Keskus',
    baseUrl: 'https://www.cvkeskus.ee/toopakkumised',
    type: 'job_board',
    searchParam: 'op_otsingusona',
    locationParam: 'op_asukoht',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: '.job-item, .vacancy-list-item',
    waitMs: 2500,
    maxPages: 3,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['ee'],
    headers: { 'Accept-Language': 'et-EE,et;q=0.9,en;q=0.7' },
  },

  // ── Company Databases ────────────────────────────────────────────────────
  societe_com: {
    name: 'Societe.com',
    baseUrl: 'https://www.societe.com/cgi-bin/search',
    type: 'company_database',
    searchParam: 'champs',
    cookieDismiss: `
      const btn = document.querySelector('#didomi-notice-agree-button');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '.results, .resultats, .listing',
    waitMs: 2500,
    maxPages: 2,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 6000,
    countries: ['fr'],
    headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
  },

  uk_companies_house: {
    name: 'UK Companies House',
    baseUrl: 'https://find-and-update.company-information.service.gov.uk/search/companies',
    type: 'company_database',
    searchParam: 'q',
    cookieDismiss: `
      const btn = document.querySelector('button[data-module="cookie-banner-accept"]');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1000));
    `,
    genericCookieFallback: true,
    waitForSelector: '.results-list, #results',
    waitMs: 2000,
    maxPages: 2,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['gb'],
    headers: { 'Accept-Language': 'en-GB,en;q=0.9' },
  },

  northdata: {
    name: 'NorthData',
    baseUrl: 'https://www.northdata.com/_search',
    type: 'company_database',
    searchParam: 'name',
    locationParam: 'country',
    cookieDismiss: `
      const btn = document.querySelector('.cookie-accept, [data-testid="cookie-accept"]');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '.search-result, .result-list',
    waitMs: 2500,
    maxPages: 2,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 6000,
    countries: ['de', 'at', 'ch', 'fr', 'gb', 'es', 'it', 'nl', 'be'],
    headers: { 'Accept-Language': 'en-US,en;q=0.9,de;q=0.8' },
  },

  einforma: {
    name: 'eInforma',
    baseUrl: 'https://www.einforma.com/buscar-empresas',
    type: 'company_database',
    searchParam: 'q',
    locationParam: 'pais',
    cookieDismiss: `
      const btn = document.querySelector('#onetrust-accept-btn-handler');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1500));
    `,
    genericCookieFallback: true,
    waitForSelector: '.result-item, .search-results',
    waitMs: 2500,
    maxPages: 2,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 6000,
    countries: ['es', 'pt'],
    headers: { 'Accept-Language': 'es-ES,es;q=0.9' },
  },

  ariregister: {
    name: 'Estonian Business Register',
    baseUrl: 'https://ariregister.rik.ee/eng/company',
    type: 'company_database',
    searchParam: 'name',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: '.search-results, .company-list',
    waitMs: 2000,
    maxPages: 2,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['ee'],
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },

  // ── Profile Sources (candidate-finder) ──────────────────────────────────
  brave_linkedin_profiles: {
    name: 'Brave LinkedIn Profile Search',
    baseUrl: 'https://search.brave.com/search',
    type: 'job_board',
    searchParam: 'q',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: 'body',
    waitMs: 1500,
    maxPages: 2,
    nextPageParam: 'offset',
    nextPageIncrement: 10,
    delayBetweenPages: 6000,
    countries: ['all'],
    profileType: 'general',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },

  duckduckgo_linkedin_profiles: {
    name: 'DuckDuckGo LinkedIn Profile Search',
    baseUrl: 'https://duckduckgo.com/html/',
    type: 'job_board',
    searchParam: 'q',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: '.results, .result',
    waitMs: 1500,
    maxPages: 2,
    delayBetweenPages: 6000,
    countries: ['all'],
    profileType: 'general',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },

  github_api: {
    name: 'GitHub Users API',
    baseUrl: 'https://api.github.com/search/users',
    type: 'json_api',
    searchParam: 'q',
    cookieDismiss: '',
    genericCookieFallback: false,
    waitForSelector: '',
    waitMs: 0,
    maxPages: 1,
    delayBetweenPages: 7000,
    countries: ['all'],
    profileType: 'developer',
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  },

  stackoverflow_api: {
    name: 'Stack Overflow Users API',
    baseUrl: 'https://api.stackexchange.com/2.3/users',
    type: 'json_api',
    searchParam: 'inname',
    cookieDismiss: '',
    genericCookieFallback: false,
    waitForSelector: '',
    waitMs: 0,
    maxPages: 1,
    delayBetweenPages: 5000,
    countries: ['all'],
    profileType: 'developer',
    headers: { Accept: 'application/json' },
  },

  devto: {
    name: 'Dev.to User Search',
    baseUrl: 'https://dev.to/search',
    type: 'job_board',
    searchParam: 'q',
    cookieDismiss: '',
    genericCookieFallback: true,
    waitForSelector: 'body',
    waitMs: 2500,
    maxPages: 2,
    nextPageParam: 'page',
    nextPageIncrement: 1,
    delayBetweenPages: 5000,
    countries: ['all'],
    profileType: 'developer',
    extraQueryParams: { filters: 'class_name:User' },
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  },
};

/** Country code mapping for sites that require uppercase ISO codes (Einforma, NorthData). */
export const UPPERCASE_COUNTRY_PARAM_SITES = new Set(['einforma', 'northdata']);

/**
 * Reference template showing every field. Not used at runtime — kept here for
 * humans adding new sites manually.
 */
export const SITE_CONFIG_TEMPLATE: SiteConfig = {
  name: 'Example Job Board',
  baseUrl: 'https://example.com/search',
  type: 'job_board',
  searchParam: 'q',
  locationParam: 'location',
  cookieDismiss: '',
  genericCookieFallback: true,
  waitForSelector: '.job-listing',
  waitMs: 2000,
  maxPages: 3,
  nextPageParam: 'page',
  nextPageIncrement: 1,
  delayBetweenPages: 5000,
  countries: ['fr', 'gb'],
  headers: { 'Accept-Language': 'fr-FR,fr;q=0.9' },
};
