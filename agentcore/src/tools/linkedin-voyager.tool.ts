import { env } from '../config/env.js';
import logger from '../utils/logger.js';

// ── Rate limiting ──────────────────────────────────────────────────────────

let lastRequestTime = 0;
let dailyRequestCount = 0;
let dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;

function resetDailyIfNeeded() {
  if (Date.now() >= dailyResetAt) {
    dailyRequestCount = 0;
    dailyResetAt = Date.now() + 24 * 60 * 60 * 1000;
  }
}

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  resetDailyIfNeeded();

  if (dailyRequestCount >= env.LINKEDIN_VOYAGER_DAILY_LIMIT) {
    logger.warn({ dailyRequestCount, limit: env.LINKEDIN_VOYAGER_DAILY_LIMIT }, 'LinkedIn Voyager: daily limit reached');
    throw new Error('LinkedIn Voyager daily limit reached');
  }

  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < env.LINKEDIN_VOYAGER_DELAY_MS) {
    await new Promise(r => setTimeout(r, env.LINKEDIN_VOYAGER_DELAY_MS - elapsed));
  }

  lastRequestTime = Date.now();
  dailyRequestCount++;

  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000),
  });

  logger.info(
    { url, status: response.status, dailyCount: dailyRequestCount },
    'LinkedIn Voyager: API call',
  );

  return response;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface VoyagerProfile {
  firstName: string;
  lastName: string;
  headline: string;
  location: string;
  industry: string;
  summary: string;
  profileUrl: string;
  experiences: Array<{
    title: string;
    company: string;
    dateRange: string;
    duration: string;
    location: string;
    description: string;
  }>;
  education: Array<{
    school: string;
    degree: string;
    fieldOfStudy: string;
    dates: string;
  }>;
  skills: string[];
  languages: Array<{ language: string; proficiency: string }>;
  certifications: Array<{ name: string; issuer: string }>;
  connections: number;
  profilePicture: string;
}

export interface VoyagerSearchResult {
  firstName: string;
  lastName: string;
  headline: string;
  location: string;
  profileUrl: string;
  slug: string;
  currentCompany: string;
}

export interface VoyagerCompany {
  name: string;
  tagline: string;
  industry: string;
  companySize: string;
  headquarters: string;
  website: string;
  founded: number | null;
  specialties: string[];
  about: string;
  followerCount: number;
  companyUrl: string;
}

// ── API Functions ──────────────────────────────────────────────────────────

export async function getLinkedInProfile(linkedinUrl: string): Promise<VoyagerProfile | null> {
  try {
    const response = await rateLimitedFetch(`${env.LINKEDIN_VOYAGER_URL}/profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkedin_url: linkedinUrl }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, linkedinUrl }, 'LinkedIn Voyager: profile fetch failed');
      return null;
    }

    const data = await response.json() as { success: boolean; profile: VoyagerProfile };
    if (!data.success || !data.profile) return null;

    return data.profile;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), linkedinUrl }, 'LinkedIn Voyager: profile error');
    return null;
  }
}

export async function searchLinkedInPeople(
  keywords: string,
  location: string = '',
  count: number = 10,
  start: number = 0,
): Promise<{ total: number; results: VoyagerSearchResult[] }> {
  try {
    const response = await rateLimitedFetch(`${env.LINKEDIN_VOYAGER_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords, location, count, start }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, keywords, location }, 'LinkedIn Voyager: search failed');
      return { total: 0, results: [] };
    }

    const data = await response.json() as { success: boolean; total: number; results: VoyagerSearchResult[] };
    if (!data.success) return { total: 0, results: [] };

    return { total: data.total || 0, results: data.results || [] };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), keywords, location }, 'LinkedIn Voyager: search error');
    return { total: 0, results: [] };
  }
}

export async function getLinkedInCompany(linkedinUrl: string): Promise<VoyagerCompany | null> {
  try {
    const response = await rateLimitedFetch(`${env.LINKEDIN_VOYAGER_URL}/company`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkedin_url: linkedinUrl }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, linkedinUrl }, 'LinkedIn Voyager: company fetch failed');
      return null;
    }

    const data = await response.json() as { success: boolean; company: VoyagerCompany };
    if (!data.success || !data.company) return null;

    return data.company;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), linkedinUrl }, 'LinkedIn Voyager: company error');
    return null;
  }
}

export function getVoyagerStats(): { dailyCount: number; dailyLimit: number } {
  resetDailyIfNeeded();
  return {
    dailyCount: dailyRequestCount,
    dailyLimit: env.LINKEDIN_VOYAGER_DAILY_LIMIT,
  };
}
