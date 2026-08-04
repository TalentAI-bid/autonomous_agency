import crypto from 'crypto';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { createRedisConnection } from '../queues/setup.js';
import { db } from '../config/database.js';
import { oauthClients } from '../db/schema/oauth-clients.js';

// OAuth 2.1 Authorization Server primitives for the MCP server.
//
// - Authorization codes, access tokens, refresh tokens: Redis (short-lived,
//   revocable). Access tokens are OPAQUE (`mcp_at_...`) and validated by the
//   auth middleware via verifyOAuthAccessToken — the MCP server forwards them
//   as bearer tokens unchanged.
// - Registered clients (DCR): Postgres (durable), via oauthClients table.

type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

const CODE_TTL_SECONDS = 60;
const ACCESS_TTL_SECONDS = 60 * 60; // 1h
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d

export const OAUTH_SCOPES = ['agentcore:read', 'agentcore:verify', 'agentcore:agent-control'] as const;

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) redis = createRedisConnection();
  return redis;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(36).toString('hex')}`;
}

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}

// ─── Dynamic Client Registration ─────────────────────────────────────────────

export interface RegisteredClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: string;
}

export async function registerClient(input: {
  clientName?: string;
  redirectUris: string[];
  grantTypes?: string[];
}): Promise<RegisteredClient> {
  const clientId = randomToken('mcpc_');
  const grantTypes = input.grantTypes?.length ? input.grantTypes : ['authorization_code', 'refresh_token'];
  await db.insert(oauthClients).values({
    clientId,
    clientName: input.clientName ?? null,
    redirectUris: input.redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: 'none',
  });
  return {
    clientId,
    clientName: input.clientName ?? null,
    redirectUris: input.redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: 'none',
  };
}

export async function getClient(clientId: string): Promise<RegisteredClient | null> {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  if (!row) return null;
  return {
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: (row.redirectUris as string[]) ?? [],
    grantTypes: (row.grantTypes as string[]) ?? [],
    tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
  };
}

// ─── Authorization codes ─────────────────────────────────────────────────────

export interface AuthCodePayload {
  userId: string;
  role: UserRole;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
}

export async function createAuthCode(payload: AuthCodePayload): Promise<string> {
  const code = randomToken('mcpcode_');
  await getRedis().setex(`oauth:code:${sha256(code)}`, CODE_TTL_SECONDS, JSON.stringify(payload));
  return code;
}

/** One-time: returns the payload and deletes the code. */
export async function consumeAuthCode(code: string): Promise<AuthCodePayload | null> {
  const key = `oauth:code:${sha256(code)}`;
  const data = await getRedis().get(key);
  if (!data) return null;
  await getRedis().del(key);
  try {
    return JSON.parse(data) as AuthCodePayload;
  } catch {
    return null;
  }
}

// ─── Access + refresh tokens ─────────────────────────────────────────────────

export interface TokenSubject {
  userId: string;
  role: UserRole;
  scope?: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export async function issueTokens(subject: TokenSubject): Promise<IssuedTokens> {
  const accessToken = randomToken('mcp_at_');
  const refreshToken = randomToken('mcp_rt_');
  const scope = subject.scope ?? OAUTH_SCOPES.join(' ');
  const blob = JSON.stringify({ userId: subject.userId, role: subject.role, scope });
  await getRedis().setex(`oauth:at:${sha256(accessToken)}`, ACCESS_TTL_SECONDS, blob);
  await getRedis().setex(`oauth:rt:${sha256(refreshToken)}`, REFRESH_TTL_SECONDS, blob);
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, scope };
}

/** Validate an opaque access token. Used by the auth middleware. */
export async function verifyOAuthAccessToken(
  token: string,
): Promise<{ userId: string; role: UserRole; scope: string } | null> {
  const data = await getRedis().get(`oauth:at:${sha256(token)}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as { userId: string; role: UserRole; scope: string };
  } catch {
    return null;
  }
}

/** Rotate a refresh token: invalidates the old one, issues a fresh pair. */
export async function rotateRefreshToken(refreshToken: string): Promise<IssuedTokens | null> {
  const key = `oauth:rt:${sha256(refreshToken)}`;
  const data = await getRedis().get(key);
  if (!data) return null;
  await getRedis().del(key);
  let parsed: { userId: string; role: UserRole; scope?: string };
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  return issueTokens({ userId: parsed.userId, role: parsed.role, scope: parsed.scope });
}
