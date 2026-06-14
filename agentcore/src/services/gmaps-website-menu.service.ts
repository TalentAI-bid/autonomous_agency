// Best-effort menu extraction for Google Maps food businesses from their OWN
// website. The text twin of gmaps-menu.service.ts (which OCRs photos). Runs off
// the gmaps-menu queue after a place-detail scrape captured a menuLink/website.
// Scrapes the page text and asks an LLM to read any menu present, then persists
// the structured result onto the contact + company. Fail-soft throughout: when
// no menu is legible it stores nothing rather than fabricate one
// (see [[feedback_fail_loud_over_fabricate]]).

import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, companies } from '../db/schema/index.js';
import { scrape } from '../tools/crawl4ai.tool.js';
import { extractJSON } from '../tools/together-ai.tool.js';
import {
  GMAPS_WEBSITE_MENU_SYSTEM_PROMPT,
  buildGmapsWebsiteMenuUserPrompt,
  type GmapsMenuExtraction,
} from '../prompts/gmaps-website-menu.prompt.js';
import logger from '../utils/logger.js';

const MAX_PAGE_CHARS = 16000;

function isUsefulExtraction(m: GmapsMenuExtraction | null | undefined): m is GmapsMenuExtraction {
  if (!m) return false;
  const hasDishes = Array.isArray(m.dishes) && m.dishes.some((d) => d?.name && d.name.trim());
  return !!m.readable && hasDishes;
}

/**
 * Extract and persist a menu for one Google Maps food-business contact by
 * scraping its own website. Returns true when a menu was stored, false
 * otherwise (no URL, page blocked/empty, nothing readable). Never throws for
 * the "nothing found" case.
 */
export async function extractAndStoreGmapsWebsiteMenu(tenantId: string, contactId: string): Promise<boolean> {
  const [contact] = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: contacts.id,
        companyId: contacts.companyId,
        companyName: contacts.companyName,
        sourceMetadata: contacts.sourceMetadata,
      })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
      .limit(1),
  );
  if (!contact) {
    logger.debug({ tenantId, contactId }, 'gmaps website menu: contact not found, skipping');
    return false;
  }

  const meta = (contact.sourceMetadata as Record<string, unknown>) ?? {};
  // A dedicated menu link is best; the main website is the fallback.
  const menuUrl = (typeof meta.menuLink === 'string' && meta.menuLink.trim())
    || (typeof meta.website === 'string' && meta.website.trim())
    || '';
  const category = typeof meta.category === 'string' ? meta.category : undefined;
  const name = contact.companyName || 'this business';

  if (!menuUrl) {
    logger.debug({ tenantId, contactId }, 'gmaps website menu: no menuLink/website, skipping');
    return false;
  }

  // scrape() returns '' on Cloudflare-block / failure (fail-soft) and carries
  // its own caching, per-domain rate-limit and circuit breaker.
  let pageText = '';
  try {
    pageText = await scrape(tenantId, menuUrl);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), tenantId, contactId, menuUrl },
      'gmaps website menu: scrape failed (non-fatal)',
    );
    return false;
  }
  if (!pageText || !pageText.trim()) {
    logger.debug({ tenantId, contactId, menuUrl }, 'gmaps website menu: empty page (fail-soft)');
    return false;
  }

  let extraction: GmapsMenuExtraction | null = null;
  try {
    extraction = await extractJSON<GmapsMenuExtraction>(tenantId, [
      { role: 'system', content: GMAPS_WEBSITE_MENU_SYSTEM_PROMPT },
      { role: 'user', content: buildGmapsWebsiteMenuUserPrompt(name, category, pageText.slice(0, MAX_PAGE_CHARS)) },
    ]);
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), tenantId, contactId },
      'gmaps website menu: extraction failed (non-fatal)',
    );
    return false;
  }

  if (!isUsefulExtraction(extraction)) {
    logger.debug({ tenantId, contactId, menuUrl }, 'gmaps website menu: nothing readable (fail-soft)');
    return false;
  }

  const menu = {
    ...extraction,
    extractedAt: new Date().toISOString(),
    source: 'gmaps_website',
    sourceUrl: menuUrl,
  };

  // Persist onto the contact's sourceMetadata and the company's rawData.
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(contacts)
      .set({ sourceMetadata: { ...meta, menu }, updatedAt: new Date() })
      .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));

    if (contact.companyId) {
      const [company] = await tx
        .select({ rawData: companies.rawData })
        .from(companies)
        .where(and(eq(companies.id, contact.companyId), eq(companies.tenantId, tenantId)))
        .limit(1);
      const rawData = (company?.rawData as Record<string, unknown>) ?? {};
      await tx
        .update(companies)
        .set({ rawData: { ...rawData, menu }, updatedAt: new Date() })
        .where(and(eq(companies.id, contact.companyId), eq(companies.tenantId, tenantId)));
    }
  });

  logger.info(
    { tenantId, contactId, dishCount: extraction.dishes?.length ?? 0, cuisine: extraction.cuisine, menuUrl },
    'gmaps website menu: extracted and stored',
  );
  return true;
}
