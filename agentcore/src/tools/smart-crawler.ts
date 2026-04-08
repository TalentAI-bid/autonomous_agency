/**
 * Smart Crawler — the replacement for SearXNG-based discovery.
 *
 * Wraps the Crawl4AI HTTP endpoint with a richer request body (browser_config
 * + crawler_config), per-domain rate limiting, and three helpers:
 *
 *   - crawlPage(url, config)              : direct page scrape with SiteConfig
 *   - crawlSite(siteKey, keywords, loc?)  : multi-keyword, multi-page site walk
 *   - fetchJsonApi(config, keywords)      : straight JSON API fetch (RemoteOK, etc.)
 *   - crawlGoogleAndExtractUrls(...)      : Google→Brave→DuckDuckGo fallback chain
 *                                           with LLM-based URL extraction
 *
 * Rate limiting lives in-process (per worker process). Acceptable for the
 * current single-worker-process deployment; see TODO(scale) note below.
 */

import { env } from '../config/env.js';
import {
  SITE_CONFIGS,
  GENERIC_COOKIE_DISMISS,
  UPPERCASE_COUNTRY_PARAM_SITES,
  type SiteConfig,
} from '../config/site-configs.js';
import logger from '../utils/logger.js';
import { extractJSON } from './together-ai.tool.js';
import * as urlPrompt from '../prompts/url-extraction.prompt.js';
import { isJunkUrl } from '../utils/domain-blocklist.js';

// ── In-process rate limiter ────────────────────────────────────────────────
// TODO(scale): swap to Redis INCR + EXPIRE when scaling to multiple worker processes.
const domainLastRequest = new Map<string, number>();
const hourlyCount = { count: 0, resetAt: Date.now() + 3_600_000 };
const MAX_REQUESTS_PER_HOUR = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tickHourlyWindow(): void {
  if (Date.now() >= hourlyCount.resetAt) {
    hourlyCount.count = 0;
    hourlyCount.resetAt = Date.now() + 3_600_000;
  }
}

// ── Generic configs for ad-hoc crawls ──────────────────────────────────────

/** Plain GET of an arbitrary URL with generic cookie dismissal, no site-specific selectors. */
export const GENERIC_DIRECT_CONFIG: SiteConfig = {
  name: 'Generic Direct',
  baseUrl: '',
  type: 'job_board',
  searchParam: '',
  cookieDismiss: '',
  genericCookieFallback: true,
  waitForSelector: 'body',
  waitMs: 1500,
  maxPages: 1,
  delayBetweenPages: 2000,
  countries: ['all'],
};

/** LinkedIn scraping — much slower per-domain delay to avoid bot detection. */
export const GENERIC_LINKEDIN_CONFIG: SiteConfig = {
  ...GENERIC_DIRECT_CONFIG,
  name: 'LinkedIn',
  delayBetweenPages: 10000,
};

/** Google SERP — wait for result container, 5s per-domain delay. */
const GENERIC_GOOGLE_CONFIG: SiteConfig = {
  name: 'Google Search',
  baseUrl: 'https://www.google.com/search',
  type: 'job_board',
  searchParam: 'q',
  cookieDismiss: '',
  genericCookieFallback: true,
  waitForSelector: 'div#search, div#rso, div#main',
  waitMs: 1500,
  maxPages: 1,
  delayBetweenPages: 5000,
  countries: ['all'],
};

/** Brave Search fallback. */
const GENERIC_BRAVE_CONFIG: SiteConfig = {
  name: 'Brave Search',
  baseUrl: 'https://search.brave.com/search',
  type: 'job_board',
  searchParam: 'q',
  cookieDismiss: '',
  genericCookieFallback: true,
  waitForSelector: '#results, .snippet',
  waitMs: 1500,
  maxPages: 1,
  delayBetweenPages: 5000,
  countries: ['all'],
};

/** DuckDuckGo fallback. */
const GENERIC_DUCKDUCKGO_CONFIG: SiteConfig = {
  name: 'DuckDuckGo',
  baseUrl: 'https://duckduckgo.com/',
  type: 'job_board',
  searchParam: 'q',
  cookieDismiss: '',
  genericCookieFallback: true,
  waitForSelector: '#web_content_wrapper, .results, [data-testid="result"]',
  waitMs: 1500,
  maxPages: 1,
  delayBetweenPages: 5000,
  countries: ['all'],
};

