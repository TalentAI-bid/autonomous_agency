// Shared resolver for `tenant.messagingConfig`. Both the Message Studio
// and the LinkedIn Inbox Copilot call this before generating anything —
// it makes sure the messaging config has a useful `value_prop` by
// auto-deriving from the tenant's already-configured Company Profile
// (`tenants.settings.companyProfile`) + Products table, persisting the
// result so subsequent reads (and the /settings/messaging page) see the
// same values.
//
// Truthy `value_prop` is the "user has configured something" sentinel.
// Once it's set, this resolver returns the saved config unchanged.

import { eq, and, asc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { tenants, products } from '../db/schema/index.js';
import type { MessagingConfig } from '../db/schema/tenants.js';
import { resolveSenderFirstName } from './sender.service.js';
import { ValidationError } from '../utils/errors.js';

export const MESSAGING_NOT_CONFIGURED_ERROR =
  'Configure your messaging at /settings/messaging or at least your Company Profile at /settings/company first. value_prop is required before generating messages.';

export function isMessagingConfigSufficient(config: MessagingConfig): boolean {
  return !!(config.value_prop && config.value_prop.trim().length > 0);
}

// CompanyProfile shape mirrors `tenants.settings.companyProfile`.
// Kept here so the resolver is self-contained.
export interface CompanyProfileICP {
  targetIndustries?: string[];
  companySizes?: string[];
  decisionMakerRoles?: string[];
  regions?: string[];
  painPointsAddressed?: string[];
}

export interface CompanyProfile {
  companyName?: string;
  website?: string;
  industry?: string;
  companySize?: string;
  foundedYear?: number | null;
  headquarters?: string;
  valueProposition?: string;
  elevatorPitch?: string;
  targetMarketDescription?: string;
  icp?: CompanyProfileICP;
  differentiators?: string[];
  socialProof?: string;
  defaultSenderName?: string;
  defaultSenderTitle?: string;
}

export function icpToText(icp?: CompanyProfileICP): string {
  if (!icp) return '';
  const headParts: string[] = [];
  if (icp.targetIndustries?.length) headParts.push(icp.targetIndustries.join(', '));
  if (icp.companySizes?.length) headParts.push(`(${icp.companySizes.join('/')})`);
  if (icp.regions?.length) headParts.push(`in ${icp.regions.join('/')}`);
  const line1 = headParts.join(' ');

  const trailing: string[] = [];
  if (icp.decisionMakerRoles?.length) {
    trailing.push(`Decision makers: ${icp.decisionMakerRoles.join(', ')}.`);
  }
  if (icp.painPointsAddressed?.length) {
    trailing.push(`Pain points: ${icp.painPointsAddressed.join('; ')}.`);
  }
  return [line1 && `Target: ${line1}.`, ...trailing].filter(Boolean).join(' ');
}

export function deriveMessagingConfig(
  profile: CompanyProfile,
  prods: Array<{ pricingModel: string | null; pricingDetails: string | null; differentiators: string[] | null }>,
): MessagingConfig {
  const firstPriced = prods.find((p) => !!(p.pricingDetails || p.pricingModel));
  const pricing = firstPriced?.pricingDetails || firstPriced?.pricingModel || '';

  const companyDifferentiators = profile.differentiators ?? [];
  const fallbackProductDifferentiators = prods.find((p) => p.differentiators?.length)?.differentiators ?? [];
  const differentiator = (companyDifferentiators.length
    ? companyDifferentiators
    : fallbackProductDifferentiators
  ).join('; ');

  return {
    sender_name: profile.defaultSenderName || undefined,
    sender_title: profile.defaultSenderTitle || undefined,
    sender_location: profile.headquarters || undefined,
    sender_company: profile.companyName || undefined,
    value_prop: profile.valueProposition || profile.elevatorPitch || undefined,
    target_icp: icpToText(profile.icp) || profile.targetMarketDescription || undefined,
    differentiator: differentiator || undefined,
    pricing_summary: pricing || undefined,
    brand_voice_notes: undefined,
  };
}

/**
 * Returns a usable `MessagingConfig` for the tenant, auto-deriving and
 * persisting from Company Profile + Products on first call.
 *
 * Caller contract: if the returned config still has no `value_prop`, the
 * caller should surface a "configure your messaging / company profile"
 * error to the user — there's nothing to derive from.
 */
export async function ensureMessagingConfig(tenantId: string): Promise<MessagingConfig> {
  // 1. Read tenant.
  const [tenant] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  });
  if (!tenant) return {};

  const saved = (tenant.messagingConfig ?? {}) as MessagingConfig;
  if (saved.value_prop && saved.value_prop.trim()) {
    // User has saved something — respect it.
    return saved;
  }

  // 2. Derive from Company Profile + products.
  const settings = (tenant.settings ?? {}) as Record<string, unknown>;
  const profile = (settings.companyProfile ?? {}) as CompanyProfile;

  const activeProducts = await withTenant(tenantId, async (tx) => {
    return tx
      .select({
        pricingModel: products.pricingModel,
        pricingDetails: products.pricingDetails,
        differentiators: products.differentiators,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)))
      .orderBy(asc(products.sortOrder))
      .limit(5);
  });

  const derived = deriveMessagingConfig(profile, activeProducts);

  // 3. If derive yielded nothing useful, return the partial saved config
  // and let the caller error out. Don't persist an empty derive.
  if (!derived.value_prop || !derived.value_prop.trim()) {
    return saved;
  }

  // 4. Persist. Layer any partial saved fields ON TOP of derived so the
  // user's existing edits win field-by-field.
  const merged: MessagingConfig = { ...derived, ...saved };
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(tenants)
      .set({ messagingConfig: merged, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId));
  });

  return merged;
}

