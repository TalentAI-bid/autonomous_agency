import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, count } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { products, tenants } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { getTenantById } from '../services/tenant.service.js';

const PRODUCT_LIMITS: Record<string, number> = {
  free: 1,
  starter: 5,
  pro: 20,
  enterprise: Infinity,
};

const PRICING_MODELS = ['subscription', 'per_seat', 'one_time', 'usage_based', 'freemium', 'custom'] as const;

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().max(100).optional(),
  targetAudience: z.string().optional(),
  painPointsSolved: z.array(z.string()).optional(),
  keyFeatures: z.array(z.string()).optional(),
  differentiators: z.array(z.string()).optional(),
  pricingModel: z.enum(PRICING_MODELS).optional(),
  pricingDetails: z.string().optional(),
  isActive: z.boolean().optional(),
});

const updateProductSchema = createProductSchema.partial();

export default async function productRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/products — List all products for tenant
  fastify.get('/', async (request) => {
    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(products)
        .where(eq(products.tenantId, request.tenantId))
        .orderBy(products.sortOrder, desc(products.createdAt));
    });
    return { data: results };
  });

  // GET /api/products/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [product] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(products)
        .where(and(eq(products.id, id), eq(products.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!product) throw new NotFoundError('Product', id);
    return { data: product };
  });

  // POST /api/products — Create product (with plan limit check)
  fastify.post('/', async (request, reply) => {
    const parsed = createProductSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    // Check plan limit
    const tenant = await getTenantById(request.tenantId);
    const limit = PRODUCT_LIMITS[tenant.plan] ?? 1;

    const [{ value: currentCount }] = await withTenant(request.tenantId, async (tx) => {
      return tx.select({ value: count() }).from(products)
        .where(eq(products.tenantId, request.tenantId));
    });

    if (currentCount >= limit) {
      return reply.status(403).send({
        error: {
          code: 'PLAN_LIMIT_REACHED',
          message: `Your ${tenant.plan} plan allows up to ${limit} product${limit === 1 ? '' : 's'}. Upgrade to add more.`,
        },
      });
    }

    const [product] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(products).values({
        tenantId: request.tenantId,
        ...parsed.data,
      }).returning();
    });

    return reply.status(201).send({ data: product });
  });

  // PATCH /api/products/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateProductSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [product] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(products)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(products.id, id), eq(products.tenantId, request.tenantId)))
        .returning();
    });
    if (!product) throw new NotFoundError('Product', id);
    return { data: product };
  });

  // DELETE /api/products/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(products)
        .where(and(eq(products.id, id), eq(products.tenantId, request.tenantId)))
        .returning({ id: products.id });
    });
    if (result.length === 0) throw new NotFoundError('Product', id);
    return { success: true };
  });
}
