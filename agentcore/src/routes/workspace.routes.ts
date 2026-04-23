import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../config/database.js';
import { tenants, userTenants } from '../db/schema/index.js';
import { createTenant } from '../services/tenant.service.js';
import { generateAccessToken } from '../services/auth.service.js';
import { NotFoundError, ForbiddenError } from '../utils/errors.js';

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  productType: z.enum(['recruitment', 'sales', 'both']).optional(),
});

const switchWorkspaceSchema = z.object({
  tenantId: z.string().uuid(),
});

export default async function workspaceRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/workspaces — list user's workspaces
  fastify.get('/', async (request) => {
    const workspaces = await db.select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      plan: tenants.plan,
      role: userTenants.role,
    })
      .from(userTenants)
      .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
      .where(eq(userTenants.userId, request.userId));

    return { data: workspaces };
  });

  // POST /api/workspaces — create new workspace
  fastify.post('/', async (request, reply) => {
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const { name, slug, productType } = parsed.data;

    const tenant = await createTenant({ name, slug, productType });

    await db.insert(userTenants).values({
      userId: request.userId,
      tenantId: tenant.id,
      role: 'owner',
    });

    return reply.status(201).send({
      data: { id: tenant.id, name: tenant.name, slug: tenant.slug, role: 'owner' },
    });
  });

  // POST /api/workspaces/switch — switch active workspace
  fastify.post('/switch', async (request, reply) => {
    const parsed = switchWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parsed.error.flatten() });
    }

    const { tenantId } = parsed.data;

    const [membership] = await db.select({
      role: userTenants.role,
    })
      .from(userTenants)
      .where(and(eq(userTenants.userId, request.userId), eq(userTenants.tenantId, tenantId)))
      .limit(1);

    if (!membership) {
      throw new ForbiddenError('You do not belong to this workspace');
    }

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    if (!tenant) throw new NotFoundError('Workspace', tenantId);

    const accessToken = generateAccessToken(fastify, {
      tenantId: tenant.id,
      userId: request.userId,
      role: membership.role,
    });

    const workspaces = await db.select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      role: userTenants.role,
    })
      .from(userTenants)
      .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
      .where(eq(userTenants.userId, request.userId));

    return {
      data: {
        token: accessToken,
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        workspaces,
      },
    };
  });
}
