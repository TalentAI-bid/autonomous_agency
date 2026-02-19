import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Tenant isolation middleware.
 * After auth middleware sets request.tenantId, this plugin provides
 * utilities for tenant-scoped operations.
 *
 * Note: The actual SET LOCAL for RLS happens inside the withTenant()
 * helper from database.ts. This middleware ensures tenantId is present.
 */
async function tenantPlugin(fastify: FastifyInstance) {
  fastify.decorate('ensureTenant', async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.tenantId) {
      reply.status(400).send({
        error: {
          code: 'MISSING_TENANT',
          message: 'Tenant context is required',
        },
      });
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    ensureTenant: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(tenantPlugin, { name: 'tenant', dependencies: ['auth'] });