// ── crawlPage ──────────────────────────────────────────────────────────────

/**
 * Crawl a single URL with Crawl4AI using the supplied SiteConfig. Enforces
 * per-domain delay and the hourly request cap. Returns markdown (or empty
 * string on failure / minimal content).
 */
export async function crawlPage(url: string, config: SiteConfig): Promise<string> {
  // 1. Per-domain delay (concurrency-safe via reservation slot pattern)
  let domain: string;
  try {
    domain = new URL(url).hostname;
  } catch {
    logger.warn({ url }, 'smart-crawler: invalid URL passed to crawlPage');
    return '';
  }
  const now = Date.now();
  const lastReq = domainLastRequest.get(domain) ?? 0;
  // Reserve the next available slot BEFORE awaiting sleep so concurrent callers
  // see the updated timestamp and queue behind us instead of racing through.
  const nextSlot = Math.max(now, lastReq + config.delayBetweenPages);
  domainLastRequest.set(domain, nextSlot);
  if (nextSlot > now) {
    await sleep(nextSlot - now);
  }

  // 2. Hourly cap
  tickHourlyWindow();
  if (hourlyCount.count >= MAX_REQUESTS_PER_HOUR) {
    logger.warn({ hourlyCount: hourlyCount.count }, 'smart-crawler: hourly limit reached, pausing 60s');
    await sleep(60_000);
    hourlyCount.count = 0;
    hourlyCount.resetAt = Date.now() + 3_600_000;
  }
  hourlyCount.count++;

  // 3. Build cookie-dismiss JS
  let jsCode = config.cookieDismiss || '';
  if (config.genericCookieFallback) {
    jsCode += '\n;' + GENERIC_COOKIE_DISMISS;
  }

  // 4. POST to Crawl4AI
  try {
    const response = await fetch(env.CRAWL4AI_URL + '/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        urls: [url],
        browser_config: {
          headless: true,
          java_script_enabled: true,
          user_agent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          headers: config.headers ?? {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
          },
        },
        crawler_config: {
          page_timeout: 60_000,
          wait_for_selector: config.waitForSelector,
          js_code: jsCode,
          remove_overlay_elements: true,
          word_count_threshold: 50,
        },
      }),
    });

    if (!response.ok) {
      logger.warn({ url, status: response.status }, 'smart-crawler: Crawl4AI returned non-OK status');
      return '';
    }

    const data = (await response.json()) as {
      results?: Array<{
        markdown?: string | { raw_markdown?: string };
        cleaned_html?: string;
        html?: string;
      }>;
    };

    const first = data?.results?.[0];
    const md = first?.markdown;
    const markdownText = typeof md === 'string' ? md : md?.raw_markdown ?? '';
    const content = markdownText || first?.cleaned_html || first?.html || '';

    if (!content || content.length < 200) {
      logger.warn({ url, len: content.length }, 'smart-crawler: minimal content');
      return '';
    }

    logger.info({ url, len: content.length }, 'smart-crawler: page crawled successfully');
    return content;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), url },
      'smart-crawler: crawlPage failed',
    );
    return '';
  }
}

// ── crawlSite ──────────────────────────────────────────────────────────────

/**
 * Crawl a known site from the SITE_CONFIGS registry using one or more keywords.
 * Handles pagination, path-based keyword injection (when `searchParam === ''`),
 * and country param casing.
 */
export async function crawlSite(
  siteKey: string,
  keywords: string[],
  location?: string,
): Promise<Array<{ url: string; content: string }>> {
  const config = SITE_CONFIGS[siteKey];
  if (!config) {
    logger.error({ siteKey }, 'smart-crawler: unknown site key');
    return [];
  }
  if (config.type === 'json_api') {
    return fetchJsonApi(config, keywords);
  }

  const results: Array<{ url: string; content: string }> = [];

  for (const keyword of keywords) {
    for (let page = 1; page <= config.maxPages; page++) {
      const url = buildSiteUrl(siteKey, config, keyword, location, page);
      const content = await crawlPage(url, config);
      if (content) {
        results.push({ url, content });
      } else {
        // Empty page → assume end of pagination for this keyword
        break;
      }
    }
  }

  return results;
}

