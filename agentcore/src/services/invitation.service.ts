import crypto from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../config/database.js';
import { invitations, tenants, users, userTenants } from '../db/schema/index.js';
import type { Invitation } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { sendTransactionalEmail } from './transactional-email.service.js';
import { buildInvitationEmail } from './invitation-email.template.js';
import logger from '../utils/logger.js';

export type InvitableRole = 'admin' | 'member' | 'viewer';
const VALID_ROLES: InvitableRole[] = ['admin', 'member', 'viewer'];

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function buildInviteUrl(token: string): string {
  return `${env.DASHBOARD_URL.replace(/\/$/, '')}/invite/${token}`;
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createInvitation(params: {
  tenantId: string;
  email: string;
  role: string;
  invitedByUserId: string;
}): Promise<{ invitation: Invitation; inviteUrl: string }> {
  const email = normalizeEmail(params.email);
  if (!email) throw new ValidationError('email is required');
  if (!VALID_ROLES.includes(params.role as InvitableRole)) {
    throw new ValidationError(`role must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const [tenant] = await db.select({ id: tenants.id, name: tenants.name })
    .from(tenants).where(eq(tenants.id, params.tenantId)).limit(1);
  if (!tenant) throw new NotFoundError('Tenant', params.tenantId);

  // If the email is already a member of this tenant, no invite needed.
  const [existingUser] = await db.select({ id: users.id }).from(users)
    .where(eq(users.email, email)).limit(1);
  if (existingUser) {
    const [existingMember] = await db.select({ id: userTenants.id }).from(userTenants)
      .where(and(eq(userTenants.userId, existingUser.id), eq(userTenants.tenantId, params.tenantId)))
      .limit(1);
    if (existingMember) {
      throw new ConflictError(`${email} is already a member of this workspace`);
    }
  }

  // Block if there's already a pending invitation for this (tenant, email).
  const now = new Date();
  const [pending] = await db.select({ id: invitations.id }).from(invitations)
    .where(and(
      eq(invitations.tenantId, params.tenantId),
      eq(invitations.email, email),
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
      gt(invitations.expiresAt, now),
    ))
    .limit(1);
  if (pending) {
    throw new ConflictError(`A pending invitation already exists for ${email}`);
  }

  const token = generateToken();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  const [invitation] = await db.insert(invitations).values({
    tenantId: params.tenantId,
    email,
    role: params.role as InvitableRole,
    token,
    invitedBy: params.invitedByUserId,
    expiresAt,
  }).returning();
  if (!invitation) throw new Error('Failed to create invitation');

  const inviteUrl = buildInviteUrl(token);

  // Send the email best-effort; if SMTP isn't configured we still return the
  // inviteUrl so the inviter can copy/share it manually.
  try {
    const [inviter] = await db.select({ name: users.name, email: users.email })
      .from(users).where(eq(users.id, params.invitedByUserId)).limit(1);
    const { subject, html, text } = buildInvitationEmail({
      inviteUrl,
      tenantName: tenant.name,
      inviterName: inviter?.name ?? null,
      inviterEmail: inviter?.email ?? '',
      role: params.role,
      expiresAt,
    });
    await sendTransactionalEmail({ to: email, subject, html, text });
  } catch (err) {
    logger.warn({ err, email, tenantId: params.tenantId }, 'Failed to send invitation email — invite link still usable');
  }

  return { invitation, inviteUrl };
}

export async function findActiveInvitationByToken(token: string): Promise<Invitation | null> {
  const now = new Date();
  const [row] = await db.select().from(invitations)
    .where(and(
      eq(invitations.token, token),
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
      gt(invitations.expiresAt, now),
    ))
    .limit(1);
  return row ?? null;
}

export async function markInvitationAccepted(invitationId: string, acceptedUserId: string): Promise<void> {
  await db.update(invitations)
    .set({ acceptedAt: new Date(), acceptedUserId })
    .where(eq(invitations.id, invitationId));
}

export async function revokeInvitation(invitationId: string, tenantId: string): Promise<void> {
  const result = await db.update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, invitationId), eq(invitations.tenantId, tenantId)))
    .returning({ id: invitations.id });
  if (result.length === 0) throw new NotFoundError('Invitation', invitationId);
}

export { buildInviteUrl };