export interface ColdEmailSender {
  senderFirstName?: string;
  senderTitle?: string;
  senderLocation?: string;
  companyName?: string;
  companyDescription?: string;
  valueProposition?: string;
  differentiators?: string[];
  website?: string;
  products?: Array<{
    name: string;
    description?: string | null;
    keyFeatures?: string[] | null;
    painPointsSolved?: string[] | null;
  }>;
}

/**
 * Build the cold-email `sender` object from a workspace's Company Profile +
 * Products. This is the single source of sender identity for first-touch
 * drafts — it intentionally ignores per-agent config so a draft always
 * reflects the workspace it's generated in.
 *
 * Fails loud (matching Message Studio): throws ValidationError if the workspace
 * has no usable messaging config, and resolveSenderFirstName throws if the
 * account holder's name is unset — never sign off with a fabricated name.
 */
export async function buildColdEmailSender(tenantId: string): Promise<ColdEmailSender> {
  const config = await ensureMessagingConfig(tenantId);
  if (!isMessagingConfigSufficient(config)) {
    throw new ValidationError(MESSAGING_NOT_CONFIGURED_ERROR);
  }

  const senderFirstName = await resolveSenderFirstName(tenantId);

  const [tenant] = await withTenant(tenantId, async (tx) => {
    return tx.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  });
  const profile = ((tenant?.settings ?? {}) as Record<string, unknown>).companyProfile as CompanyProfile | undefined;

  const activeProducts = await withTenant(tenantId, async (tx) => {
    return tx
      .select({
        name: products.name,
        description: products.description,
        keyFeatures: products.keyFeatures,
        painPointsSolved: products.painPointsSolved,
      })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.isActive, true)))
      .orderBy(asc(products.sortOrder))
      .limit(5);
  });

  return {
    senderFirstName,
    senderTitle: config.sender_title,
    senderLocation: config.sender_location,
    companyName: config.sender_company,
    companyDescription: config.value_prop,
    valueProposition: config.pricing_summary || config.differentiator,
    differentiators: config.differentiator ? [config.differentiator] : undefined,
    website: profile?.website,
    products: activeProducts.length > 0 ? activeProducts : undefined,
  };
}