/** Build the fully-formed URL for a given site + keyword + location + page. */
function buildSiteUrl(
  siteKey: string,
  config: SiteConfig,
  keyword: string,
  location: string | undefined,
  page: number,
): string {
  const params = new URLSearchParams();

  // Path-based search (searchParam === '') — append keyword to URL path
  let baseUrl = config.baseUrl;
  if (!config.searchParam) {
    const slug = encodeURIComponent(keyword.trim().toLowerCase().replace(/\s+/g, '-'));
    baseUrl = `${config.baseUrl.replace(/\/$/, '')}/${slug}`;
  } else {
    params.set(config.searchParam, keyword);
  }

  // Location
  if (location && config.locationParam) {
    const loc = UPPERCASE_COUNTRY_PARAM_SITES.has(siteKey) ? location.toUpperCase() : location;
    params.set(config.locationParam, loc);
  }

  // Pagination
  if (page > 1 && config.nextPageParam) {
    const pageValue = config.nextPageIncrement ? (page - 1) * config.nextPageIncrement : page;
    params.set(config.nextPageParam, String(pageValue));
  }

  // Static extra query params (e.g., dev.to ?filters=class_name:User)
  if (config.extraQueryParams) {
    for (const [k, v] of Object.entries(config.extraQueryParams)) {
      params.set(k, v);
    }
  }

  const qs = params.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

// ── JSON API helpers ───────────────────────────────────────────────────────

/**
 * Apply per-domain delay + hourly cap for a given domain, mirroring the
 * reservation-slot pattern used inside crawlPage.
 */
async function respectDomainRate(domain: string, delayMs: number): Promise<void> {
  const now = Date.now();
  const lastReq = domainLastRequest.get(domain) ?? 0;
  const nextSlot = Math.max(now, lastReq + delayMs);
  domainLastRequest.set(domain, nextSlot);
  if (nextSlot > now) {
    await sleep(nextSlot - now);
  }
  tickHourlyWindow();
  if (hourlyCount.count >= MAX_REQUESTS_PER_HOUR) {
    logger.warn(
      { hourlyCount: hourlyCount.count, domain },
      'smart-crawler: hourly limit reached, pausing 60s',
    );
    await sleep(60_000);
    hourlyCount.count = 0;
    hourlyCount.resetAt = Date.now() + 3_600_000;
  }
  hourlyCount.count++;
}

/**
 * Fetch GitHub users via the Search API. One request per keyword.
 * - Detects language keywords (simple token) and builds `q={kw}+language:{kw}`
 *   so purely-language missions (`javascript`, `rust`) get stronger signal.
 * - Slices results to 10 per keyword to stay within the unauthenticated rate
 *   limit (10 req/min). With a token the limit rises to 30/min, but we still
 *   cap at 10 to keep the extraction prompt compact.
 * - Uses `Authorization: Bearer ${GITHUB_TOKEN}` when the env var is set.
 */
async function fetchGitHubUsers(
  config: SiteConfig,
  keywords: string[],
): Promise<Array<{ url: string; content: string }>> {
  const results: Array<{ url: string; content: string }> = [];
  const domain = 'api.github.com';

  for (const rawKeyword of keywords) {
    const keyword = (rawKeyword || '').trim();
    if (!keyword) continue;

    // Build query: if keyword is a simple language token, scope by language
    const isLangToken = /^[a-z+#.\-]+$/i.test(keyword) && keyword.length <= 15;
    const q = isLangToken ? `language:${keyword}` : keyword;
    const requestUrl = `${config.baseUrl}?q=${encodeURIComponent(q)}&per_page=30`;

    await respectDomainRate(domain, config.delayBetweenPages);

    const headers: Record<string, string> = {
      ...(config.headers ?? { Accept: 'application/vnd.github+json' }),
    };
    if (env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    }

    try {
      const response = await fetch(requestUrl, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, keyword, siteKey: config.name },
          'smart-crawler: GitHub API fetch failed',
        );
        continue;
      }
      const json = (await response.json()) as { items?: unknown[] };
      const items = Array.isArray(json.items) ? json.items.slice(0, 10) : [];
      if (items.length === 0) {
        logger.info({ keyword }, 'smart-crawler: GitHub API returned no items');
        continue;
      }
      results.push({
        url: requestUrl,
        content: JSON.stringify({ items }),
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), keyword },
        'smart-crawler: GitHub API fetch error',
      );
    }
  }

  return results;
}

