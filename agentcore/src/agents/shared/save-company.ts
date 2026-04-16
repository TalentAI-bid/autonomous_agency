import { eq, and, ilike } from 'drizzle-orm';
import { withTenant } from '../../config/database.js';
import { companies, masterAgents } from '../../db/schema/index.js';
import type { Company, NewCompany } from '../../db/schema/index.js';

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
            rawData: {
              ...((existing[0]!.rawData as Record<string, unknown>) ?? {}),
              ...((updateData.rawData as Record<string, unknown>) ?? {}),
            },
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
            rawData: {
              ...((existing[0]!.rawData as Record<string, unknown>) ?? {}),
              ...((data.rawData as Record<string, unknown>) ?? {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(companies.id, existing[0]!.id))
          .returning();
        return updated!;
      }
    }

    const byName = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.tenantId, tenantId), ilike(companies.name, data.name)))
      .limit(1);
    if (byName.length > 0) {
      const [updated] = await tx
        .update(companies)
        .set({
          ...data,
          masterAgentId: validMasterAgentId,
          rawData: {
            ...((byName[0]!.rawData as Record<string, unknown>) ?? {}),
            ...((data.rawData as Record<string, unknown>) ?? {}),
          },
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
        rawData: { ...((data.rawData as Record<string, unknown>) ?? {}) },
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
