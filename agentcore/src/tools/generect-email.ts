import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { createRedisConnection } from '../queues/setup.js';
import logger from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GenerectEmailResult {
  email: string | null;
  confidence: number;        // 95 (verified), 70 (catch-all), 0 (not found)
  catchAll: boolean;
  emailFormat: string | null; // 'flast', 'first.last', etc.
  mxDomain: string | null;
  error: string | null;
}

interface GenerectFindResponse {
  result?: string;     // 'valid', 'invalid', 'unknown'
  exist?: string;      // 'yes', 'no', 'unknown'
  email?: string;
  email_format?: string;
  mx_domain?: string;
  catch_all?: boolean;
  error?: string;
}

interface GenerectValidateResponse {
  result?: string;     // 'valid', 'invalid', 'unknown'
  exist?: string;
  email?: string;
  catch_all?: boolean;
  mx_domain?: string;
  error?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CACHE_TTL_30D = 30 * 24 * 3600;
const BATCH_CHUNK_SIZE = 50;
const API_BASE = 'https://api.generect.com/api/linkedin';

// ── GenerectEmailTool ────────────────────────────────────────────────────────

const redis: Redis = createRedisConnection();

class GenerectEmailTool {
  isConfigured(): boolean {
    return !!env.GENERECT_API_KEY;
  }

  private get apiKey(): string {
    return env.GENERECT_API_KEY ?? '';
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Authorization': `Token ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  // ── Find single email ───────────────────────────────────────────────────

  async findEmail(firstName: string, lastName: string, domain: string): Promise<GenerectEmailResult> {
    const first = firstName.trim().toLowerCase();
    const last = lastName.trim().toLowerCase();
    const cacheKey = `generect:find:${domain}:${first}:${last}`;

    // Check Redis cache
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug({ first, last, domain }, 'Generect result from cache');
        return JSON.parse(cached) as GenerectEmailResult;
      }
    } catch {
      // continue
    }

    // Call Generect API
    try {
      const res = await fetch(`${API_BASE}/email_finder/`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          domain,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Generect API ${res.status}: ${text}`);
      }

      const data = await res.json() as GenerectFindResponse;
      const result = this.mapFindResult(data);

      // Cache result (including negatives to avoid re-paying)
      await redis.setex(cacheKey, CACHE_TTL_30D, JSON.stringify(result)).catch(() => {});

      return result;
    } catch (err) {
      logger.warn({ err, first, last, domain }, 'Generect findEmail failed');
      return {
        email: null,
        confidence: 0,
        catchAll: false,
        emailFormat: null,
        mxDomain: null,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  // ── Find emails batch ───────────────────────────────────────────────────

  async findEmailsBatch(
    contacts: Array<{ firstName: string; lastName: string; domain: string }>,
  ): Promise<GenerectEmailResult[]> {
    const results: GenerectEmailResult[] = new Array(contacts.length);
    const uncachedIndices: number[] = [];

    // Check cache for each contact
    await Promise.all(
      contacts.map(async (c, i) => {
        const first = c.firstName.trim().toLowerCase();
        const last = c.lastName.trim().toLowerCase();
        const cacheKey = `generect:find:${c.domain}:${first}:${last}`;
        try {
          const cached = await redis.get(cacheKey);
          if (cached) {
            results[i] = JSON.parse(cached) as GenerectEmailResult;
            return;
          }
        } catch {
          // continue
        }
        uncachedIndices.push(i);
      }),
    );

    // Process uncached in chunks
    for (let start = 0; start < uncachedIndices.length; start += BATCH_CHUNK_SIZE) {
      const chunkIndices = uncachedIndices.slice(start, start + BATCH_CHUNK_SIZE);
      const chunkContacts = chunkIndices.map((i) => contacts[i]!);

      try {
        const res = await fetch(`${API_BASE}/email_finder/`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(
            chunkContacts.map((c) => ({
              first_name: c.firstName.trim(),
              last_name: c.lastName.trim(),
              domain: c.domain,
            })),
          ),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          logger.warn({ status: res.status, text }, 'Generect batch API error');
          // Fill with errors
          for (const idx of chunkIndices) {
            results[idx] = {
              email: null, confidence: 0, catchAll: false,
              emailFormat: null, mxDomain: null, error: `API ${res.status}`,
            };
          }
          continue;
        }

        const data = await res.json() as GenerectFindResponse[];
        const responseArray = Array.isArray(data) ? data : [data];

        for (let j = 0; j < chunkIndices.length; j++) {
          const idx = chunkIndices[j]!;
          const contact = contacts[idx]!;
          const apiResult = responseArray[j];
          const result = apiResult ? this.mapFindResult(apiResult) : {
            email: null, confidence: 0, catchAll: false,
            emailFormat: null, mxDomain: null, error: 'No response for contact',
          };
          results[idx] = result;

          // Cache each result
          const first = contact.firstName.trim().toLowerCase();
          const last = contact.lastName.trim().toLowerCase();
          const cacheKey = `generect:find:${contact.domain}:${first}:${last}`;
          await redis.setex(cacheKey, CACHE_TTL_30D, JSON.stringify(result)).catch(() => {});
        }
      } catch (err) {
        logger.warn({ err }, 'Generect batch request failed');
        for (const idx of chunkIndices) {
          results[idx] = {
            email: null, confidence: 0, catchAll: false,
            emailFormat: null, mxDomain: null,
            error: err instanceof Error ? err.message : 'Unknown error',
          };
        }
      }
    }

    return results;
  }

  // ── Validate email ──────────────────────────────────────────────────────

  async validateEmail(email: string): Promise<{ valid: boolean; catchAll: boolean; error: string | null }> {
    const cacheKey = `generect:valid:${email.toLowerCase()}`;

    // Check cache
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as { valid: boolean; catchAll: boolean; error: string | null };
      }
    } catch {
      // continue
    }

    try {
      const res = await fetch(`${API_BASE}/email_validator/`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Generect validate API ${res.status}: ${text}`);
      }

      const data = await res.json() as GenerectValidateResponse;
      const result = {
        valid: data.result === 'valid' && data.exist === 'yes',
        catchAll: data.catch_all ?? false,
        error: data.error ?? null,
      };

      await redis.setex(cacheKey, CACHE_TTL_30D, JSON.stringify(result)).catch(() => {});
      return result;
    } catch (err) {
      logger.warn({ err, email }, 'Generect validateEmail failed');
      return {
        valid: false,
        catchAll: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private mapFindResult(data: GenerectFindResponse): GenerectEmailResult {
    if (data.error) {
      return {
        email: null,
        confidence: 0,
        catchAll: false,
        emailFormat: null,
        mxDomain: null,
        error: data.error,
      };
    }

    const isValid = data.result === 'valid' && data.exist === 'yes';
    const isCatchAll = data.catch_all ?? false;

    if (!data.email) {
      return {
        email: null,
        confidence: 0,
        catchAll: isCatchAll,
        emailFormat: data.email_format ?? null,
        mxDomain: data.mx_domain ?? null,
        error: null,
      };
    }

    let confidence: number;
    if (isValid && !isCatchAll) {
      confidence = 95;
    } else if (data.email && isCatchAll) {
      confidence = 70;
    } else {
      confidence = 0;
    }

    return {
      email: data.email,
      confidence,
      catchAll: isCatchAll,
      emailFormat: data.email_format ?? null,
      mxDomain: data.mx_domain ?? null,
      error: null,
    };
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

export const generectEmailTool = new GenerectEmailTool();
