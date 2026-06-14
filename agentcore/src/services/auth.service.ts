import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '../queues/setup.js';

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const ACCESS_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface SessionPayload {
  userId: string;
  tenantId: string;
  role: UserRole;
}

// Extension JWT after the multi-workspace migration: tenant-less. The
// dispatcher and middleware look up the active tenant from user_tenants
// (default workspace) or the X-Active-Workspace header at request time.
export interface ExtensionTokenPayload {
  userId: string;
  role: UserRole;
  // Legacy field — only set when minted by the pre-multi-workspace code path.
  // The auth middleware accepts both shapes during the grace period.
  tenantId?: string;
}

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = createRedisConnection();
  }
  return redis;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─── Dashboard opaque sessions (7-day, Redis-backed) ─────────────────────────
// One token per login. Stored as sha256(token) → JSON payload with 7d TTL.
// No JWT, no signing, no refresh rotation. On logout we DEL the key.

export async function createSession(payload: SessionPayload): Promise<string> {
  const token = `tai_${crypto.randomBytes(32).toString('hex')}`;
  await getRedis().setex(
    `session:${hashToken(token)}`,
    SESSION_TTL_SECONDS,
    JSON.stringify(payload),
  );
  return token;
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  const data = await getRedis().get(`session:${hashToken(token)}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as SessionPayload;
  } catch {
    return null;
  }
}

export async function destroySession(token: string): Promise<void> {
  await getRedis().del(`session:${hashToken(token)}`);
}

// ─── Extension JWT + refresh token flow ──────────────────────────────────────
// Multi-workspace mode: tokens carry only userId; the active tenant is
// resolved at request time from user_tenants (default workspace) or, for
// scoped routes, from the X-Active-Workspace header. Old SessionPayload-shaped
// arguments still work — the JWT just signs whatever is given — so callers can
// migrate at their own pace and the auth middleware tolerates both shapes.

export function generateAccessToken(
  fastify: FastifyInstance,
  payload: ExtensionTokenPayload | SessionPayload,
): string {
  return fastify.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export async function generateRefreshToken(
  userId: string,
  tenantId?: string,
): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  // Store only userId by default; tenantId is preserved when provided so any
  // legacy caller still gets the same blob shape it used to read.
  const blob: { userId: string; tenantId?: string } = { userId };
  if (tenantId) blob.tenantId = tenantId;
  await getRedis().setex(
    `refresh:${hashToken(token)}`,
    REFRESH_TOKEN_EXPIRY_SECONDS,
    JSON.stringify(blob),
  );
  return token;
}

export async function verifyRefreshToken(
  token: string,
): Promise<{ userId: string; tenantId?: string } | null> {
  const data = await getRedis().get(`refresh:${hashToken(token)}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function rotateRefreshToken(
  oldToken: string,
): Promise<{ newToken: string; userId: string; tenantId?: string } | null> {
  const payload = await verifyRefreshToken(oldToken);
  if (!payload) return null;
  await invalidateRefreshToken(oldToken);
  const newToken = await generateRefreshToken(payload.userId);
  return { newToken, userId: payload.userId, tenantId: payload.tenantId };
}

export async function invalidateRefreshToken(token: string): Promise<void> {
  await getRedis().del(`refresh:${hashToken(token)}`);
}

export async function invalidateAllUserTokens(userId: string): Promise<void> {
  await getRedis().set(`user:${userId}:tokens_invalidated_at`, Date.now().toString());
}
