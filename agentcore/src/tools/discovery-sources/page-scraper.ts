import pLimit from 'p-limit';
import { scrape } from '../crawl4ai.tool.js';
import { extractJSON } from '../together-ai.tool.js';
import type { ChatMessage } from '../together-ai.tool.js';
import logger from '../../utils/logger.js';
import type { RawCompanyResult, RawPersonResult } from './types.js';

// ── Concurrency controls ────────────────────────────────────────────────────

const crawlLimit = pLimit(5);
const llmLimit = pLimit(8);
const CRAWL_DELAY_MS = 500;
const MAX_CONTENT_LENGTH = 6000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Company extraction ──────────────────────────────────────────────────────

const COMPANY_EXTRACTION_PROMPT = `You are extracting structured company data from a web page.
Return a JSON array of companies found on the page. Each object should have:
- name (string, required)
- domain (string, optional)
- industry (string, optional)
- size (string, optional - e.g. "50-200", "1000+")
- techStack (string[], optional)
- funding (string, optional - e.g. "Series B, $50M")
- linkedinUrl (string, optional)
- description (string, optional - one sentence)
- foundedYear (number, optional)
- headquarters (string, optional)

Return ONLY a valid JSON array. If no companies found, return [].`;

export async function scrapeAndExtractCompanies(
  urls: string[],
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const results: RawCompanyResult[] = [];

  // Scrape pages in parallel with concurrency limit
  const scraped = await Promise.allSettled(
    urls.map((url, i) =>
      crawlLimit(async () => {
        if (i > 0) await sleep(CRAWL_DELAY_MS);
        try {
          const content = await scrape(tenantId, url);
          return { url, content };
        } catch (err) {
          logger.debug({ err, url }, 'Failed to scrape page for company extraction');
          return { url, content: '' };
        }
      }),
    ),
  );

  // Extract company data via LLM for pages that returned content
  const extractionTasks: Array<Promise<void>> = [];

  for (const result of scraped) {
    if (result.status !== 'fulfilled' || !result.value.content) continue;
    const { url, content } = result.value;
    const truncated = content.slice(0, MAX_CONTENT_LENGTH);

    extractionTasks.push(
      llmLimit(async () => {
        try {
          const messages: ChatMessage[] = [
            { role: 'system', content: COMPANY_EXTRACTION_PROMPT },
            { role: 'user', content: `Extract companies from this page (${url}):\n\n${truncated}` },
          ];

          const extracted = await extractJSON<Array<{
            name?: string;
            domain?: string;
            industry?: string;
            size?: string;
            techStack?: string[];
            funding?: string;
            linkedinUrl?: string;
            description?: string;
            foundedYear?: number;
            headquarters?: string;
          }>>(tenantId, messages);

          const items = Array.isArray(extracted) ? extracted : [];
          for (const item of items) {
            if (!item.name) continue;
            results.push({
              name: item.name,
              domain: item.domain,
              industry: item.industry,
              size: item.size,
              techStack: item.techStack,
              funding: item.funding,
              linkedinUrl: item.linkedinUrl,
              description: item.description,
              foundedYear: item.foundedYear,
              headquarters: item.headquarters,
              source: `scraped:${url}`,
              confidence: 60,
              rawData: { scrapedFrom: url },
            });
          }
        } catch (err) {
          logger.debug({ err, url }, 'LLM company extraction failed');
        }
      }),
    );
  }

  await Promise.allSettled(extractionTasks);
  return results;
}

// ── People extraction ───────────────────────────────────────────────────────

const PEOPLE_EXTRACTION_PROMPT = `You are extracting structured person/contact data from a web page.
Return a JSON array of people found on the page. Each object should have:
- fullName (string, required)
- firstName (string, optional)
- lastName (string, optional)
- title (string, optional - job title)
- companyName (string, optional)
- email (string, optional)
- linkedinUrl (string, optional)
- githubUrl (string, optional)
- twitterUrl (string, optional)
- location (string, optional)
- skills (string[], optional)

Return ONLY a valid JSON array. If no people found, return [].`;

export async function scrapeAndExtractPeople(
  urls: string[],
  tenantId: string,
): Promise<RawPersonResult[]> {
  const results: RawPersonResult[] = [];

  const scraped = await Promise.allSettled(
    urls.map((url, i) =>
      crawlLimit(async () => {
        if (i > 0) await sleep(CRAWL_DELAY_MS);
        try {
          const content = await scrape(tenantId, url);
          return { url, content };
        } catch (err) {
          logger.debug({ err, url }, 'Failed to scrape page for people extraction');
          return { url, content: '' };
        }
      }),
    ),
  );

  const extractionTasks: Array<Promise<void>> = [];

  for (const result of scraped) {
    if (result.status !== 'fulfilled' || !result.value.content) continue;
    const { url, content } = result.value;
    const truncated = content.slice(0, MAX_CONTENT_LENGTH);

    extractionTasks.push(
      llmLimit(async () => {
        try {
          const messages: ChatMessage[] = [
            { role: 'system', content: PEOPLE_EXTRACTION_PROMPT },
            { role: 'user', content: `Extract people from this page (${url}):\n\n${truncated}` },
          ];

          const extracted = await extractJSON<Array<{
            fullName?: string;
            firstName?: string;
            lastName?: string;
            title?: string;
            companyName?: string;
            email?: string;
            linkedinUrl?: string;
            githubUrl?: string;
            twitterUrl?: string;
            location?: string;
            skills?: string[];
          }>>(tenantId, messages);

          const items = Array.isArray(extracted) ? extracted : [];
          for (const item of items) {
            if (!item.fullName && !item.firstName) continue;
            results.push({
              fullName: item.fullName,
              firstName: item.firstName,
              lastName: item.lastName,
              title: item.title,
              companyName: item.companyName,
              email: item.email,
              linkedinUrl: item.linkedinUrl,
              githubUrl: item.githubUrl,
              twitterUrl: item.twitterUrl,
              location: item.location,
              skills: item.skills,
              source: `scraped:${url}`,
              confidence: 55,
              rawData: { scrapedFrom: url },
            });
          }
        } catch (err) {
          logger.debug({ err, url }, 'LLM people extraction failed');
        }
      }),
    );
  }

  await Promise.allSettled(extractionTasks);
  return results;
}
