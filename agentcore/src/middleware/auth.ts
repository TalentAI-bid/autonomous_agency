import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import { env } from '../config/env.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';

type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

interface JWTPayload {
  tenantId: string;
  userId: string;
  role: UserRole;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JWTPayload;
    user: JWTPayload;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    userId: string;
    userRole: UserRole;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(fjwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: '7d' },
  });

  fastify.decorate('authenticate', async function (request: FastifyRequest, _reply: FastifyReply) {
    try {
      const decoded = await request.jwtVerify<JWTPayload>();
      request.tenantId = decoded.tenantId;
      request.userId = decoded.userId;
      request.userRole = decoded.role;
    } catch (_err) {
      throw new UnauthorizedError('Invalid or expired token');
    }
  });

  fastify.decorate('requireRole', function (...roles: string[]) {
    return async function (request: FastifyRequest, _reply: FastifyReply) {
      if (!roles.includes(request.userRole)) {
        throw new ForbiddenError(`Requires one of roles: ${roles.join(', ')}`);
      }
    };
  });

  fastify.decorateRequest('tenantId', '');
  fastify.decorateRequest('userId', '');
  fastify.decorateRequest('userRole', 'viewer');
}

export default fp(authPlugin, { name: 'auth' });
