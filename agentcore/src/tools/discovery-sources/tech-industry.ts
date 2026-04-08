import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { env } from '../../config/env.js';
import { createRedisConnection } from '../../queues/setup.js';
import { searchDiscovery } from '../searxng.tool.js';
import { scrapeAndExtractCompanies } from './page-scraper.js';
import logger from '../../utils/logger.js';
import type { DiscoveryParams, PeopleDiscoveryParams, RawCompanyResult, RawPersonResult } from './types.js';

const redis: Redis = createRedisConnection();
const githubLimit = pLimit(3);
const searchLimit = pLimit(10);
const SEARCH_DELAY_MS = 200;
const CACHE_TTL_7D = 7 * 24 * 3600;
const GITHUB_RATE_LIMIT_FLOOR = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── GitHub Orgs ─────────────────────────────────────────────────────────────

async function searchGitHubOrgs(query: string): Promise<RawCompanyResult[]> {
  if (!env.GITHUB_TOKEN) return [];

  const cacheKey = `discovery:github:org:${createHash('md5').update(query.toLowerCase()).digest('hex')}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as RawCompanyResult[];
  } catch { /* continue */ }

  try {
    // Check rate limit
    const rlRes = await fetch('https://api.github.com/rate_limit', {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
    });
    if (rlRes.ok) {
      const rl = await rlRes.json() as { resources?: { search?: { remaining?: number } } };
      if ((rl.resources?.search?.remaining ?? 0) < GITHUB_RATE_LIMIT_FLOOR) {
        logger.debug('GitHub rate limit too low for org search');
        return [];
      }
    }

    const searchUrl = `https://api.github.com/search/users?q=${encodeURIComponent(query)}+type:org&per_page=5`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
    });
    if (!searchRes.ok) return [];

    const searchData = await searchRes.json() as { items?: Array<{ login: string; html_url?: string }> };
    const orgs = searchData.items ?? [];

    const results: RawCompanyResult[] = [];

    for (const org of orgs.slice(0, 3)) {
      try {
        const orgRes = await fetch(`https://api.github.com/orgs/${org.login}`, {
          headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
        });
        if (!orgRes.ok) continue;

        const orgData = await orgRes.json() as {
          name?: string;
          login?: string;
          blog?: string;
          description?: string;
          location?: string;
          html_url?: string;
          created_at?: string;
        };

        let domain: string | undefined;
        if (orgData.blog) {
          try {
            domain = new URL(orgData.blog.startsWith('http') ? orgData.blog : `https://${orgData.blog}`).hostname.replace(/^www\./, '');
          } catch { /* ignore */ }
        }

        results.push({
          name: orgData.name ?? orgData.login ?? org.login,
          domain,
          description: orgData.description ?? undefined,
          headquarters: orgData.location ?? undefined,
          foundedYear: orgData.created_at ? parseInt(orgData.created_at.slice(0, 4), 10) || undefined : undefined,
          source: 'github',
          confidence: 70,
          rawData: {
            githubLogin: org.login,
            githubUrl: orgData.html_url,
            blog: orgData.blog,
          },
        });
      } catch (err) {
        logger.debug({ err, org: org.login }, 'Failed to fetch GitHub org details');
      }
    }

    await redis.setex(cacheKey, CACHE_TTL_7D, JSON.stringify(results)).catch(() => {});
    return results;
  } catch (err) {
    logger.debug({ err, query }, 'GitHub org search error');
    return [];
  }
}

// ── GitHub Org Members (for people) ─────────────────────────────────────────

async function searchGitHubOrgMembers(orgLogin: string): Promise<RawPersonResult[]> {
  if (!env.GITHUB_TOKEN) return [];

  try {
    const membersRes = await fetch(`https://api.github.com/orgs/${orgLogin}/public_members?per_page=10`, {
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
    });
    if (!membersRes.ok) return [];

    const members = await membersRes.json() as Array<{ login: string; html_url?: string }>;
    const results: RawPersonResult[] = [];

    for (const member of members.slice(0, 5)) {
      try {
        const userRes = await fetch(`https://api.github.com/users/${member.login}`, {
          headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
        });
        if (!userRes.ok) continue;

        const user = await userRes.json() as {
          name?: string;
          login?: string;
          bio?: string;
          company?: string;
          location?: string;
          email?: string;
          html_url?: string;
          blog?: string;
          twitter_username?: string;
        };

        const nameParts = (user.name ?? '').split(/\s+/);
        results.push({
          firstName: nameParts[0] || undefined,
          lastName: nameParts.slice(1).join(' ') || undefined,
          fullName: user.name || user.login,
          title: user.bio?.slice(0, 100) ?? undefined,
          companyName: user.company?.replace(/^@/, '') ?? undefined,
          email: user.email ?? undefined,
          githubUrl: user.html_url ?? undefined,
          twitterUrl: user.twitter_username ? `https://twitter.com/${user.twitter_username}` : undefined,
          location: user.location ?? undefined,
          source: 'github',
          confidence: 60,
          rawData: { githubLogin: member.login },
        });
      } catch {
        // continue to next member
      }
    }

    return results;
  } catch (err) {
    logger.debug({ err, orgLogin }, 'GitHub org members search error');
    return [];
  }
}

// ── HackerNews (Algolia) ────────────────────────────────────────────────────

