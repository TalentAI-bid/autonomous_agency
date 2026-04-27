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
import {
  findActiveInvitationByToken,
  markInvitationAccepted,
} from '../services/invitation.service.js';
import { ValidationError, UnauthorizedError, NotFoundError, ConflictError } from '../utils/errors.js';

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

    // Defensive backfill: ensure the user's home tenant (users.tenantId) has a
    // matching user_tenants row. Older signups predate the bridge table, so the
    // workspace-switcher would otherwise omit the user's original tenant the
    // moment they create a second workspace.
    await db.insert(userTenants)
      .values({ userId: user.id, tenantId: user.tenantId, role: 'owner' })
      .onConflictDoNothing();

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

  // GET /api/auth/invitations/:token — preview an invite (public, no auth).
  fastify.get<{ Params: { token: string } }>('/invitations/:token', async (request) => {
    const invite = await findActiveInvitationByToken(request.params.token);
    if (!invite) throw new NotFoundError('Invitation');

    const [tenant] = await db.select({ name: tenants.name })
      .from(tenants).where(eq(tenants.id, invite.tenantId)).limit(1);
    let inviterEmail: string | null = null;
    let inviterName: string | null = null;
    if (invite.invitedBy) {
      const [inviter] = await db.select({ email: users.email, name: users.name })
        .from(users).where(eq(users.id, invite.invitedBy)).limit(1);
      inviterEmail = inviter?.email ?? null;
      inviterName = inviter?.name ?? null;
    }

    return {
      data: {
        email: invite.email,
        role: invite.role,
        tenantName: tenant?.name ?? 'Workspace',
        inviterEmail,
        inviterName,
        expiresAt: invite.expiresAt,
      },
    };
  });

  // POST /api/auth/invitations/:token/accept
  // Two flows:
  //  - Existing user (users.email matches invited email) → just attach to tenant.
  //  - New user → create user + attach to tenant. Requires { name, password }.
  fastify.post<{ Params: { token: string } }>('/invitations/:token/accept', async (request, reply) => {
    const acceptSchema = z.object({
      name: z.string().min(1).optional(),
      password: z.string().min(8).optional(),
    });
    const parsed = acceptSchema.safeParse(request.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const invite = await findActiveInvitationByToken(request.params.token);
    if (!invite) throw new NotFoundError('Invitation');

    const [existingUser] = await db.select().from(users)
      .where(eq(users.email, invite.email)).limit(1);

    let userId: string;
    let userRecord: { id: string; email: string; name: string | null; role: string };

    if (existingUser) {
      // Add membership row (idempotent).
      await db.insert(userTenants).values({
        userId: existingUser.id,
        tenantId: invite.tenantId,
        role: invite.role,
      }).onConflictDoNothing();
      userId = existingUser.id;
      userRecord = {
        id: existingUser.id,
        email: existingUser.email,
        name: existingUser.name,
        role: existingUser.role,
      };
    } else {
      if (!parsed.data.password || !parsed.data.name) {
        throw new ValidationError('name and password are required for new users');
      }
      const passwordHash = await hashPassword(parsed.data.password);
      const [created] = await db.insert(users).values({
        tenantId: invite.tenantId,
        email: invite.email,
        passwordHash,
        name: parsed.data.name,
        role: 'member',
      }).returning();
      if (!created) throw new ConflictError('Failed to create user');
      await db.insert(userTenants).values({
        userId: created.id,
        tenantId: invite.tenantId,
        role: invite.role,
      });
      userId = created.id;
      userRecord = { id: created.id, email: created.email, name: created.name, role: created.role };
    }

    await markInvitationAccepted(invite.id, userId);

    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, invite.tenantId)).limit(1);
    if (!tenant) throw new NotFoundError('Tenant');

    const token = await createSession({
      tenantId: invite.tenantId,
      userId,
      role: invite.role,
    });

    const workspaces = await db.select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      role: userTenants.role,
    })
      .from(userTenants)
      .innerJoin(tenants, eq(userTenants.tenantId, tenants.id))
      .where(eq(userTenants.userId, userId));

    return reply.status(existingUser ? 200 : 201).send({
      data: {
        token,
        user: userRecord,
        tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
        workspaces,
      },
    });
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
