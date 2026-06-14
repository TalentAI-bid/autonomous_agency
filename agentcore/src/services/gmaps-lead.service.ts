import { eq, and, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts } from '../db/schema/index.js';
import { saveOrUpdateCompanyStatic } from '../agents/shared/save-company.js';
import { ensureDeal } from './crm-activity.service.js';
import { logEvent } from './timeline.service.js';
import { dispatchJob } from './queue.service.js';
import { enqueueGmapsMenu } from '../queues/gmaps-menu-queues.js';
import logger from '../utils/logger.js';

/**
 * Shared CRM-push layer for Google Maps business leads. Used by BOTH the
 * user-triggered capture endpoint (POST /api/extension/gmaps/capture) and
 * the extension dispatcher's server-dispatched gmaps ingestion, so both
 * paths land identical rows: company + business-level contact + deal in
 * the default "Lead" stage (visible on the CRM board) + discovery event.
 *
 * Decoupled from extension task plumbing on purpose — the input is the
 * normalized BusinessRecord produced by the extension's maps-core module,
 * which is also what the future standalone Maps agent will emit.
 */

export interface GmapsBusinessInput {
  name: string;
  category?: string;
  address?: string;
  phone?: string | null;
  website?: string | null;
  rating?: number | null;
  /** maps-core emits `reviewCount`; legacy task results carry `reviewsCount`. */
  reviewCount?: number | null;
  reviewsCount?: number | null;
  mapsUrl?: string;
  searchQuery?: string;
  location?: string;
  // ── Full place-detail enrichment (only present on fetch_business results) ──
  hours?: string | Record<string, string> | null;
  priceLevel?: string | null;
  description?: string | null;
  serviceOptions?: string[] | null;
  plusCode?: string | null;
  coordinates?: { lat: number; lng: number } | null;
  menuLink?: string | null;
  photoUrls?: string[] | null;
  pricePerPerson?: string | null;
  directionsUrl?: string | null;
  /** Raw HTML (client browser language) — translated/rendered downstream. */
  reviewsHtml?: string | null;
  ratingDistribution?: Array<{ label: string }> | null;
  aboutHtml?: string | null;
  /** true when this record came from a place-detail (fetch_business) scrape. */
  detailFetched?: boolean;
}

export interface IngestGmapsResult {
  status: 'saved' | 'duplicate';
  contactId: string;
  dealId: string;
  companyId: string;
  mapsUrl?: string;
  /**
   * true when this business still needs a place-detail (fetch_business) scrape
   * to fill hours/menu/phone — i.e. it has a mapsUrl and hasn't been detailed
   * yet. Callers (dispatcher + manual capture route) use this to fan out one
   * detail task per business. A detail result has detailFetched=true, so this
   * is false and the chain terminates.
   */
  needsDetail: boolean;
}

// Food businesses get a best-effort menu vision pass. Broad on purpose —
// false positives just produce an empty (fail-soft) menu result.
const FOOD_CATEGORY_RE =
  /restaurant|caf[eé]|coffee|\bbar\b|bistro|brasserie|pizzeria|bakery|boulangerie|p[âa]tisserie|pastry|diner|eatery|grill|steak|sushi|burger|\bfood\b|tea ?house|\bpub\b|tavern|ice cream|gelat|dessert|brunch|breakfast|kebab|shawarma/i;

function isFoodBusiness(category?: string | null): boolean {
  return !!category && FOOD_CATEGORY_RE.test(category);
}

