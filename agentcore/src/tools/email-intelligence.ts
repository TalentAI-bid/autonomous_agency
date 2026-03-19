import dns from 'dns';
import { eq, and, desc } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db } from '../config/database.js';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import { emailIntelligence, domainPatterns, deliverySignals } from '../db/schema/index.js';
import { search } from './searxng.tool.js';
import { scrape } from './crawl4ai.tool.js';
import { generectEmailTool } from './generect-email.js';
import logger from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EmailResult {
  email: string | null;
  confidence: number;
  method: string | null;
  source: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_30D = 30 * 24 * 3600;
const CACHE_TTL_90D = 90 * 24 * 3600;
const CACHE_TTL_7D = 7 * 24 * 3600;
const CACHE_TTL_1H = 3600;

const SEARXNG_DELAY_MS = 500;
const SEARXNG_MAX_QUERIES = 10;
const CRAWL4AI_MAX_PAGES = 2;
const GITHUB_RATE_LIMIT_FLOOR = 10;

/** Map MX hostname keywords → provider + most likely patterns */
const MX_PATTERN_MAP: Record<string, { provider: string; patterns: string[] }> = {
  'google': { provider: 'google', patterns: ['{first}.{last}', '{first}{last}', '{f}{last}'] },
  'googlemail': { provider: 'google', patterns: ['{first}.{last}', '{first}{last}', '{f}{last}'] },
  'outlook': { provider: 'microsoft', patterns: ['{first}.{last}', '{first}{last}', '{f}{last}'] },
  'microsoft': { provider: 'microsoft', patterns: ['{first}.{last}', '{first}{last}', '{f}{last}'] },
  'zoho': { provider: 'zoho', patterns: ['{first}.{last}', '{first}', '{first}{last}'] },
  'protonmail': { provider: 'protonmail', patterns: ['{first}.{last}', '{first}{last}'] },
  'pphosted': { provider: 'proofpoint', patterns: ['{first}.{last}', '{f}{last}'] },
  'mimecast': { provider: 'mimecast', patterns: ['{first}.{last}', '{f}{last}'] },
};

// Confidence by MX provider (lower = less reliable for guessing)
const MX_PROVIDER_CONFIDENCE: Record<string, number> = {
  google: 45,
  microsoft: 45,
  zoho: 40,
  protonmail: 35,
  proofpoint: 50,
  mimecast: 50,
  custom: 25,
};

// ── Helper functions ─────────────────────────────────────────────────────────

function applyPattern(pattern: string, first: string, last: string, domain: string): string {
  const f = first[0]?.toLowerCase() ?? '';
  const l = last[0]?.toLowerCase() ?? '';
  return pattern
    .replace('{first}', first.toLowerCase())
    .replace('{last}', last.toLowerCase())
    .replace('{f}', f)
    .replace('{l}', l)
    + `@${domain}`;
}

function reverseEngineerPattern(email: string, first: string, last: string, domain: string): string | null {
  const local = email.split('@')[0];
  if (!local) return null;
  const f = first.toLowerCase();
  const l = last.toLowerCase();
  const fi = first[0]?.toLowerCase() ?? '';
  const li = last[0]?.toLowerCase() ?? '';

  const patternMap: Array<[string, string]> = [
    [`${f}.${l}`, '{first}.{last}'],
    [`${f}${l}`, '{first}{last}'],
    [`${fi}${l}`, '{f}{last}'],
    [`${fi}.${l}`, '{f}.{last}'],
    [`${f}`, '{first}'],
    [`${f}${li}`, '{first}{l}'],
    [`${l}.${f}`, '{last}.{first}'],
    [`${l}${f}`, '{last}{first}'],
    [`${l}${fi}`, '{last}{f}'],
  ];

  for (const [localPart, pattern] of patternMap) {
    if (local === localPart) return pattern;
  }
  return null;
}

function extractEmailsFromText(text: string, domain?: string): string[] {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(emailRegex) ?? [];
  const unique = [...new Set(matches.map((e) => e.toLowerCase()))];
  if (domain) {
    return unique.filter((e) => e.endsWith(`@${domain.toLowerCase()}`));
  }
  return unique;
}

function classifyMXProvider(mxHost: string): { provider: string; patterns: string[] } {
  const lower = mxHost.toLowerCase();
  for (const [keyword, info] of Object.entries(MX_PATTERN_MAP)) {
    if (lower.includes(keyword)) return info;
  }
  return { provider: 'custom', patterns: ['{first}.{last}', '{first}{last}', '{f}{last}'] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── EmailIntelligenceEngine ──────────────────────────────────────────────────

class EmailIntelligenceEngine {
  private redis: Redis;

  constructor() {
    this.redis = createRedisConnection();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async findEmail(
    firstName: string,
    lastName: string,
    companyNameOrDomain: string,
    tenantId?: string,
  ): Promise<EmailResult> {
    const first = firstName.trim();
    const last = lastName.trim();
    if (!first || !last || !companyNameOrDomain.trim()) {
      return { email: null, confidence: 0, method: null, source: null };
    }

    // Resolve domain from company name if needed
    const domain = await this.resolveDomain(companyNameOrDomain, tenantId);
    if (!domain) {
      return { email: null, confidence: 0, method: null, source: null };
    }

    const cacheKey = `email:intel:${domain}:${first.toLowerCase()}:${last.toLowerCase()}`;

    // ── Layer 1: Redis cache ─────────────────────────────────────────────────
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug({ first, last, domain }, 'Email found in Redis cache');
        return JSON.parse(cached) as EmailResult;
      }
    } catch (err) {
      logger.debug({ err }, 'Redis cache read failed');
    }

    // ── Layer 2: DB cache ────────────────────────────────────────────────────
    try {
      const [record] = await db
        .select()
        .from(emailIntelligence)
        .where(
          and(
            eq(emailIntelligence.firstName, first.toLowerCase()),
            eq(emailIntelligence.lastName, last.toLowerCase()),
            eq(emailIntelligence.domain, domain),
          ),
        )
        .limit(1);

      if (record && record.confidence > 80 && !record.invalidated) {
        const result: EmailResult = {
          email: record.email,
          confidence: record.confidence,
          method: record.method,
          source: record.source,
        };
        await this.cacheResult(cacheKey, result, CACHE_TTL_30D);
        logger.debug({ first, last, domain }, 'Email found in DB cache');
        return result;
      }
    } catch (err) {
      logger.debug({ err }, 'DB cache read failed');
    }

    // ── Layer 3: Generect API ──────────────────────────────────────────────
    if (generectEmailTool.isConfigured()) {
      try {
        const generectResult = await generectEmailTool.findEmail(first, last, domain);
        if (generectResult.email && generectResult.confidence >= 70) {
          const result: EmailResult = {
            email: generectResult.email,
            confidence: generectResult.confidence,
            method: 'generect',
            source: `generect api (format: ${generectResult.emailFormat ?? 'unknown'})`,
          };
          await this.persistDiscovery(first, last, domain, result);
          await this.cacheResult(cacheKey, result, CACHE_TTL_30D);
          return result;
        }
      } catch (err) {
        logger.debug({ err, first, last, domain }, 'Generect discovery failed');
      }
    }

    // ── Layer 4: SearXNG dorking ─────────────────────────────────────────────
    try {
      const searxResult = await this.searxngDiscovery(first, last, domain, tenantId);
      if (searxResult?.email) {
        const validated = await this.validateViaGenerect(searxResult.email, searxResult);
        if (validated) {
          await this.persistDiscovery(first, last, domain, validated);
          await this.cacheResult(cacheKey, validated, CACHE_TTL_30D);
          return validated;
        }
      }
    } catch (err) {
      logger.debug({ err, first, last, domain }, 'SearXNG discovery failed');
    }

    // ── Layer 5: GitHub commit mining ────────────────────────────────────────
    try {
      const ghResult = await this.githubDiscovery(first, last, domain, companyNameOrDomain);
      if (ghResult?.email) {
        const validated = await this.validateViaGenerect(ghResult.email, ghResult);
        if (validated) {
          await this.persistDiscovery(first, last, domain, validated);
          await this.cacheResult(cacheKey, validated, CACHE_TTL_30D);
          return validated;
        }
      }
    } catch (err) {
      logger.debug({ err, first, last, domain }, 'GitHub discovery failed');
    }

    // ── Layer 6: Known domain pattern ────────────────────────────────────────
    try {
      const patternResult = await this.knownPatternGuess(first, last, domain);
      if (patternResult?.email) {
        const validated = await this.validateViaGenerect(patternResult.email, patternResult);
        if (validated) {
          await this.persistDiscovery(first, last, domain, validated);
          await this.cacheResult(cacheKey, validated, CACHE_TTL_30D);
          return validated;
        }
      }
    } catch (err) {
      logger.debug({ err, first, last, domain }, 'Known pattern guess failed');
    }

    // ── Layer 7: MX-informed guess ───────────────────────────────────────────
    try {
      const mxResult = await this.mxGuess(first, last, domain);
      if (mxResult?.email) {
        const validated = await this.validateViaGenerect(mxResult.email, mxResult);
        if (validated) {
          await this.persistDiscovery(first, last, domain, validated);
          await this.cacheResult(cacheKey, validated, CACHE_TTL_30D);
          return validated;
        }
      }
    } catch (err) {
      logger.debug({ err, first, last, domain }, 'MX guess failed');
    }

    return { email: null, confidence: 0, method: null, source: null };
  }

  async recordDeliverySignal(
    email: string,
    domain: string,
    patternUsed: string | null,
    delivered: boolean,
    bounceType?: 'hard' | 'soft',
    bounceMessage?: string,
  ): Promise<void> {
    const signalType = delivered
      ? 'delivered' as const
      : bounceType === 'hard'
        ? 'bounced_hard' as const
        : 'bounced_soft' as const;

    try {
      // Insert delivery signal
      await db.insert(deliverySignals).values({
        email,
        domain,
        patternUsed,
        signalType,
        bounceMessage: bounceMessage ?? null,
      });

      // Update email_intelligence record
      const [existing] = await db
        .select()
        .from(emailIntelligence)
        .where(eq(emailIntelligence.email, email))
        .limit(1);

      if (existing) {
        if (delivered) {
          await db
            .update(emailIntelligence)
            .set({ verified: true, updatedAt: new Date() })
            .where(eq(emailIntelligence.id, existing.id));
        } else if (bounceType === 'hard') {
          await db
            .update(emailIntelligence)
            .set({ invalidated: true, updatedAt: new Date() })
            .where(eq(emailIntelligence.id, existing.id));
        }
      }

      // Update domain_patterns confidence
      if (patternUsed) {
        const [pattern] = await db
          .select()
          .from(domainPatterns)
          .where(and(eq(domainPatterns.domain, domain), eq(domainPatterns.pattern, patternUsed)))
          .limit(1);

        if (pattern) {
          const newConfirmed = pattern.confirmedCount + (delivered ? 1 : 0);
          const newBounced = pattern.bouncedCount + (delivered ? 0 : 1);
          const total = newConfirmed + newBounced;
          const newConfidence = total > 0 ? Math.round((newConfirmed / total) * 100) : 0;

          await db
            .update(domainPatterns)
            .set({
              confirmedCount: newConfirmed,
              bouncedCount: newBounced,
              confidence: newConfidence,
              updatedAt: new Date(),
            })
            .where(eq(domainPatterns.id, pattern.id));
        }
      }

      // Invalidate Redis caches for this email
      try {
        const firstName = existing?.firstName;
        const lastName = existing?.lastName;
        if (firstName && lastName) {
          await this.redis.del(`email:intel:${domain}:${firstName}:${lastName}`);
        }
        await this.redis.del(`domain:pattern:${domain}`);
      } catch {
        // non-critical
      }
    } catch (err) {
      logger.warn({ err, email, domain, signalType }, 'Failed to record delivery signal');
    }
  }

  // ── Generect validation for fallback layers ──────────────────────────────

  private async validateViaGenerect(email: string, result: EmailResult): Promise<EmailResult | null> {
    if (!generectEmailTool.isConfigured()) {
      // Without Generect, reject low-confidence guesses
      if (result.confidence < 70) return null;
      return result;
    }
    try {
      const validation = await generectEmailTool.validateEmail(email);
      if (validation.valid) {
        return { ...result, confidence: Math.max(result.confidence, 85) };
      }
      if (validation.catchAll) {
        return { ...result, confidence: Math.min(result.confidence, 60) };
      }
      // Invalid — reject
      logger.debug({ email, method: result.method }, 'Email rejected by Generect validation');
      return null;
    } catch (err) {
      logger.debug({ err, email }, 'Generect validation failed, keeping original confidence');
      return result;
    }
  }

  // ── Discovery layers ───────────────────────────────────────────────────────

  private async searxngDiscovery(
    first: string,
    last: string,
    domain: string,
    tenantId?: string,
  ): Promise<EmailResult | null> {
    const tid = tenantId ?? 'global';

    const queries = [
      `"${first} ${last}" "@${domain}" email`,
      `"${first}.${last}@${domain}"`,
      `"${first} ${last}" email ${domain}`,
      `site:${domain} "${first} ${last}" email`,
      `"${first} ${last}" "${domain}" contact`,
      `"${first}.${last}" "${domain}"`,
      `"${first[0]?.toLowerCase() ?? ''}${last.toLowerCase()}@${domain}"`,
      `"${first} ${last}" site:github.com "${domain}"`,
      `"${first} ${last}" site:twitter.com OR site:x.com "${domain}"`,
      `"${first} ${last}" site:linkedin.com "${domain}" email`,
    ];

    let pagesScraped = 0;

    for (let i = 0; i < Math.min(queries.length, SEARXNG_MAX_QUERIES); i++) {
      if (i > 0) await sleep(SEARXNG_DELAY_MS);

      const results = await search(tid, queries[i]!, 5);

      // Check snippets first (cheap)
      for (const r of results) {
        const emails = extractEmailsFromText(r.snippet, domain);
        const match = this.findBestMatch(emails, first, last, domain);
        if (match) {
          return {
            email: match,
            confidence: 90,
            method: 'searxng',
            source: `search snippet: ${r.url}`,
          };
        }
      }

      // Scrape top pages if budget allows
      if (pagesScraped < CRAWL4AI_MAX_PAGES) {
        for (const r of results.slice(0, 2)) {
          if (pagesScraped >= CRAWL4AI_MAX_PAGES) break;
          try {
            const pageContent = await scrape(tid, r.url);
            pagesScraped++;
            const emails = extractEmailsFromText(pageContent, domain);
            const match = this.findBestMatch(emails, first, last, domain);
            if (match) {
              return {
                email: match,
                confidence: 90,
                method: 'searxng',
                source: `scraped page: ${r.url}`,
              };
            }
          } catch {
            // continue
          }
        }
      }
    }

    return null;
  }

  private async githubDiscovery(
    first: string,
    last: string,
    domain: string,
    company: string,
  ): Promise<EmailResult | null> {
    if (!env.GITHUB_TOKEN) return null;

    // Check cached result
    const ghCacheKey = `github:search:${first.toLowerCase()}:${last.toLowerCase()}:${company.toLowerCase()}`;
    try {
      const cached = await this.redis.get(ghCacheKey);
      if (cached === '__none__') return null;
      if (cached) return JSON.parse(cached) as EmailResult;
    } catch {
      // continue
    }

    try {
      // Check rate limit first
      const rlCheck = await fetch('https://api.github.com/rate_limit', {
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
      });
      if (rlCheck.ok) {
        const rlData = await rlCheck.json() as { resources?: { search?: { remaining?: number } } };
        if ((rlData.resources?.search?.remaining ?? 0) < GITHUB_RATE_LIMIT_FLOOR) {
          logger.debug('GitHub search rate limit too low, skipping');
          return null;
        }
      }

      // Search for user
      const userQuery = encodeURIComponent(`${first} ${last} in:name`);
      const userRes = await fetch(`https://api.github.com/search/users?q=${userQuery}&per_page=5`, {
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
      });

      if (!userRes.ok) return null;
      const userData = await userRes.json() as { items?: Array<{ login: string }> };
      const users = userData.items ?? [];

      for (const user of users.slice(0, 3)) {
        // Check public events for PushEvent commits
        try {
          const eventsRes = await fetch(`https://api.github.com/users/${user.login}/events/public?per_page=30`, {
            headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
          });

          if (!eventsRes.ok) continue;
          const events = await eventsRes.json() as Array<{
            type?: string;
            payload?: { commits?: Array<{ author?: { email?: string; name?: string } }> };
          }>;

          for (const event of events) {
            if (event.type !== 'PushEvent') continue;
            for (const commit of event.payload?.commits ?? []) {
              const email = commit.author?.email;
              if (!email) continue;
              if (email.includes('noreply')) continue;
              if (email.endsWith(`@${domain}`)) {
                const result: EmailResult = {
                  email,
                  confidence: 88,
                  method: 'github',
                  source: `github events: ${user.login}`,
                };
                await this.redis.setex(ghCacheKey, CACHE_TTL_7D, JSON.stringify(result));
                return result;
              }
            }
          }
        } catch {
          // continue to next user
        }

        // Check recent repos for commits
        try {
          const reposRes = await fetch(`https://api.github.com/users/${user.login}/repos?sort=updated&per_page=5`, {
            headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' },
          });

          if (!reposRes.ok) continue;
          const repos = await reposRes.json() as Array<{ full_name?: string }>;

          for (const repo of repos.slice(0, 3)) {
            if (!repo.full_name) continue;
            try {
              const commitsRes = await fetch(
                `https://api.github.com/repos/${repo.full_name}/commits?author=${user.login}&per_page=5`,
                { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'agentcore' } },
              );

              if (!commitsRes.ok) continue;
              const commits = await commitsRes.json() as Array<{
                commit?: { author?: { email?: string } };
              }>;

              for (const c of commits) {
                const email = c.commit?.author?.email;
                if (!email) continue;
                if (email.includes('noreply')) continue;
                if (email.endsWith(`@${domain}`)) {
                  const result: EmailResult = {
                    email,
                    confidence: 85,
                    method: 'github',
                    source: `github repo: ${repo.full_name}`,
                  };
                  await this.redis.setex(ghCacheKey, CACHE_TTL_7D, JSON.stringify(result));
                  return result;
                }
              }
            } catch {
              // continue
            }
          }
        } catch {
          // continue
        }
      }

      // Cache negative result
      await this.redis.setex(ghCacheKey, CACHE_TTL_7D, '__none__');
    } catch (err) {
      logger.debug({ err }, 'GitHub discovery error');
    }

    return null;
  }

  private async knownPatternGuess(
    first: string,
    last: string,
    domain: string,
  ): Promise<EmailResult | null> {
    // Check cached patterns
    const patternCacheKey = `domain:pattern:${domain}`;
    let bestPattern: { pattern: string; confidence: number } | null = null;
    let isCatchAll = false;

    try {
      const cached = await this.redis.get(patternCacheKey);
      if (cached) {
        const data = JSON.parse(cached) as { pattern: string; confidence: number; isCatchAll: boolean };
        bestPattern = { pattern: data.pattern, confidence: data.confidence };
        isCatchAll = data.isCatchAll;
      }
    } catch {
      // continue to DB
    }

    if (!bestPattern) {
      try {
        const [record] = await db
          .select()
          .from(domainPatterns)
          .where(eq(domainPatterns.domain, domain))
          .orderBy(desc(domainPatterns.confidence))
          .limit(1);

        if (record) {
          bestPattern = { pattern: record.pattern, confidence: record.confidence };
          isCatchAll = record.isCatchAll;
          await this.redis.setex(
            patternCacheKey,
            CACHE_TTL_90D,
            JSON.stringify({ pattern: record.pattern, confidence: record.confidence, isCatchAll: record.isCatchAll }),
          );
        }
      } catch (err) {
        logger.debug({ err }, 'Known pattern DB query failed');
        return null;
      }
    }

    if (!bestPattern || bestPattern.confidence <= 85 || isCatchAll) return null;

    const email = applyPattern(bestPattern.pattern, first, last, domain);
    return {
      email,
      confidence: Math.min(bestPattern.confidence, 75), // cap at 75 for pattern-only
      method: 'domain_pattern',
      source: `pattern: ${bestPattern.pattern}`,
    };
  }

  private async mxGuess(
    first: string,
    last: string,
    domain: string,
  ): Promise<EmailResult | null> {
    const mxCacheKey = `domain:mx:${domain}`;

    let mxHost: string | null = null;
    try {
      const cached = await this.redis.get(mxCacheKey);
      if (cached === '__none__') return null;
      if (cached) {
        mxHost = cached;
      }
    } catch {
      // continue
    }

    if (!mxHost) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const records = await dns.promises.resolveMx(domain);
        clearTimeout(timeout);
        if (!records.length) {
          await this.redis.setex(mxCacheKey, CACHE_TTL_1H, '__none__');
          return null;
        }
        records.sort((a, b) => a.priority - b.priority);
        mxHost = records[0]!.exchange;
        await this.redis.setex(mxCacheKey, CACHE_TTL_30D, mxHost);
      } catch {
        await this.redis.setex(mxCacheKey, CACHE_TTL_1H, '__none__').catch(() => {});
        return null;
      }
    }

    const { provider, patterns } = classifyMXProvider(mxHost);
    const baseConfidence = MX_PROVIDER_CONFIDENCE[provider] ?? 25;

    // Use first pattern (most likely for the provider)
    const pattern = patterns[0];
    if (!pattern) return null;

    const email = applyPattern(pattern, first, last, domain);
    return {
      email,
      confidence: baseConfidence,
      method: 'mx_guess',
      source: `mx: ${mxHost} (${provider}), pattern: ${pattern}`,
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async resolveDomain(companyNameOrDomain: string, tenantId?: string): Promise<string | null> {
    // If it looks like a domain already, use it
    if (companyNameOrDomain.includes('.') && !companyNameOrDomain.includes(' ')) {
      return companyNameOrDomain.toLowerCase().replace(/^www\./, '');
    }

    // Check cache
    const cacheKey = `company:domain:${companyNameOrDomain.toLowerCase()}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached === '__none__') return null;
      if (cached) return cached;
    } catch {
      // continue
    }

    // Search for company website
    const tid = tenantId ?? 'global';
    try {
      const results = await search(tid, `${companyNameOrDomain} official website`, 5);
      const url = results.find(
        (r) =>
          r.url.startsWith('https://') &&
          !r.url.includes('linkedin.com') &&
          !r.url.includes('facebook.com') &&
          !r.url.includes('glassdoor.com') &&
          !r.url.includes('indeed.com'),
      )?.url;

      if (url) {
        try {
          const domain = new URL(url).hostname.replace(/^www\./, '');
          await this.redis.setex(cacheKey, CACHE_TTL_30D, domain);
          return domain;
        } catch {
          // invalid URL
        }
      }
    } catch (err) {
      logger.debug({ err, company: companyNameOrDomain }, 'Domain resolution search failed');
    }

    await this.redis.setex(cacheKey, CACHE_TTL_1H, '__none__').catch(() => {});
    return null;
  }

  private findBestMatch(emails: string[], first: string, last: string, domain: string): string | null {
    if (emails.length === 0) return null;
    const f = first.toLowerCase();
    const l = last.toLowerCase();

    // Priority: exact full name match > first initial + last > first only > any domain match
    for (const email of emails) {
      const local = email.split('@')[0] ?? '';
      if (local.includes(f) && local.includes(l)) return email;
    }
    for (const email of emails) {
      const local = email.split('@')[0] ?? '';
      const fi = f[0] ?? '';
      if (fi && local.startsWith(fi) && local.includes(l)) return email;
    }
    for (const email of emails) {
      const local = email.split('@')[0] ?? '';
      if (local.includes(f)) return email;
    }

    // Return first domain-matching email as fallback
    return emails.find((e) => e.endsWith(`@${domain}`)) ?? null;
  }

  private async persistDiscovery(
    first: string,
    last: string,
    domain: string,
    result: EmailResult,
  ): Promise<void> {
    if (!result.email) return;

    try {
      // Upsert into email_intelligence
      const existing = await db
        .select()
        .from(emailIntelligence)
        .where(
          and(
            eq(emailIntelligence.firstName, first.toLowerCase()),
            eq(emailIntelligence.lastName, last.toLowerCase()),
            eq(emailIntelligence.domain, domain),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        // Update if new result has higher confidence
        if (result.confidence > (existing[0]!.confidence ?? 0)) {
          await db
            .update(emailIntelligence)
            .set({
              email: result.email,
              confidence: result.confidence,
              method: result.method as 'generect' | 'searxng' | 'github' | 'domain_pattern' | 'mx_guess' | 'manual' | 'crawl' | null,
              source: result.source,
              invalidated: false,
              updatedAt: new Date(),
            })
            .where(eq(emailIntelligence.id, existing[0]!.id));
        }
      } else {
        await db.insert(emailIntelligence).values({
          email: result.email,
          firstName: first.toLowerCase(),
          lastName: last.toLowerCase(),
          domain,
          confidence: result.confidence,
          method: result.method as 'generect' | 'searxng' | 'github' | 'domain_pattern' | 'mx_guess' | 'manual' | 'crawl' | null,
          source: result.source,
        });
      }

      // Learn domain pattern
      await this.learnDomainPattern(result.email, first, last, domain);
    } catch (err) {
      logger.debug({ err, email: result.email }, 'Failed to persist email discovery');
    }
  }

  private async learnDomainPattern(
    email: string,
    first: string,
    last: string,
    domain: string,
  ): Promise<void> {
    const pattern = reverseEngineerPattern(email, first, last, domain);
    if (!pattern) return;

    try {
      const [existing] = await db
        .select()
        .from(domainPatterns)
        .where(and(eq(domainPatterns.domain, domain), eq(domainPatterns.pattern, pattern)))
        .limit(1);

      if (existing) {
        const newConfirmed = existing.confirmedCount + 1;
        const total = newConfirmed + existing.bouncedCount;
        const newConfidence = Math.round((newConfirmed / total) * 100);
        await db
          .update(domainPatterns)
          .set({ confirmedCount: newConfirmed, confidence: newConfidence, updatedAt: new Date() })
          .where(eq(domainPatterns.id, existing.id));
      } else {
        await db.insert(domainPatterns).values({
          domain,
          pattern,
          confidence: 50, // initial confidence for first observation
          confirmedCount: 1,
          bouncedCount: 0,
        });
      }

      // Invalidate pattern cache
      await this.redis.del(`domain:pattern:${domain}`).catch(() => {});
    } catch (err) {
      logger.debug({ err, domain, pattern }, 'Failed to learn domain pattern');
    }
  }

  private async cacheResult(key: string, result: EmailResult, ttl: number): Promise<void> {
    try {
      await this.redis.setex(key, ttl, JSON.stringify(result));
    } catch {
      // non-critical
    }
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const emailIntelligenceEngine = new EmailIntelligenceEngine();
