import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invitations, userTenants, users } from '../db/schema/index.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import {
  createInvitation,
  revokeInvitation,
  buildInviteUrl,
} from '../services/invitation.service.js';

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'viewer']),
});

const updateRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

async function countOwners(tenantId: string): Promise<number> {
  const rows = await db.select({ id: userTenants.id })
    .from(userTenants)
    .where(and(eq(userTenants.tenantId, tenantId), eq(userTenants.role, 'owner')));
  return rows.length;
}

async function requireMembership(userId: string, tenantId: string): Promise<{ role: string }> {
  const [m] = await db.select({ role: userTenants.role }).from(userTenants)
    .where(and(eq(userTenants.userId, userId), eq(userTenants.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new ForbiddenError('Not a member of this workspace');
  return m;
}

export default async function teamRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/team/members
  fastify.get('/members', async (request) => {
    const rows = await db.select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: userTenants.role,
      joinedAt: userTenants.joinedAt,
    })
      .from(userTenants)
      .innerJoin(users, eq(users.id, userTenants.userId))
      .where(eq(userTenants.tenantId, request.tenantId))
      .orderBy(desc(userTenants.joinedAt));
    return { data: rows };
  });

  // GET /api/team/invitations  (pending only)
  fastify.get('/invitations', async (request) => {
    const now = new Date();
    const rows = await db.select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      token: invitations.token,
      createdAt: invitations.createdAt,
      expiresAt: invitations.expiresAt,
    })
      .from(invitations)
      .where(and(
        eq(invitations.tenantId, request.tenantId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ))
      .orderBy(desc(invitations.createdAt));

    const data = rows
      .filter((r) => r.expiresAt > now)
      .map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        inviteUrl: buildInviteUrl(r.token),
      }));
    return { data };
  });

  // POST /api/team/invitations
  fastify.post('/invitations', async (request, reply) => {
    if (request.userRole !== 'owner' && request.userRole !== 'admin') {
      throw new ForbiddenError('Only owners and admins can invite members');
    }
    const parsed = inviteSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { invitation, inviteUrl } = await createInvitation({
      tenantId: request.tenantId,
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByUserId: request.userId,
    });

    return reply.status(201).send({
      data: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        inviteUrl,
      },
    });
  });

  // DELETE /api/team/invitations/:id  (revoke)
  fastify.delete<{ Params: { id: string } }>('/invitations/:id', async (request, reply) => {
    if (request.userRole !== 'owner' && request.userRole !== 'admin') {
      throw new ForbiddenError('Only owners and admins can revoke invitations');
    }
    await revokeInvitation(request.params.id, request.tenantId);
    return reply.status(204).send();
  });

  // PATCH /api/team/members/:userId  { role }
  fastify.patch<{ Params: { userId: string } }>('/members/:userId', async (request) => {
    if (request.userRole !== 'owner' && request.userRole !== 'admin') {
      throw new ForbiddenError('Only owners and admins can change member roles');
    }
    const parsed = updateRoleSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());
    const { role: newRole } = parsed.data;
    const targetUserId = request.params.userId;

    const target = await requireMembership(targetUserId, request.tenantId);

    // Only owners can promote anyone to owner.
    if (newRole === 'owner' && request.userRole !== 'owner') {
      throw new ForbiddenError('Only owners can promote members to owner');
    }

    // Prevent removing the last owner.
    if (target.role === 'owner' && newRole !== 'owner') {
      const owners = await countOwners(request.tenantId);
      if (owners <= 1) {
        throw new ValidationError('Cannot demote the last owner — promote another member to owner first');
      }
    }

    const [updated] = await db.update(userTenants)
      .set({ role: newRole })
      .where(and(eq(userTenants.userId, targetUserId), eq(userTenants.tenantId, request.tenantId)))
      .returning();
    if (!updated) throw new NotFoundError('Membership');
    return { data: { userId: targetUserId, role: updated.role } };
  });

  // DELETE /api/team/members/:userId
  fastify.delete<{ Params: { userId: string } }>('/members/:userId', async (request, reply) => {
    if (request.userRole !== 'owner' && request.userRole !== 'admin') {
      throw new ForbiddenError('Only owners and admins can remove members');
    }
    const targetUserId = request.params.userId;
    const target = await requireMembership(targetUserId, request.tenantId);

    if (target.role === 'owner') {
      const owners = await countOwners(request.tenantId);
      if (owners <= 1) {
        throw new ValidationError('Cannot remove the last owner — promote another member to owner first');
      }
      // Admins cannot remove owners.
      if (request.userRole === 'admin') {
        throw new ForbiddenError('Admins cannot remove owners');
      }
    }

    if (targetUserId === request.userId && target.role === 'owner') {
      const owners = await countOwners(request.tenantId);
      if (owners <= 1) {
        throw new ValidationError('Cannot remove yourself as the last owner');
      }
    }

    await db.delete(userTenants)
      .where(and(eq(userTenants.userId, targetUserId), eq(userTenants.tenantId, request.tenantId)));
    return reply.status(204).send();
  });
}
