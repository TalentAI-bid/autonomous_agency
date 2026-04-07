import { eq, and, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { db, withTenant } from '../config/database.js';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import { emailIntelligence, domainPatterns, deliverySignals, companies } from '../db/schema/index.js';
import { search } from './searxng.tool.js';
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
const CACHE_TTL_1H = 3600;

// ── Helper functions ─────────────────────────────────────────────────────────

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

// ── EmailIntelligenceEngine ──────────────────────────────────────────────────

class EmailIntelligenceEngine {
  private redis: Redis;

  constructor() {
    this.redis = createRedisConnection();

    if (!env.GENERECT_API_KEY) {
      logger.warn('GENERECT_API_KEY is not set — email discovery will return null for all lookups');
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async findEmail(
    firstName: string,
    lastName: string,
    companyNameOrDomain: string,
    tenantId?: string,
    companyId?: string,
  ): Promise<EmailResult> {
    if (!env.GENERECT_API_KEY) {
      return { email: null, confidence: 0, method: null, source: null };
    }

    const first = firstName.trim();
    const last = lastName.trim();
    if (!first || !last || !companyNameOrDomain.trim()) {
      return { email: null, confidence: 0, method: null, source: null };
    }

    // Resolve domain from company name if needed
    const domain = await this.resolveDomain(companyNameOrDomain, tenantId, companyId);
    if (!domain) {
      return { email: null, confidence: 0, method: null, source: null };
    }

    const cacheKey = `email:intel:${domain}:${first.toLowerCase()}:${last.toLowerCase()}`;

    // Check Redis cache for previous Generect result
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug({ first, last, domain }, 'Email found in Redis cache');
        return JSON.parse(cached) as EmailResult;
      }
    } catch (err) {
      logger.debug({ err }, 'Redis cache read failed');
    }

    // Call Generect API (sole source of truth)
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

    // No fallback — return null
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

  // ── Internal helpers ───────────────────────────────────────────────────────

  private async resolveDomain(
    companyNameOrDomain: string,
    tenantId?: string,
    companyId?: string,
  ): Promise<string | null> {
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

    // Search for company website via SearXNG
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

          // Persist resolved domain back to companies table when missing,
          // so subsequent contacts at the same company skip SearXNG resolution.
          if (companyId && tenantId) {
            try {
              await withTenant(tenantId, async (tx) => {
                await tx
                  .update(companies)
                  .set({ domain, updatedAt: new Date() })
                  .where(and(eq(companies.id, companyId), isNull(companies.domain)));
              });
              logger.debug({ companyId, domain }, 'Persisted resolved company domain');
            } catch (err) {
              logger.debug({ err, companyId, domain }, 'Failed to persist resolved company domain (non-critical)');
            }
          }

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
              method: result.method as 'generect' | 'searxng' | 'github' | 'manual' | 'crawl' | null,
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
          method: result.method as 'generect' | 'searxng' | 'github' | 'manual' | 'crawl' | null,
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