/**
 * Fetch Stack Overflow users via the Stack Exchange API.
 *
 * Two-step primary path (tag top-answerers):
 *   Step 1: GET /tags/{keyword}/top-answerers/all_time?site=stackoverflow&pagesize=20
 *   Fallback if Step 1 returns 0 items: GET /users?order=desc&sort=reputation&site=stackoverflow&pagesize=20&inname={keyword}
 *   Step 2: GET /users/{ids}?site=stackoverflow&filter=!nOedRLbqzB
 *     (the !nOedRLbqzB filter exposes about_me, link, location, website_url)
 *
 * One synthetic {url, content} record returned per keyword (the enriched
 * Step 2 payload).
 */
async function fetchStackOverflowUsers(
  config: SiteConfig,
  keywords: string[],
): Promise<Array<{ url: string; content: string }>> {
  const results: Array<{ url: string; content: string }> = [];
  const domain = 'api.stackexchange.com';

  for (const rawKeyword of keywords) {
    const keyword = (rawKeyword || '').trim();
    if (!keyword) continue;

    // Step 1 (primary): tag top-answerers
    const tag = encodeURIComponent(keyword.toLowerCase());
    const step1Url = `https://api.stackexchange.com/2.3/tags/${tag}/top-answerers/all_time?site=stackoverflow&pagesize=20`;

    await respectDomainRate(domain, config.delayBetweenPages);

    let userIds: number[] = [];
    try {
      const r1 = await fetch(step1Url, {
        headers: config.headers ?? { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (r1.ok) {
        const j1 = (await r1.json()) as { items?: Array<{ user?: { user_id?: number } }> };
        userIds = (j1.items ?? [])
          .map((i) => i.user?.user_id)
          .filter((id): id is number => typeof id === 'number');
      } else {
        logger.info(
          { keyword, status: r1.status },
          'smart-crawler: SO tag top-answerers non-OK, will try name fallback',
        );
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), keyword },
        'smart-crawler: SO tag top-answerers error',
      );
    }

    // Fallback: name search
    if (userIds.length === 0) {
      const fallbackUrl = `https://api.stackexchange.com/2.3/users?order=desc&sort=reputation&site=stackoverflow&pagesize=20&inname=${encodeURIComponent(keyword)}`;
      await respectDomainRate(domain, config.delayBetweenPages);
      try {
        const rFb = await fetch(fallbackUrl, {
          headers: config.headers ?? { Accept: 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });
        if (rFb.ok) {
          const jFb = (await rFb.json()) as { items?: Array<{ user_id?: number }> };
          userIds = (jFb.items ?? [])
            .map((u) => u.user_id)
            .filter((id): id is number => typeof id === 'number');
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err), keyword },
          'smart-crawler: SO inname fallback error',
        );
      }
    }

    if (userIds.length === 0) {
      logger.info({ keyword }, 'smart-crawler: SO returned no user ids after both paths');
      continue;
    }

    // Step 2: enrich via filter=!nOedRLbqzB
    const ids = userIds.slice(0, 20).join(';');
    const step2Url = `https://api.stackexchange.com/2.3/users/${ids}?site=stackoverflow&filter=!nOedRLbqzB`;
    await respectDomainRate(domain, config.delayBetweenPages);

    try {
      const r2 = await fetch(step2Url, {
        headers: config.headers ?? { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r2.ok) {
        logger.warn(
          { status: r2.status, keyword },
          'smart-crawler: SO user enrichment non-OK',
        );
        continue;
      }
      const j2 = (await r2.json()) as unknown;
      results.push({ url: step2Url, content: JSON.stringify(j2) });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), keyword },
        'smart-crawler: SO enrichment error',
      );
    }
  }

  return results;
}

// ── fetchJsonApi ───────────────────────────────────────────────────────────

/**
 * Fetch a JSON API endpoint. Dispatches to per-host handlers when we know
 * the shape (GitHub, Stack Exchange). Otherwise returns a single raw JSON
 * payload for downstream LLM extraction.
 */
