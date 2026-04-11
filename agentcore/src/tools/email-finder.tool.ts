import { env } from '../config/env.js';
import logger from '../utils/logger.js';

function normalizeForEmail(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // remove accents é→e, ñ→n, ü→u
    .replace(/[^a-z]/g, '');           // only keep letters
}

function generatePatterns(first: string, last: string, domain: string): string[] {
  const f = normalizeForEmail(first);
  const l = normalizeForEmail(last);
  if (!f || !l || !domain) return [];
  return [
    `${f}.${l}@${domain}`,       // jean.dupont@domain.com
    `${f[0]}${l}@${domain}`,     // jdupont@domain.com
    `${f}@${domain}`,            // jean@domain.com
    `${f[0]}.${l}@${domain}`,    // j.dupont@domain.com
    `${f}${l}@${domain}`,        // jeandupont@domain.com
    `${l}.${f}@${domain}`,       // dupont.jean@domain.com
    `${f}_${l}@${domain}`,       // jean_dupont@domain.com
    `${l}@${domain}`,            // dupont@domain.com
  ];
}

interface ReacherResponse {
  is_reachable: 'safe' | 'invalid' | 'risky' | 'unknown';
  smtp: {
    can_connect_smtp?: boolean;
    is_catch_all?: boolean;
    is_deliverable?: boolean;
    error?: { type: string; message: string };
  };
  misc: { is_role_account?: boolean };
}

export async function findEmailByPattern(
  firstName: string,
  lastName: string,
  domain: string,
): Promise<{ email: string | null; method: string; attempts: number }> {
  const patterns = generatePatterns(firstName, lastName, domain);
  if (patterns.length === 0) {
    logger.warn({ firstName, lastName, domain }, 'Email finder: no patterns generated');
    return { email: null, method: 'no_patterns', attempts: 0 };
  }

  let attempts = 0;
  let catchAllDetected = false;

  for (const candidate of patterns) {
    attempts++;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000);

      const response = await fetch(`${env.REACHER_URL}/v0/check_email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_email: candidate }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn({ candidate, status: response.status }, 'Reacher API error');
        continue;
      }

      const result: ReacherResponse = await response.json() as ReacherResponse;

      // Catch-all domain — return first pattern as best guess
      if (result.smtp?.is_catch_all) {
        catchAllDetected = true;
        logger.info({ domain, candidate }, 'Catch-all domain detected, returning first pattern');
        return { email: patterns[0]!, method: 'catch_all_guess', attempts };
      }

      if (result.is_reachable === 'safe') {
        logger.info({ candidate, attempts }, 'Email verified as safe via Reacher');
        return { email: candidate, method: 'smtp_verified', attempts };
      }

      logger.debug({ candidate, reachable: result.is_reachable }, 'Email pattern not valid');

      // Rate limit — 1 second between checks
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      logger.warn(
        { candidate, err: err instanceof Error ? err.message : String(err) },
        'Reacher check failed for candidate',
      );
    }
  }

  return { email: null, method: catchAllDetected ? 'catch_all_none' : 'exhausted', attempts };
}
