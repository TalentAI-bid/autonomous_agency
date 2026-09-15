// Best-effort GENERIC email discovery for a Google Maps business from its OWN
// website. Google Maps never exposes email, and the person-based enrichment
// agent needs a first/last name (a business contact has none), so without this
// a GMaps business never gets an email at all. Runs off the gmaps-email queue
// after a place-detail scrape captured a website. Scrapes the homepage + a few
// common contact pages, regex-harvests emails, prefers a generic inbox
// (info@/contact@…) on the business's own domain, and fill-empty writes it onto
// the contact. Fail-soft throughout: when nothing usable is found it stores
// nothing rather than fabricate an address (see [[feedback_fail_loud_over_fabricate]]).

import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts } from '../db/schema/index.js';
import { scrape } from '../tools/crawl4ai.tool.js';
import logger from '../utils/logger.js';

const MAX_PAGES = 4;

// Local-parts that signal a shared/role inbox — what we actually want here.
const GENERIC_LOCALPARTS = new Set([
  'info', 'contact', 'contacts', 'hello', 'hi', 'sales', 'admin', 'office',
  'support', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'reservation',
  'reservations', 'booking', 'bookings', 'bonjour', 'salam', 'team', 'mail',
]);

// Substrings that mark an email as boilerplate/library/CDN noise, not a real
// business inbox. Kept deliberately small and high-signal.
const JUNK_EMAIL_SUBSTRINGS = [
  'example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain',
  'sentry.io', 'sentry-next', 'wixpress.com', 'wix.com', 'squarespace.com',
  'googleusercontent', 'schema.org', 'w3.org', 'sentry.wixpress',
  'godaddy', 'cloudflare', 'jquery', 'fontawesome', 'gstatic', 'placeholder',
];

// Image/asset filenames the naive regex would otherwise treat as emails
// (e.g. "logo@2x.png"). Drop anything ending in an asset extension.
const ASSET_TAIL = /\.(png|jpe?g|gif|webp|svg|css|js|ico|woff2?)$/i;

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

function domainOf(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function harvestEmails(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.match(EMAIL_RE) ?? []) {
    const email = raw.toLowerCase().replace(/\.$/, '');
    if (ASSET_TAIL.test(email)) continue;
    if (JUNK_EMAIL_SUBSTRINGS.some((j) => email.includes(j))) continue;
    // Guard against obviously bogus local parts (hashes/version strings).
    const [local] = email.split('@');
    if (!local || local.length > 64 || /^[0-9a-f]{16,}$/.test(local)) continue;
    out.add(email);
  }
  return [...out];
}

/**
 * Pick the best generic email from a candidate set, given the business's own
 * website domain. Priority: generic-local on the site's domain → generic-local
 * anywhere → any email on the site's domain → the first candidate.
 */
function pickBestEmail(emails: string[], siteDomain?: string): string | undefined {
  if (emails.length === 0) return undefined;
  const isGeneric = (e: string) => GENERIC_LOCALPARTS.has(e.split('@')[0]!);
  const onSite = (e: string) => !!siteDomain && e.split('@')[1] === siteDomain;

  return (
    emails.find((e) => isGeneric(e) && onSite(e)) ||
    emails.find((e) => isGeneric(e)) ||
    emails.find((e) => onSite(e)) ||
    emails[0]
  );
}

/** Candidate page URLs to crawl for a generic inbox — homepage + contact pages. */
function candidatePages(website: string): string[] {
  const urls: string[] = [website];
  try {
    const origin = new URL(website.startsWith('http') ? website : `https://${website}`).origin;
    for (const path of ['/contact', '/contact-us', '/about', '/kontakt', '/impressum']) {
      urls.push(origin + path);
    }
  } catch {
    /* website not a parseable URL — homepage-only */
  }
  // De-dupe while preserving order, cap the crawl budget.
  return [...new Set(urls)].slice(0, MAX_PAGES);
}

/**
 * Discover and persist a generic business email for one Google Maps contact by
 * scraping its own website. Returns true when an email was stored, false
 * otherwise (no website, already has an email, page blocked/empty, nothing
 * found). Never throws for the "nothing found" case. Fill-empty only — never
 * overwrites an existing contact email.
 */
export async function extractAndStoreGmapsWebsiteEmail(tenantId: string, contactId: string): Promise<boolean> {
  const [contact] = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: contacts.id,
        email: contacts.email,
        sourceMetadata: contacts.sourceMetadata,
      })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
      .limit(1),
  );
  if (!contact) {
    logger.debug({ tenantId, contactId }, 'gmaps website email: contact not found, skipping');
    return false;
  }
  if (contact.email && contact.email.trim()) {
    logger.debug({ tenantId, contactId }, 'gmaps website email: contact already has email, skipping');
    return false;
  }

  const meta = (contact.sourceMetadata as Record<string, unknown>) ?? {};
  const website = typeof meta.website === 'string' ? meta.website.trim() : '';
  if (!website) {
    logger.debug({ tenantId, contactId }, 'gmaps website email: no website, skipping');
    return false;
  }
  const siteDomain = domainOf(website);

  // Crawl homepage + contact pages, stopping as soon as a generic on-domain
  // inbox is found. scrape() is fail-soft ('' on block/failure) with its own
  // per-domain rate-limit and circuit breaker.
  const found = new Set<string>();
  for (const url of candidatePages(website)) {
    let pageText = '';
    try {
      pageText = await scrape(tenantId, url);
    } catch (err) {
      logger.debug(
        { err: err instanceof Error ? err.message : String(err), tenantId, contactId, url },
        'gmaps website email: scrape failed (non-fatal)',
      );
      continue;
    }
    if (!pageText || !pageText.trim()) continue;
    for (const e of harvestEmails(pageText)) found.add(e);
    // Early exit: a generic inbox on the business's own domain is the ideal hit.
    if ([...found].some((e) => GENERIC_LOCALPARTS.has(e.split('@')[0]!) && e.split('@')[1] === siteDomain)) {
      break;
    }
  }

  const emails = [...found];
  const best = pickBestEmail(emails, siteDomain);
  if (!best) {
    logger.debug({ tenantId, contactId, website }, 'gmaps website email: none found (fail-soft)');
    return false;
  }

  await withTenant(tenantId, async (tx) => {
    await tx
      .update(contacts)
      .set({
        email: best,
        emailVerified: false,
        sourceMetadata: { ...meta, genericEmails: emails, genericEmailSource: 'gmaps_website' },
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, tenantId)));
  });

  logger.info(
    { tenantId, contactId, email: best, candidates: emails.length, website },
    'gmaps website email: stored generic email',
  );
  return true;
}