export async function ingestGmapsBusiness(
  tenantId: string,
  masterAgentId: string | undefined,
  b: GmapsBusinessInput,
  actorUserId?: string,
): Promise<IngestGmapsResult> {
  const name = String(b.name ?? '').trim();
  if (!name) throw new Error('gmaps business has no name');

  const mapsUrl = b.mapsUrl?.trim() || undefined;
  const website = b.website?.trim() || undefined;
  const reviewCount = b.reviewCount ?? b.reviewsCount ?? null;

  // Place-detail-only fields (undefined on search-card records). Collected here
  // so the company rawData, the new-contact insert, and the duplicate backfill
  // all store the same set.
  const detailMeta: Record<string, unknown> = {
    hours: emptyToUndef(b.hours),
    priceLevel: emptyToUndef(b.priceLevel),
    description: emptyToUndef(b.description),
    serviceOptions: b.serviceOptions?.length ? b.serviceOptions : undefined,
    plusCode: emptyToUndef(b.plusCode),
    coordinates: b.coordinates ?? undefined,
    menuLink: emptyToUndef(b.menuLink),
    photoUrls: b.photoUrls?.length ? b.photoUrls : undefined,
    pricePerPerson: emptyToUndef(b.pricePerPerson),
    directionsUrl: emptyToUndef(b.directionsUrl),
    reviewsHtml: emptyToUndef(b.reviewsHtml),
    ratingDistribution: b.ratingDistribution?.length ? b.ratingDistribution : undefined,
    aboutHtml: emptyToUndef(b.aboutHtml),
  };
  if (b.detailFetched) detailMeta.detailFetchedAt = new Date().toISOString();

  const company = await saveOrUpdateCompanyStatic(
    tenantId,
    {
      name,
      domain: website ? extractDomain(website) : undefined,
      rawData: {
        source: 'gmaps_extension',
        category: b.category || undefined,
        address: b.address || undefined,
        phone: b.phone || undefined,
        website,
        rating: b.rating ?? null,
        reviewsCount: reviewCount,
        mapsUrl,
        searchQuery: b.searchQuery || undefined,
        location: b.location || undefined,
        ...detailMeta,
      },
    },
    masterAgentId,
  );

  // ── Business-level dedup ──────────────────────────────────────────────
  // mapsUrl (the canonical place URL) is the stable key — franchises share
  // a name, so the company-level name dedup collapses chains into one
  // company row; the mapsUrl check still treats each location distinctly.
  // Fallback for records without a mapsUrl: one gmaps contact per company.
  const [existing] = await withTenant(tenantId, async (tx) => {
    return tx
      .select({
        id: contacts.id,
        phone: contacts.phone,
        location: contacts.location,
        sourceMetadata: contacts.sourceMetadata,
      })
      .from(contacts)
      .where(and(
        eq(contacts.tenantId, tenantId),
        eq(contacts.sourceType, 'gmaps_business'),
        mapsUrl
          ? sql`${contacts.sourceMetadata}->>'mapsUrl' = ${mapsUrl}`
          : eq(contacts.companyId, company.id),
      ))
      .limit(1);
  });

  let contactId: string;
  let status: IngestGmapsResult['status'];
  // Whether the place page still needs to be opened. Set in each branch from
  // the row's known detail state; a fetch_business result (detailFetched) never
  // re-triggers a detail fetch.
  let needsDetail = false;

  if (existing) {
    contactId = existing.id;
    status = 'duplicate';

    // ── Backfill (fill-empty only) ────────────────────────────────────
    // fetch_business detail pages carry phone/website the search cards
    // lack. Patch only fields that were previously empty so user edits
    // and earlier scrapes are never overwritten (same rule as the manual
    // /contacts/manual backfill).
    const prevMeta = (existing.sourceMetadata as Record<string, unknown>) ?? {};
    const websiteWasKnown = typeof prevMeta.website === 'string' && prevMeta.website.trim().length > 0;

    const patch: Partial<typeof contacts.$inferInsert> = {};
    if (!existing.phone && b.phone) patch.phone = b.phone;
    if (!existing.location && (b.location || b.address)) patch.location = b.location || b.address;

    const mergedMeta = { ...prevMeta };
    const incomingMeta: Record<string, unknown> = {
      phone: b.phone,
      website,
      rating: b.rating ?? null,
      reviewsCount: reviewCount,
      address: b.address,
      category: b.category,
      ...detailMeta,
    };
    for (const [k, v] of Object.entries(incomingMeta)) {
      const prev = mergedMeta[k];
      const emptyPrev = prev === undefined || prev === null || prev === ''
        || (Array.isArray(prev) && prev.length === 0);
      const hasNew = v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
      if (emptyPrev && hasNew) mergedMeta[k] = v;
    }
    if (JSON.stringify(mergedMeta) !== JSON.stringify(prevMeta)) patch.sourceMetadata = mergedMeta;

    // Still needs a detail scrape if it has a place URL and neither this record
    // nor the stored row has been detailed yet.
    needsDetail = !!mapsUrl && !b.detailFetched && !prevMeta.detailFetchedAt;

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date();
      await withTenant(tenantId, async (tx) => {
        return tx.update(contacts)
          .set(patch)
          .where(and(eq(contacts.id, existing.id), eq(contacts.tenantId, tenantId)));
      });
    }

    // The website just became known (it wasn't on the search card) — the
    // email-finder enrichment couldn't run at ingest time, so run it now.
    // Idempotent: a repeat completion sees websiteWasKnown=true and skips.
    if (website && !websiteWasKnown) {
      try {
        await dispatchJob(tenantId, 'enrichment', {
          contactId,
          masterAgentId,
          source: 'gmaps_extension',
        });
      } catch (err) {
        logger.debug({ err, contactId }, 'gmaps backfill: enrichment dispatch failed (non-fatal)');
      }
    }
  } else {
    const [inserted] = await withTenant(tenantId, async (tx) => {
      return tx.insert(contacts).values({
        tenantId,
        // Local businesses have no named person — the contact IS the business.
        firstName: name,
        companyId: company.id,
        companyName: name,
        phone: b.phone || undefined,
        location: b.location || b.address || undefined,
        masterAgentId,
        status: 'discovered',
        sourceType: 'gmaps_business',
        sourceMetadata: {
          source: 'gmaps_extension',
          mapsUrl,
          category: b.category || undefined,
          address: b.address || undefined,
          website,
          rating: b.rating ?? null,
          reviewsCount: reviewCount,
          searchQuery: b.searchQuery || undefined,
          location: b.location || undefined,
          ...detailMeta,
        },
        createdByUserId: actorUserId,
        customTags: [b.category, b.location].filter((t): t is string => !!t?.trim()),
      }).returning({ id: contacts.id });
    });
    if (!inserted) throw new Error('gmaps contact insert returned no row');
    contactId = inserted.id;
    status = 'saved';
    needsDetail = !!mapsUrl && !b.detailFetched;
  }

  const deal = await ensureDeal({ tenantId, contactId, masterAgentId });

  if (status === 'saved') {
    try {
      await logEvent({
        tenantId,
        contactId,
        dealId: deal.id,
        masterAgentId,
        type: 'contact_added',
        eventCategory: 'discovery',
        actorType: actorUserId ? 'user' : 'system',
        actorUserId,
        title: 'Business captured from Google Maps',
        metadata: { source: 'gmaps_extension', mapsUrl, category: b.category, searchQuery: b.searchQuery },
      });
    } catch (err) {
      logger.warn({ err, contactId }, 'gmaps ingest: timeline event failed (non-fatal)');
    }

    // Maps never shows emails — the enrichment agent visits the website and
    // runs the email finder. Only worth dispatching when a website exists.
    if (website) {
      try {
        await dispatchJob(tenantId, 'enrichment', {
          contactId,
          masterAgentId,
          source: 'gmaps_extension',
        });
      } catch (err) {
        logger.debug({ err, contactId }, 'gmaps ingest: enrichment dispatch failed (non-fatal)');
      }
    }
  }

  // Best-effort menu pass: the place page was just scraped (detailFetched) for a
  // food business. The worker prefers the business website (menuLink/website)
  // and falls back to photo-vision OCR — so enqueue when EITHER source exists.
  // Fail-soft — the worker stores nothing when no usable menu is found.
  if (b.detailFetched && isFoodBusiness(b.category) && (b.menuLink || website || b.photoUrls?.length)) {
    try {
      await enqueueGmapsMenu({ tenantId, contactId, masterAgentId });
    } catch (err) {
      logger.debug({ err, contactId }, 'gmaps ingest: menu-vision dispatch failed (non-fatal)');
    }
  }

  return { status, contactId, dealId: deal.id, companyId: company.id, mapsUrl, needsDetail };
}

/** Treat empty strings as undefined so they don't overwrite or persist as ''. */
function emptyToUndef<T>(v: T | null | undefined): T | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string' && v.trim() === '') return undefined;
  return v;
}

function extractDomain(url: string): string | undefined {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
