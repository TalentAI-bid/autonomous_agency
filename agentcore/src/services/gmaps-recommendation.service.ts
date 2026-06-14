// Generates an outreach recommendation for a Google Maps local-business lead and
// persists it onto the contact's sourceMetadata (cached, re-rendered by the
// dashboard). On-demand (called from POST /contacts/:id/ai-recommendation).
// Grounded-only via the prompt; throws only on a hard LLM/DB failure.

import { eq, and } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, companies } from '../db/schema/index.js';
import { extractJSON, type ChatMessage } from '../tools/together-ai.tool.js';
import {
  GMAPS_RECOMMENDATION_SYSTEM_PROMPT,
  buildGmapsRecommendationUserPrompt,
  type GmapsRecommendation,
  type GmapsRecommendationContext,
} from '../prompts/gmaps-recommendation.prompt.js';
import logger from '../utils/logger.js';

/** Strip HTML to a capped plain-text excerpt for the prompt. */
function htmlToText(html: unknown, cap = 1500): string {
  if (typeof html !== 'string' || !html) return '';
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > cap ? text.slice(0, cap) : text;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;
const arrStr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : String((x as { label?: string })?.label ?? ''))).filter(Boolean) : undefined;

export async function generateGmapsRecommendation(
  tenantId: string,
  contactId: string,
): Promise<GmapsRecommendation> {
  const [contact] = await withTenant(tenantId, async (tx) =>
    tx
      .select({
        id: contacts.id,
        companyId: contacts.companyId,
        companyName: contacts.companyName,
        firstName: contacts.firstName,
        location: contacts.location,
        sourceMetadata: contacts.sourceMetadata,
      })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
      .limit(1),
  );
  if (!contact) throw new Error('contact not found');

  const meta = (contact.sourceMetadata as Record<string, unknown>) ?? {};
  const website = str(meta.website);
  const menu = meta.menu && typeof meta.menu === 'object' ? (meta.menu as Record<string, unknown>) : null;

  const ctx: GmapsRecommendationContext = {
    businessName: contact.companyName || contact.firstName || 'this business',
    category: str(meta.category),
    address: str(meta.address) || str(contact.location),
    rating: typeof meta.rating === 'number' ? meta.rating : null,
    reviewsCount: typeof meta.reviewsCount === 'number' ? meta.reviewsCount : null,
    ratingDistribution: arrStr(meta.ratingDistribution),
    priceLevel: str(meta.priceLevel),
    pricePerPerson: str(meta.pricePerPerson),
    serviceOptions: arrStr(meta.serviceOptions),
    hasWebsite: !!website,
    website,
    hasMenuLink: !!str(meta.menuLink),
    hasMenuData: !!(menu && Array.isArray(menu.dishes) && menu.dishes.length),
    hours: typeof meta.hours === 'string' ? meta.hours : (meta.hours && typeof meta.hours === 'object' ? Object.values(meta.hours as Record<string, string>).join('; ') : undefined),
    aboutText: htmlToText(meta.aboutHtml) || str(meta.description),
    reviewsText: htmlToText(meta.reviewsHtml),
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: GMAPS_RECOMMENDATION_SYSTEM_PROMPT },
    { role: 'user', content: buildGmapsRecommendationUserPrompt(ctx) },
  ];

  const result = await extractJSON<GmapsRecommendation>(tenantId, messages);

  const aiRecommendation = { ...result, generatedAt: new Date().toISOString() };

  // Persist onto the contact (and mirror onto the company rawData) so the
  // dashboard reads it back without regenerating.
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(contacts)
      .set({ sourceMetadata: { ...meta, aiRecommendation }, updatedAt: new Date() })
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
        .set({ rawData: { ...rawData, aiRecommendation }, updatedAt: new Date() })
        .where(and(eq(companies.id, contact.companyId), eq(companies.tenantId, tenantId)));
    }
  });

  logger.info({ tenantId, contactId, priorityScore: result.priorityScore, fit: result.fit }, 'gmaps recommendation generated');
  return aiRecommendation;
}
