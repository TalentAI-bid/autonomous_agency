import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '../queues/setup.js';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '7d';
const REFRESH_TOKEN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days — used by extension flow only

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    redis = createRedisConnection();
  }
  return redis;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateAccessToken(
  fastify: FastifyInstance,
  payload: { tenantId: string; userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' },
): string {
  return fastify.jwt.sign(payload, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export async function generateRefreshToken(
  userId: string,
  tenantId: string,
): Promise<string> {
  const token = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const r = getRedis();
  await r.setex(
    `refresh:${tokenHash}`,
    REFRESH_TOKEN_EXPIRY_SECONDS,
    JSON.stringify({ userId, tenantId }),
  );

  return token;
}

export async function verifyRefreshToken(
  token: string,
): Promise<{ userId: string; tenantId: string } | null> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const r = getRedis();
  const data = await r.get(`refresh:${tokenHash}`);
  if (!data) return null;
  return JSON.parse(data);
}

export async function rotateRefreshToken(
  oldToken: string,
): Promise<{ newToken: string; userId: string; tenantId: string } | null> {
  const payload = await verifyRefreshToken(oldToken);
  if (!payload) return null;

  // Invalidate old token
  await invalidateRefreshToken(oldToken);

  // Generate new token
  const newToken = await generateRefreshToken(payload.userId, payload.tenantId);
  return { newToken, ...payload };
}

export async function invalidateRefreshToken(token: string): Promise<void> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const r = getRedis();
  await r.del(`refresh:${tokenHash}`);
}

export async function invalidateAllUserTokens(userId: string): Promise<void> {
  const r = getRedis();
  await r.set(`user:${userId}:tokens_invalidated_at`, Date.now().toString());
}
