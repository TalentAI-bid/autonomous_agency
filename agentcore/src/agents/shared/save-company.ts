import { eq, and, ilike, sql } from 'drizzle-orm';
import { withTenant } from '../../config/database.js';
import { companies, masterAgents } from '../../db/schema/index.js';
import type { Company, NewCompany } from '../../db/schema/index.js';

/**
 * Trailing legal-entity suffixes that the SAME company carries on one surface but
 * not another: a person's experience line reads "Pi DATA CENTERS Pvt. Ltd." while
 * the enriched company page is just "Pi Data Centers". Stripping these (along with
 * the ® ™ © ℠ glyphs) lets name-based dedup treat both as one company instead of
 * forking a duplicate. Kept to LEGAL entity markers only — NOT descriptive words
 * like "group"/"technologies"/"solutions", which distinguish real, separate firms.
 *
 * Order-sensitive in the regex alternation: longer tokens that share a prefix with
 * a shorter one (e.g. "corporation" vs "corp", "company" vs "co") come first so the
 * longer form is consumed whole rather than leaving a dangling "oration".
 */
const LEGAL_SUFFIX_ALTERNATION =
  'private|pvt|limited|ltd|incorporated|inc|corporation|corp|company|co|llc|plc|gmbh|sarl|sas|srl|spa|pty|llp|lp|ag|sa|bv|nv|oy|ab|as|kg';

/**
 * Canonical company name for dedup: drop trademark glyphs, fold punctuation and
 * whitespace, then peel off any run of trailing legal suffixes. MUST stay in lock-
 * step with {@link companyNameMatchesSql} (same steps, same order) so the JS-side
 * value and the SQL-side column normalization compare equal.
 */
export function normalizeCompanyName(name: string): string {
  let s = name.replace(/[®™©℠]/g, '').toLowerCase();
  s = s.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(new RegExp(`(\\s+(${LEGAL_SUFFIX_ALTERNATION}))+$`), '');
  return s.replace(/[^a-z0-9]+$/, '').trim();
}

/**
 * The LinkedIn company identifier — the segment after `/company/`. This is the
 * SAME across every person's profile that lists the company (e.g. `6437312`),
 * whereas the display NAME varies wildly ("Pi DATACENTERS" / "Pi DATA CENTERS
 * Pvt. Ltd." / "Pi Data Centers"). So it, not the name, is the reliable dedup
 * key. Note a company can be referenced by a numeric id ("6437312") on profiles
 * AND a vanity slug ("pidatacenters") on its own page — both are valid refs we
 * accumulate in rawData.linkedinCompanyIds.
 */
