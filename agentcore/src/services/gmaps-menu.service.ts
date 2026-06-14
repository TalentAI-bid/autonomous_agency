// Best-effort menu extraction for Google Maps food businesses. Runs off the
// gmaps-menu queue after a place-detail scrape yields photos. Pulls the photos,
// asks a Bedrock vision model to read any visible menu, and persists the
// structured result onto the contact + company. Fail-soft throughout: when no
// menu is legible it stores nothing rather than fabricate one
// (see [[feedback_fail_loud_over_fabricate]]).

import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, companies } from '../db/schema/index.js';
import { extractVisionJSON, type VisionImage } from '../tools/together-ai.tool.js';
import {
  GMAPS_MENU_SYSTEM_PROMPT,
  buildGmapsMenuUserPrompt,
  type GmapsMenuExtraction,
} from '../prompts/gmaps-menu.prompt.js';
import logger from '../utils/logger.js';

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image

/** Bump a Google photo thumbnail to a larger size for legible OCR. */
function upscaleGooglePhoto(url: string): string {
  // lh3.googleusercontent.com URLs carry a "=w408-h544-..." sizing suffix.
  return url.replace(/=w\d+-h\d+[^?]*$/, '=w1024-h1024');
}

type ImgFormat = VisionImage['format'];

/** Fetch an image URL and return base64 bytes + format, or null on any failure. */
async function fetchImage(url: string): Promise<VisionImage | null> {
  try {
    const res = await fetch(upscaleGooglePhoto(url), { redirect: 'follow' });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || 'image/jpeg').toLowerCase();
    if (!/^image\//.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    const fmt = type.replace('image/', '').replace('jpg', 'jpeg');
    const format: ImgFormat = (['jpeg', 'png', 'gif', 'webp'] as const).includes(fmt as ImgFormat)
      ? (fmt as ImgFormat)
      : 'jpeg';
    return { base64: buf.toString('base64'), format };
  } catch {
    return null;
  }
}

function isUsefulExtraction(m: GmapsMenuExtraction | null | undefined): m is GmapsMenuExtraction {
  if (!m) return false;
  const hasDishes = Array.isArray(m.dishes) && m.dishes.some((d) => d?.name && d.name.trim());
  return !!m.readable && hasDishes;
}

/**
 * Extract and persist a menu for one Google Maps food-business contact.
 * Returns true when a menu was stored, false otherwise (no images, nothing
 * readable, etc.). Never throws for the "nothing found" case.
 */
export async function extractAndStoreGmapsMenu(tenantId: string, contactId: string): Promise<boolean> {
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
    logger.debug({ tenantId, contactId }, 'gmaps menu: contact not found, skipping');
    return false;
  }

  const meta = (contact.sourceMetadata as Record<string, unknown>) ?? {};
  const photoUrls = Array.isArray(meta.photoUrls) ? (meta.photoUrls as string[]) : [];
  const category = typeof meta.category === 'string' ? meta.category : undefined;
  const name = contact.companyName || 'this business';

  if (photoUrls.length === 0) {
    logger.debug({ tenantId, contactId }, 'gmaps menu: no photos to analyze, skipping');
    return false;
  }

  // Fetch image bytes (skip any that fail); bail if none survive.
  const images: VisionImage[] = [];
  for (const u of photoUrls.slice(0, MAX_IMAGES)) {
    const img = await fetchImage(u);
    if (img) images.push(img);
  }
  if (images.length === 0) {
    logger.debug({ tenantId, contactId }, 'gmaps menu: no fetchable images, skipping');
    return false;
  }

  let extraction: GmapsMenuExtraction | null = null;
  try {
    extraction = await extractVisionJSON<GmapsMenuExtraction>(
      tenantId,
      GMAPS_MENU_SYSTEM_PROMPT,
      buildGmapsMenuUserPrompt(name, category),
      images,
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err), tenantId, contactId },
      'gmaps menu: vision call failed (non-fatal)',
    );
    return false;
  }

  if (!isUsefulExtraction(extraction)) {
    logger.debug({ tenantId, contactId }, 'gmaps menu: nothing readable in photos (fail-soft)');
    return false;
  }

  const menu = {
    ...extraction,
    extractedAt: new Date().toISOString(),
    source: 'gmaps_vision',
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
    { tenantId, contactId, dishCount: extraction.dishes?.length ?? 0, cuisine: extraction.cuisine },
    'gmaps menu: extracted and stored',
  );
  return true;
}
