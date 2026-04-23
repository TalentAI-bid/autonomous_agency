import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, tenants, userTenants } from '../db/schema/index.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
} from '../services/auth.service.js';
import { createTenant } from '../services/tenant.service.js';
import { ValidationError, UnauthorizedError } from '../utils/errors.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  tenantName: z.string().min(1),
  tenantSlug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/).optional(),
  productType: z.enum(['recruitment', 'sales', 'both']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default async function authRoutes(fastify: FastifyInstance) {
  // POST /api/auth/register
  fastify.post('/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', parsed.error.flatten());
    }
    const { email, password, name, tenantName, tenantSlug, productType } = parsed.data;

    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new ValidationError('Email already registered');
    }

    const tenant = await createTenant({
      name: tenantName,
      slug: tenantSlug,
      productType,
    });

    const passwordHash = await hashPassword(password);
    const [user] = await db.insert(users).values({
      tenantId: tenant.id,
      email,
      passwordHash,
      name,
      role: 'owner',
    }).returning();

    await db.insert(userTenants).values({
      userId: user!.id,
      tenantId: tenant.id,
      role: 'owner',
    });

    const token = await createSession({
      tenantId: tenant.id,
      userId: user!.id,
      role: 'owner',
    });

    return reply.status(201).send({
      data: {
        token,
        user: { id: user!.id, email: user!.email, name: user!.name, role: user!.role },
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        workspaces: [{ id: tenant.id, name: tenant.name, slug: tenant.slug, role: 'owner' }],
      },
    });
  });

  // POST /api/auth/login
  fastify.post('/login', async (request) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', parsed.error.flatten());
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    const token = await createSession({
      tenantId: user.tenantId,
      userId: user.id,
      role: user.role,
    });

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);

    const workspaces = await db.select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      role: userTenants.role,
    })
      .from(userTenants)
      .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
      .where(eq(userTenants.userId, user.id));

    return {
      data: {
        token,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : undefined,
        workspaces,
      },
    };
  });

  // POST /api/auth/logout — deletes the Redis session for the Bearer token,
  // so the token stops working everywhere immediately. Best-effort: we never
  // fail logout even if the session was already gone or the header is missing.
  fastify.post('/logout', async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) {
      try {
        await destroySession(match[1]!.trim());
      } catch (err) {
        request.log.warn({ err }, 'destroySession failed during /logout');
      }
    }
    reply.clearCookie('refreshToken', { path: '/' });
    return { success: true };
  });
}
