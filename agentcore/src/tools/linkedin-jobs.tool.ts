import { scrape } from './crawl4ai.tool.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { enqueueExtensionTask } from '../services/extension-dispatcher.js';
import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { companies } from '../db/schema/index.js';
import logger from '../utils/logger.js';

export interface LinkedInJobCompany {
  companyName: string;
  linkedinUrl?: string;
  jobTitle: string;
  location?: string;
  postedAt?: string;
}

/**
 * Server-side LinkedIn Jobs search via CRAWL4AI.
 *
 * LinkedIn Jobs search pages are PUBLIC (no login required), so we scrape
 * them directly from the server instead of routing through the Chrome extension.
 *
 * For each company found, we:
 *  1. Save/update the company row with hiringSignal metadata
 *  2. Auto-queue a `fetch_company` extension task for full LinkedIn About details
 */
export async function searchLinkedInJobs(
  tenantId: string,
  jobTitle: string,
  location: string,
  masterAgentId?: string,
): Promise<{ companies: LinkedInJobCompany[]; raw: string }> {
  const keywords = encodeURIComponent(jobTitle);
  const loc = encodeURIComponent(location);
  const url = `https://www.linkedin.com/jobs/search/?keywords=${keywords}&location=${loc}&f_TPR=r604800`;

  logger.info({ tenantId, jobTitle, location, url, masterAgentId }, 'Hiring signal: scraping LinkedIn Jobs via server');

  const markdown = await scrape(tenantId, url);
  if (!markdown || markdown.trim().length < 50) {
    logger.warn({ tenantId, jobTitle, location, markdownLen: markdown.length }, 'LinkedIn Jobs scrape returned empty/short content');
    return { companies: [], raw: markdown };
  }

  const parsed = parseJobListings(markdown);
  logger.info({ tenantId, jobTitle, location, parsedCount: parsed.length }, 'LinkedIn Jobs parsed from markdown');

  // Deduplicate by LinkedIn URL
  const seen = new Set<string>();
  const unique: LinkedInJobCompany[] = [];
  for (const c of parsed) {
    const key = c.linkedinUrl || c.companyName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  // Save companies to DB and auto-chain fetch_company
  let saved = 0;
  for (const c of unique) {
    if (!c.companyName || c.companyName.length < 2) continue;

    // Dedup by linkedinUrl in DB
    if (c.linkedinUrl) {
      const [existing] = await withTenant(tenantId, async (tx) => {
        return tx
          .select({ id: companies.id })
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, tenantId),
              eq(companies.linkedinUrl, c.linkedinUrl!),
            ),
          )
          .limit(1);
      });
      if (existing) {
        logger.debug({ linkedinUrl: c.linkedinUrl, existingId: existing.id }, 'Skipped duplicate company from LinkedIn Jobs (dedup by linkedinUrl)');
        continue;
      }
    }

    try {
      const savedRow = await saveOrUpdateCompanyStatic(
        tenantId,
        {
          name: c.companyName,
          linkedinUrl: c.linkedinUrl,
          rawData: {
            source: 'linkedin_jobs_crawl4ai',
            hiringSignal: true,
            openJob: c.jobTitle,
            jobPostedAt: c.postedAt,
            location: c.location,
          },
        },
        masterAgentId,
      );
      logger.debug({ companyId: savedRow.id, name: c.companyName, linkedinUrl: c.linkedinUrl }, 'Saved company from LinkedIn Jobs');

      // Auto-queue fetch_company to get full company details via extension
      if (c.linkedinUrl) {
        try {
          await enqueueExtensionTask({
            tenantId,
            masterAgentId,
            site: 'linkedin',
            type: 'fetch_company',
            params: { linkedinUrl: c.linkedinUrl, companyId: savedRow.id },
            priority: 3,
          });
        } catch (err) {
          logger.debug({ err, linkedinUrl: c.linkedinUrl }, 'Failed to auto-queue fetch_company from LinkedIn Jobs (non-fatal)');
        }
      }

      saved++;
    } catch (err) {
      logger.debug({ err, name: c.companyName }, 'Skipped invalid company from LinkedIn Jobs');
    }
  }

  logger.info(
    { tenantId, masterAgentId, jobTitle, location, parsed: unique.length, saved },
    'Server-side LinkedIn Jobs scrape completed',
  );

  return { companies: unique, raw: markdown };
}