async function searchHackerNews(query: string): Promise<RawCompanyResult[]> {
  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=show_hn&hitsPerPage=5`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json() as {
      hits?: Array<{
        title?: string;
        url?: string;
        story_text?: string;
        objectID?: string;
      }>;
    };

    return (data.hits ?? []).map((hit) => {
      let domain: string | undefined;
      if (hit.url) {
        try { domain = new URL(hit.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      }

      return {
        name: hit.title?.replace(/^Show HN:\s*/i, '').split(/[–—\-:]/)[0]?.trim() ?? '',
        domain,
        description: hit.story_text?.slice(0, 200) ?? hit.title ?? undefined,
        source: 'hackernews',
        confidence: 50,
        rawData: { hnUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`, originalUrl: hit.url },
      };
    }).filter((r) => r.name);
  } catch (err) {
    logger.debug({ err, query }, 'HackerNews search error');
    return [];
  }
}

// ── SearXNG-based tech sources ──────────────────────────────────────────────

async function searchStackShare(query: string, tenantId: string): Promise<RawCompanyResult[]> {
  try {
    await sleep(SEARCH_DELAY_MS);
    const results = await searchDiscovery(tenantId, `"${query}" stackshare`, 5);
    return results
      .filter((r) => r.url.includes('stackshare.io'))
      .map((r) => ({
        name: r.title.split(/[|–—\-]/)[0]?.trim() ?? query,
        description: r.snippet.slice(0, 200),
        source: 'stackshare',
        confidence: 55,
        rawData: { url: r.url, snippet: r.snippet },
      }));
  } catch (err) {
    logger.debug({ err, query }, 'StackShare search error');
    return [];
  }
}

async function searchBuiltWith(domain: string, tenantId: string): Promise<RawCompanyResult[]> {
  try {
    await sleep(SEARCH_DELAY_MS);
    const results = await searchDiscovery(tenantId, `"${domain}" builtwith`, 3);
    const techStack: string[] = [];

    for (const r of results) {
      // Extract tech names from snippets
      const techs = r.snippet.match(/(?:using|uses|built with)\s+([A-Za-z0-9.,\s]+)/i);
      if (techs?.[1]) {
        techStack.push(...techs[1].split(',').map((t) => t.trim()).filter(Boolean));
      }
    }

    if (techStack.length === 0) return [];

    return [{
      name: domain,
      domain,
      techStack: [...new Set(techStack)],
      source: 'builtwith',
      confidence: 50,
      rawData: { urls: results.map((r) => r.url) },
    }];
  } catch (err) {
    logger.debug({ err, domain }, 'BuiltWith search error');
    return [];
  }
}

async function searchDevTo(query: string, tenantId: string): Promise<RawCompanyResult[]> {
  try {
    await sleep(SEARCH_DELAY_MS);
    const results = await searchDiscovery(tenantId, `"${query}" dev.to`, 3);
    return results
      .filter((r) => r.url.includes('dev.to'))
      .slice(0, 2)
      .map((r) => ({
        name: query,
        description: r.snippet.slice(0, 200),
        source: 'devto',
        confidence: 40,
        rawData: { url: r.url },
      }));
  } catch (err) {
    logger.debug({ err, query }, 'Dev.to search error');
    return [];
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function searchTechSources(
  params: DiscoveryParams,
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const queryTerms: string[] = [];
  if (params.keywords?.length) queryTerms.push(...params.keywords.slice(0, 3));
  if (params.industry) queryTerms.push(params.industry);
  if (queryTerms.length === 0) return [];

  const allResults: RawCompanyResult[] = [];

  const tasks: Array<Promise<RawCompanyResult[]>> = [];

  // GitHub org search
  for (const term of queryTerms.slice(0, 2)) {
    tasks.push(githubLimit(() => searchGitHubOrgs(term)));
  }

  // HackerNews
  for (const term of queryTerms.slice(0, 2)) {
    tasks.push(searchHackerNews(term));
  }

  // StackShare
  for (const term of queryTerms.slice(0, 2)) {
    tasks.push(searchLimit(() => searchStackShare(term, tenantId)));
  }

  // BuiltWith — only if tech stack is specified
  if (params.techStack?.length) {
    for (const tech of params.techStack.slice(0, 2)) {
      tasks.push(searchLimit(() => searchBuiltWith(tech, tenantId)));
    }
  }

  // Dev.to
  for (const term of queryTerms.slice(0, 1)) {
    tasks.push(searchLimit(() => searchDevTo(term, tenantId)));
  }

  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  return allResults;
}

export async function searchTechSourcesPeople(
  params: PeopleDiscoveryParams,
  tenantId: string,
): Promise<RawPersonResult[]> {
  const results: RawPersonResult[] = [];
  if (!params.companyName) return results;

  // Search GitHub org members
  if (env.GITHUB_TOKEN) {
    try {
      const orgs = await githubLimit(() => searchGitHubOrgs(params.companyName!));
      for (const org of orgs.slice(0, 1)) {
        const login = (org.rawData as Record<string, string>)?.githubLogin;
        if (login) {
          const members = await githubLimit(() => searchGitHubOrgMembers(login));
          for (const m of members) {
            m.companyName = params.companyName;
          }
          results.push(...members);
        }
      }
    } catch (err) {
      logger.debug({ err }, 'GitHub people search failed');
    }
  }

  return results;
}
