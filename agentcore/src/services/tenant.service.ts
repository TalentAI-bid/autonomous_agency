import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tenants, type NewTenant, type Tenant } from '../db/schema/index.js';
import { NotFoundError, ConflictError } from '../utils/errors.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export async function createTenant(data: {
  name: string;
  slug?: string;
  plan?: NewTenant['plan'];
  productType?: NewTenant['productType'];
  settings?: Record<string, unknown>;
}): Promise<Tenant> {
  const slug = data.slug || slugify(data.name);

  // Check slug uniqueness
  const existing = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (existing.length > 0) {
    throw new ConflictError(`Tenant with slug '${slug}' already exists`);
  }

  const [tenant] = await db.insert(tenants).values({
    name: data.name,
    slug,
    plan: data.plan,
    productType: data.productType,
    settings: data.settings || {},
  }).returning();

  return tenant!;
}

export async function getTenantById(id: string): Promise<Tenant> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  if (!tenant) throw new NotFoundError('Tenant', id);
  return tenant;
}

export async function getTenantBySlug(slug: string): Promise<Tenant> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  if (!tenant) throw new NotFoundError('Tenant');
  return tenant;
}

export async function updateTenant(
  id: string,
  data: Partial<Pick<Tenant, 'name' | 'plan' | 'productType' | 'settings'>>,
): Promise<Tenant> {
  const [tenant] = await db
    .update(tenants)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(tenants.id, id))
    .returning();
  if (!tenant) throw new NotFoundError('Tenant', id);
  return tenant;
}

export async function deleteTenant(id: string): Promise<void> {
  const result = await db.delete(tenants).where(eq(tenants.id, id)).returning({ id: tenants.id });
  if (result.length === 0) throw new NotFoundError('Tenant', id);
}
