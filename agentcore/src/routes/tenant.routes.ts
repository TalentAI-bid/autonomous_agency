import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTenantById, updateTenant, deleteTenant } from '../services/tenant.service.js';

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']).optional(),
  productType: z.enum(['recruitment', 'sales', 'both']).optional(),
  settings: z.record(z.unknown()).optional(),
});

export default async function tenantRoutes(fastify: FastifyInstance) {
  // All tenant routes require authentication and owner role
  fastify.addHook('onRequest', fastify.authenticate);
  fastify.addHook('preHandler', fastify.requireRole('owner', 'admin'));

  // GET /api/tenants — Get current tenant
  fastify.get('/', async (request) => {
    const tenant = await getTenantById(request.tenantId);
    return { data: tenant };
  });

  // PATCH /api/tenants — Update current tenant
  fastify.patch('/', async (request) => {
    const parsed = updateTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } };
    }

    const tenant = await updateTenant(request.tenantId, parsed.data);
    return { data: tenant };
  });

  // DELETE /api/tenants — Delete current tenant (owner only)
  fastify.delete('/', {
    preHandler: fastify.requireRole('owner'),
  }, async (request, reply) => {
    await deleteTenant(request.tenantId);
    reply.clearCookie('refreshToken', { path: '/' });
    return { success: true };
  });
}