export async function fetchJsonApi(
  config: SiteConfig,
  keywords: string[],
): Promise<Array<{ url: string; content: string }>> {
  let host: string;
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    return [];
  }

  if (host === 'api.github.com') return fetchGitHubUsers(config, keywords);
  if (host === 'api.stackexchange.com') return fetchStackOverflowUsers(config, keywords);

  // Generic raw-JSON fetch (e.g., RemoteOK)
  await respectDomainRate(host, config.delayBetweenPages);
  try {
    const response = await fetch(config.baseUrl, {
      headers: config.headers ?? { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      logger.warn({ siteKey: config.name, status: response.status }, 'smart-crawler: JSON API fetch failed');
      return [];
    }
    const json = (await response.json()) as unknown;
    return [{ url: config.baseUrl, content: JSON.stringify(json) }];
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), siteKey: config.name },
      'smart-crawler: JSON API fetch error',
    );
    return [];
  }
}

// ── crawlGoogleAndExtractUrls ──────────────────────────────────────────────

type Engine = 'google' | 'brave' | 'duckduckgo' | 'none';

const CAPTCHA_MARKERS = ['unusual traffic', 'sorry/index', 'captcha', 'enablejs', 'cf-challenge'];

function looksBlocked(markdown: string): boolean {
  if (!markdown || markdown.length < 500) return true;
  const lower = markdown.toLowerCase();
  return CAPTCHA_MARKERS.some((m) => lower.includes(m));
}

/** Unwrap a Google redirect URL (https://www.google.com/url?q=<real>&...) to the canonical form. */
function unwrapGoogleRedirect(url: string): string {
  try {
    if (!url.includes('google.com/url')) return url;
    const parsed = new URL(url);
    const q = parsed.searchParams.get('q');
    return q ?? url;
  } catch {
    return url;
  }
}

/**
 * Search via Google → Brave → DuckDuckGo, then ask the LLM to extract URLs
 * matching the intent. Returns the surviving list plus which engine answered.
 *
 * Anti-hallucination: after LLM extraction we require `markdown.includes(url)`
 * for each URL, and drop any failing isJunkUrl().
 */
export async function crawlGoogleAndExtractUrls(
  tenantId: string,
  query: string,
  intent: urlPrompt.UrlExtractionIntent,
  hints: { companyName?: string; personName?: string } = {},
): Promise<{ urls: urlPrompt.ExtractedUrl[]; engine: Engine }> {
  if (!query || query.trim().length < 3) return { urls: [], engine: 'none' };

  const encoded = encodeURIComponent(query);
  const targets: Array<{ engine: Engine; url: string; config: SiteConfig }> = [
    { engine: 'google', url: `https://www.google.com/search?q=${encoded}`, config: GENERIC_GOOGLE_CONFIG },
    { engine: 'brave', url: `https://search.brave.com/search?q=${encoded}`, config: GENERIC_BRAVE_CONFIG },
    { engine: 'duckduckgo', url: `https://duckduckgo.com/?q=${encoded}`, config: GENERIC_DUCKDUCKGO_CONFIG },
  ];

  for (const target of targets) {
    const markdown = await crawlPage(target.url, target.config);
    if (looksBlocked(markdown)) {
      logger.info({ engine: target.engine, query }, 'smart-crawler: SERP blocked/empty, falling through');
      continue;
    }

    // LLM URL extraction
    let extracted: urlPrompt.ExtractedUrlList;
    try {
      extracted = await extractJSON<urlPrompt.ExtractedUrlList>(
        tenantId,
        [
          { role: 'system', content: urlPrompt.buildSystemPrompt(intent) },
          {
            role: 'user',
            content: urlPrompt.buildUserPrompt({
              markdown,
              intent,
              companyName: hints.companyName,
              personName: hints.personName,
            }),
          },
        ],
        2,
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), engine: target.engine, query },
        'smart-crawler: LLM URL extraction failed',
      );
      continue;
    }

    const raw = Array.isArray(extracted?.urls) ? extracted.urls : [];
    const filtered = raw
      .map((u) => ({ ...u, url: unwrapGoogleRedirect(u.url) }))
      .filter((u) => {
        if (!u.url) return false;
        // Anti-hallucination: the canonical URL (or the wrapped form) must be in the markdown
        const inMarkdown =
          markdown.includes(u.url) ||
          markdown.includes(encodeURIComponent(u.url));
        if (!inMarkdown) return false;
        if (isJunkUrl(u.url)) return false;
        return true;
      });

    if (filtered.length > 0) {
      logger.info(
        { engine: target.engine, query, intent, urlCount: filtered.length },
        'smart-crawler: SERP extraction succeeded',
      );
      return { urls: filtered, engine: target.engine };
    }
  }

  return { urls: [], engine: 'none' };
}