/**
 * Parse LinkedIn Jobs markdown output from CRAWL4AI.
 *
 * LinkedIn Jobs pages rendered as markdown typically contain job cards with:
 *  - Job title as a heading or bold link
 *  - Company name with a /company/ link
 *  - Location text
 *  - Posted date (e.g. "2 days ago", "1 week ago")
 *
 * We use multiple regex strategies to handle different markdown formats.
 */
function parseJobListings(markdown: string): LinkedInJobCompany[] {
  const results: LinkedInJobCompany[] = [];

  // Strategy 1: Look for /company/ links with surrounding context
  // Pattern: [Company Name](https://www.linkedin.com/company/slug...)
  const companyLinkRegex = /\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/company\/([a-zA-Z0-9_-]+)\/?[^)]*\)/g;
  let match: RegExpExecArray | null;
  const companyPositions: Array<{ name: string; slug: string; linkedinUrl: string; index: number }> = [];

  while ((match = companyLinkRegex.exec(markdown)) !== null) {
    const name = match[1]!.trim();
    const slug = match[2]!;
    if (name.length < 2 || slug.length < 2) continue;
    companyPositions.push({
      name,
      slug,
      linkedinUrl: `https://www.linkedin.com/company/${slug}`,
      index: match.index,
    });
  }

  // For each company link, look backwards for a job title (usually a nearby heading or bold text)
  for (const cp of companyPositions) {
    const contextBefore = markdown.slice(Math.max(0, cp.index - 500), cp.index);
    const contextAfter = markdown.slice(cp.index, cp.index + 300);

    // Job title: look for the closest heading, bold, or link text before the company
    let jt = '';
    // Try: ### Job Title or ** Job Title **
    const headingMatch = contextBefore.match(/(?:#{1,4}\s+(.+)|^\*\*(.+?)\*\*)/m);
    if (headingMatch) {
      jt = (headingMatch[1] || headingMatch[2] || '').trim();
    }
    // Try: [Job Title](linkedin.com/jobs/view/...)
    if (!jt) {
      const jobLinkMatch = contextBefore.match(/\[([^\]]+)\]\(https?:\/\/(?:www\.)?linkedin\.com\/jobs\/view\//);
      if (jobLinkMatch) jt = jobLinkMatch[1]!.trim();
    }
    // Fallback: last non-empty line before company mention
    if (!jt) {
      const lines = contextBefore.split('\n').map(l => l.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      // Clean markdown formatting
      jt = lastLine.replace(/^[#*\->\s]+/, '').replace(/\[([^\]]+)\]\([^)]+\)/, '$1').trim();
    }

    // Location: look for common location patterns after the company
    let location = '';
    const locMatch = contextAfter.match(/(?:📍|Location:|·)\s*([A-Z][^\n|·]{2,50})/);
    if (locMatch) location = locMatch[1]!.trim();
    // Fallback: city-like pattern in the context
    if (!location) {
      const cityMatch = contextAfter.match(/\b([A-Z][a-z]+(?:[\s,]+[A-Z][a-z]+){0,3}(?:,\s*[A-Z]{2})?)\b/);
      if (cityMatch && cityMatch[1]!.length > 3) location = cityMatch[1]!.trim();
    }

    // Posted date
    let postedAt = '';
    const dateMatch = contextAfter.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago|just\s+now|today|yesterday)/i);
    if (dateMatch) postedAt = dateMatch[1]!.trim();

    results.push({
      companyName: cp.name,
      linkedinUrl: cp.linkedinUrl,
      jobTitle: jt || 'Unknown role',
      location: location || undefined,
      postedAt: postedAt || undefined,
    });
  }

  // Strategy 2: If no /company/ links found, try line-by-line extraction
  // LinkedIn Jobs markdown sometimes renders as plain text lists
  if (results.length === 0) {
    const lines = markdown.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      // Look for lines that mention a company with a job context
      const jobPattern = line.match(/^(?:[-*•]\s*)?(.+?)\s+(?:at|@|-|–|—)\s+(.+?)(?:\s*[|·]\s*(.+))?$/i);
      if (jobPattern) {
        const title = jobPattern[1]!.trim();
        const company = jobPattern[2]!.trim();
        const loc = jobPattern[3]?.trim();
        if (company.length >= 2 && title.length >= 3) {
          results.push({
            companyName: company,
            jobTitle: title,
            location: loc || undefined,
          });
        }
      }
    }
  }

  return results;
}
