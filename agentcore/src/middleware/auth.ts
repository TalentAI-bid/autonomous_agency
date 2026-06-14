import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import fjwt from '@fastify/jwt';
import { and, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';
import { verifySession } from '../services/auth.service.js';
import { db } from '../config/database.js';
import { userTenants } from '../db/schema/user-tenants.js';
import { users } from '../db/schema/users.js';

type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

// Old shape: tenantId baked into the JWT.
// New shape: tenantId omitted; resolved from user_tenants at request time.
// The middleware tolerates both during the multi-workspace transition.
interface JWTPayload {
  userId: string;
  role: UserRole;
  tenantId?: string;
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

// Resolve the active tenant for a tenant-less JWT. Tries (in order):
//   1. X-Active-Workspace header — must be a tenant the user is a member of.
//   2. user_tenants.is_default for this user.
//   3. users.tenant_id (legacy "home" tenant) — last-resort fallback.
// Returns the resolved (tenantId, role). Throws ForbiddenError if the requested
// tenant is not in user_tenants for this user.
async function resolveActiveTenant(
  userId: string,
  requestedTenantId: string | undefined,
  fallbackRole: UserRole,
): Promise<{ tenantId: string; role: UserRole }> {
  if (requestedTenantId) {
    const [m] = await db
      .select({ role: userTenants.role })
      .from(userTenants)
      .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, requestedTenantId)))
      .limit(1);
    if (!m) throw new ForbiddenError('Not a member of the requested workspace');
    return { tenantId: requestedTenantId, role: m.role as UserRole };
  }

  const [def] = await db
    .select({ tenantId: userTenants.tenantId, role: userTenants.role })
    .from(userTenants)
    .where(and(eq(userTenants.userId, userId), eq(userTenants.isDefault, true)))
    .limit(1);
  if (def) return { tenantId: def.tenantId, role: def.role as UserRole };

  const [u] = await db
    .select({ tenantId: users.tenantId, role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.tenantId) return { tenantId: u.tenantId, role: (u.role ?? fallbackRole) as UserRole };

  throw new ForbiddenError('No accessible workspace for this user');
}

// Public helper for routes that need to pick a tenant without going through
// the request-scoped flow (e.g. the WS extension handler resolves it from
// session.user_id when the session is tenant-less).
export async function getDefaultTenantForUser(userId: string): Promise<string | null> {
  const [def] = await db
    .select({ tenantId: userTenants.tenantId })
    .from(userTenants)
    .where(and(eq(userTenants.userId, userId), eq(userTenants.isDefault, true)))
    .limit(1);
  if (def) return def.tenantId;
  const [u] = await db
    .select({ tenantId: users.tenantId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.tenantId ?? null;
}

async function authPlugin(fastify: FastifyInstance) {
  await fastify.register(fjwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: '7d' },
  });

  fastify.decorate('authenticate', async function (request: FastifyRequest, _reply: FastifyReply) {
    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      request.log.warn(
        { url: request.url, hasAuth: !!request.headers.authorization },
        'Auth rejected: missing or malformed Authorization header',
      );
      throw new UnauthorizedError('Authentication required');
    }
    const token = match[1]!.trim();

    // Primary path: opaque Redis session (dashboard login). Always carries
    // tenantId because the dashboard rebinds tokens on workspace switch.
    const session = await verifySession(token);
    if (session) {
      request.tenantId = session.tenantId;
      request.userId = session.userId;
      request.userRole = session.role;
      return;
    }

    // Fallback: signed JWT (extension popup). May or may not carry tenantId.
    let decoded: JWTPayload;
    try {
      decoded = fastify.jwt.verify<JWTPayload>(token);
    } catch (err) {
      request.log.warn(
        { url: request.url, err: err instanceof Error ? err.message : String(err) },
        'Auth rejected: no Redis session and JWT verify failed',
      );
      throw new UnauthorizedError('Invalid or expired token');
    }

    request.userId = decoded.userId;

    if (decoded.tenantId) {
      // Legacy JWT from the pre-multi-workspace flow.
      request.tenantId = decoded.tenantId;
      request.userRole = decoded.role;
      return;
    }

    // Multi-workspace JWT: resolve active tenant via header / default / legacy
    // fallback. Membership is enforced when the header is present.
    const headerTenant = ((request.headers['x-active-workspace'] as string | undefined) ?? '').trim();
    const resolved = await resolveActiveTenant(decoded.userId, headerTenant || undefined, decoded.role);
    request.tenantId = resolved.tenantId;
    request.userRole = resolved.role;
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
