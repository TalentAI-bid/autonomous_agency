import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, tenants } from '../db/schema/index.js';
import {
  hashPassword,
  verifyPassword,
  generateAccessToken,
  generateRefreshToken,
  rotateRefreshToken,
  invalidateRefreshToken,
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

    // Check if email already exists
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      throw new ValidationError('Email already registered');
    }

    // Create tenant
    const tenant = await createTenant({
      name: tenantName,
      slug: tenantSlug,
      productType,
    });

    // Create owner user
    const passwordHash = await hashPassword(password);
    const [user] = await db.insert(users).values({
      tenantId: tenant.id,
      email,
      passwordHash,
      name,
      role: 'owner',
    }).returning();

    // Generate tokens
    const accessToken = generateAccessToken(fastify, {
      tenantId: tenant.id,
      userId: user!.id,
      role: 'owner',
    });
    const refreshToken = await generateRefreshToken(user!.id, tenant.id);

    reply.setCookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
      path: '/',
    });

    return reply.status(201).send({
      data: {
        token: accessToken,
        user: { id: user!.id, email: user!.email, name: user!.name, role: user!.role },
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      },
    });
  });

  // POST /api/auth/login
  fastify.post('/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid input', parsed.error.flatten());
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new UnauthorizedError('Invalid credentials');

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError('Invalid credentials');

    const accessToken = generateAccessToken(fastify, {
      tenantId: user.tenantId,
      userId: user.id,
      role: user.role,
    });
    const refreshToken = await generateRefreshToken(user.id, user.tenantId);

    reply.setCookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    // Look up tenant for response
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);

    return {
      data: {
        token: accessToken,
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : undefined,
      },
    };
  });

  // POST /api/auth/refresh
  fastify.post('/refresh', async (request, reply) => {
    const token = (request.cookies as Record<string, string>).refreshToken;
    if (!token) throw new UnauthorizedError('No refresh token');

    const result = await rotateRefreshToken(token);
    if (!result) throw new UnauthorizedError('Invalid refresh token');

    // Look up user for role
    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    if (!user) throw new UnauthorizedError('User not found');

    const accessToken = generateAccessToken(fastify, {
      tenantId: result.tenantId,
      userId: result.userId,
      role: user.role,
    });

    reply.setCookie('refreshToken', result.newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });

    return { data: { token: accessToken } };
  });

  // POST /api/auth/logout
  fastify.post('/logout', async (request, reply) => {
    const token = (request.cookies as Record<string, string>).refreshToken;
    if (token) {
      await invalidateRefreshToken(token);
    }
    reply.clearCookie('refreshToken', { path: '/' });
    return { success: true };
  });
}
