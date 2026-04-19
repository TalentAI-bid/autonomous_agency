import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getTenantById, updateTenant, deleteTenant } from '../services/tenant.service.js';

const updateTenantSchema = z.object({
  name: z.string().min(1).optional(),
  plan: z.enum(['free', 'starter', 'pro', 'enterprise']).optional(),
  productType: z.enum(['recruitment', 'sales', 'both']).optional(),
  settings: z.record(z.unknown()).optional(),
});

const companyProfileSchema = z.object({
  companyName: z.string().min(1).max(255),
  website: z.string().max(500).optional().or(z.literal('')),
  industry: z.string().max(255).optional(),
  companySize: z.string().max(50).optional(),
  foundedYear: z.number().int().min(1800).max(2100).optional().nullable(),
  headquarters: z.string().max(255).optional(),
  valueProposition: z.string().min(1).max(500),
  elevatorPitch: z.string().max(1000).optional(),
  targetMarketDescription: z.string().max(2000).optional(),
  icp: z.object({
    targetIndustries: z.array(z.string()).optional(),
    companySizes: z.array(z.string()).optional(),
    decisionMakerRoles: z.array(z.string()).optional(),
    regions: z.array(z.string()).optional(),
    painPointsAddressed: z.array(z.string()).optional(),
  }).optional(),
  differentiators: z.array(z.string()).optional(),
  socialProof: z.string().max(2000).optional(),
  defaultSenderName: z.string().max(100).optional(),
  defaultSenderTitle: z.string().max(100).optional(),
  calendlyUrl: z.string().max(500).optional().or(z.literal('')),
  callToAction: z.string().max(500).optional(),
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

  // GET /api/tenants/company-profile — Get company profile
  fastify.get('/company-profile', async (request) => {
    const tenant = await getTenantById(request.tenantId);
    const settings = (tenant.settings ?? {}) as Record<string, unknown>;
    return { data: settings.companyProfile ?? {} };
  });

  // PUT /api/tenants/company-profile — Update company profile
  fastify.put('/company-profile', async (request) => {
    const parsed = companyProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return { error: { code: 'VALIDATION_ERROR', message: 'Invalid input', details: parsed.error.flatten() } };
    }

    const tenant = await getTenantById(request.tenantId);
    const currentSettings = (tenant.settings ?? {}) as Record<string, unknown>;
    const updated = await updateTenant(request.tenantId, {
      settings: { ...currentSettings, companyProfile: parsed.data },
    });
    const updatedSettings = (updated.settings ?? {}) as Record<string, unknown>;
    return { data: updatedSettings.companyProfile };
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