export function extractCompanyRef(linkedinUrl?: string | null): string | null {
  if (!linkedinUrl) return null;
  const m = linkedinUrl.match(/\/company\/([^/?#]+)/i);
  return m && m[1] ? m[1].toLowerCase() : null;
}

/** SQL predicate: a company whose stored URL ref OR learned id-aliases include `ref`. */
export function companyRefMatchesSql(ref: string) {
  return sql`(
    regexp_replace(lower(${companies.linkedinUrl}), '^.*/company/([^/?#]+).*$', '\\1') = ${ref}
    OR coalesce(${companies.rawData} -> 'linkedinCompanyIds', '[]'::jsonb) @> ${JSON.stringify([ref])}::jsonb
  )`;
}

/** Merge `ref` into a rawData object's `linkedinCompanyIds` alias list (dedup-safe). */
export function foldCompanyRef(rawData: unknown, ref: string | null): Record<string, unknown> {
  const base = ((rawData as Record<string, unknown>) ?? {});
  if (!ref) return base;
  const ids = Array.isArray(base.linkedinCompanyIds) ? (base.linkedinCompanyIds as unknown[]).map(String) : [];
  if (ids.includes(ref)) return base;
  return { ...base, linkedinCompanyIds: [...ids, ref] };
}

/** SQL predicate: the `companies.name` column equals `name` after the same normalization. */
export function companyNameMatchesSql(name: string) {
  const stripGlyphs = sql`regexp_replace(lower(${companies.name}), '[®™©℠]', '', 'g')`;
  const punctToSpace = sql`regexp_replace(${stripGlyphs}, '[.,]', ' ', 'g')`;
  const collapsed = sql`btrim(regexp_replace(${punctToSpace}, '\\s+', ' ', 'g'))`;
  const noSuffix = sql`regexp_replace(${collapsed}, '(\\s+(${sql.raw(LEGAL_SUFFIX_ALTERNATION)}))+$', '', 'g')`;
  return sql`btrim(regexp_replace(${noSuffix}, '[^a-z0-9]+$', '')) = ${normalizeCompanyName(name)}`;
}

/**
 * Shared company upsert helper — used by BaseAgent.saveOrUpdateCompany and by
 * the extension dispatcher (which has no BaseAgent instance).
 *
 * Performs: ID-pinned update → domain match → name match → insert.
 * Merges rawData JSONB on every update.
 */
export async function saveOrUpdateCompanyStatic(
  tenantId: string,
  data: Partial<NewCompany> & { name: string; domain?: string; id?: string },
  masterAgentId?: string,
): Promise<Company> {
  if (typeof data.name === 'object' && data.name !== null) {
    data.name = ((data.name as unknown) as { name?: string }).name || JSON.stringify(data.name);
  }
  data.name = String(data.name).trim();
  if (!data.name || data.name.length < 2) {
    throw new Error(`Invalid company name rejected: "${(data.name ?? '').slice(0, 80)}"`);
  }

  const validMasterAgentId = await resolveMasterAgentId(tenantId, masterAgentId);

  // The LinkedIn company id/slug is the reliable dedup key (names vary per profile).
  const incomingRef = extractCompanyRef(data.linkedinUrl as string | undefined);

  // Merge existing + incoming rawData AND fold the incoming ref into the alias list,
  // so a row learns every id/slug it's ever been seen under.
  const mergeRaw = (existingRaw: unknown, incomingRaw: unknown) =>
    foldCompanyRef(
      {
        ...((existingRaw as Record<string, unknown>) ?? {}),
        ...((incomingRaw as Record<string, unknown>) ?? {}),
      },
      incomingRef,
    );

  return withTenant(tenantId, async (tx) => {
    if (data.id) {
      const { id, ...updateData } = data;
      const existing = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.id, id), eq(companies.tenantId, tenantId)))
        .limit(1);
      if (existing.length > 0) {
        const [updated] = await tx
          .update(companies)
          .set({
            ...updateData,
            masterAgentId: validMasterAgentId,
            rawData: mergeRaw(existing[0]!.rawData, updateData.rawData),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, existing[0]!.id))
          .returning();
        return updated!;
      }
    }

    if (data.domain) {
      const existing = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.tenantId, tenantId), ilike(companies.domain, data.domain)))
        .limit(1);
      if (existing.length > 0) {
        const [updated] = await tx
          .update(companies)
          .set({
            ...data,
            masterAgentId: validMasterAgentId,
            rawData: mergeRaw(existing[0]!.rawData, data.rawData),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, existing[0]!.id))
          .returning();
        return updated!;
      }
    }

    // Match by LinkedIn company id/slug BEFORE name — this is what stops
    // "Pi DATACENTERS" (id 6437312) from forking a dup off "Pi Data Centers".
    if (incomingRef) {
      const byRef = await tx
        .select()
        .from(companies)
        .where(and(eq(companies.tenantId, tenantId), companyRefMatchesSql(incomingRef)))
        .limit(1);
      if (byRef.length > 0) {
        const [updated] = await tx
          .update(companies)
          .set({
            ...data,
            // Don't let a per-profile display name overwrite the canonical row name.
            name: byRef[0]!.name,
            masterAgentId: validMasterAgentId,
            rawData: mergeRaw(byRef[0]!.rawData, data.rawData),
            updatedAt: new Date(),
          })
          .where(eq(companies.id, byRef[0]!.id))
          .returning();
        return updated!;
      }
    }

    const byName = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), companyNameMatchesSql(data.name)))
      .limit(1);
    if (byName.length > 0) {
      const [updated] = await tx
        .update(companies)
        .set({
          ...data,
          masterAgentId: validMasterAgentId,
          rawData: mergeRaw(byName[0]!.rawData, data.rawData),
          updatedAt: new Date(),
        })
        .where(eq(companies.id, byName[0]!.id))
        .returning();
      return updated!;
    }

    const [created] = await tx
      .insert(companies)
      .values({
        tenantId,
        masterAgentId: validMasterAgentId,
        ...data,
        rawData: foldCompanyRef((data.rawData as Record<string, unknown>) ?? {}, incomingRef),
      })
      .returning();
    return created!;
  });
}

async function resolveMasterAgentId(tenantId: string, masterAgentId?: string): Promise<string | undefined> {
  if (!masterAgentId) return undefined;
  try {
    const [row] = await withTenant(tenantId, async (tx) => {
      return tx
        .select({ id: masterAgents.id })
        .from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, tenantId)))
        .limit(1);
    });
    return row ? masterAgentId : undefined;
  } catch {
    return undefined;
  }
}
