import qs from 'node:querystring';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../config/database.js';
import { users } from '../db/schema/users.js';
import { verifyPassword } from '../services/auth.service.js';
import {
  registerClient,
  getClient,
  createAuthCode,
  consumeAuthCode,
  issueTokens,
  rotateRefreshToken,
  verifyPkceS256,
  OAUTH_SCOPES,
} from '../services/oauth.service.js';

const ISSUER = env.PUBLIC_API_URL;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isLoopback(u: URL): boolean {
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

/** A redirect_uri is valid if it's https, or http on loopback (native clients). */
function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u));
  } catch {
    return false;
  }
}

interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  error?: string;
}

function consentPage(p: AuthorizeParams): string {
  const hidden = (['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope'] as const)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k] ?? '')}">`)
    .join('\n      ');
  const errorHtml = p.error ? `<p class="error">${esc(p.error)}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — TalentAI</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#1e293b;padding:32px;border-radius:14px;width:340px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 4px}.sub{color:#94a3b8;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
  input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:14px}
  .scopes{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin:18px 0;font-size:12px;color:#94a3b8}
  .scopes b{color:#cbd5e1}
  button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:8px;background:#6366f1;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  .error{background:#7f1d1d;color:#fecaca;padding:8px 10px;border-radius:8px;font-size:13px;margin:0 0 12px}
</style></head>
<body><form class="card" method="POST" action="/authorize">
  <h1>Connect Claude to TalentAI</h1>
  <p class="sub">Sign in to authorize the MCP connector.</p>
  ${errorHtml}
  ${hidden}
  <label>Email</label>
  <input type="email" name="email" autocomplete="username" required autofocus>
  <label>Password</label>
  <input type="password" name="password" autocomplete="current-password" required>
  <div class="scopes">Claude will be able to <b>read &amp; verify findings and control agents</b> in your workspaces. It <b>cannot send outreach</b>.</div>
  <button type="submit">Authorize</button>
</form></body></html>`;
}

function redirectError(reply: FastifyReply, redirectUri: string, state: string | undefined, error: string, desc?: string): void {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (desc) u.searchParams.set('error_description', desc);
  if (state) u.searchParams.set('state', state);
  reply.redirect(u.toString());
}

export default async function oauthRoutes(fastify: FastifyInstance) {
  // OAuth posts are application/x-www-form-urlencoded; agentcore has no parser
  // for it. Scoped to this plugin's encapsulation (not global).
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, qs.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  // ── Authorization Server metadata (RFC 8414) ──
  fastify.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  }));

  // ── Dynamic Client Registration (RFC 7591) ──
  fastify.post('/register', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : [];
    if (redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
      return reply.code(400).send({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must be https or http loopback' });
    }
    const client = await registerClient({
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirectUris,
      grantTypes: Array.isArray(body.grant_types) ? (body.grant_types as string[]) : undefined,
    });
    return reply.code(201).send({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: client.clientName ?? undefined,
    });
  });

  // ── Authorization endpoint: render login + consent ──
  fastify.get<{ Querystring: AuthorizeParams }>('/authorize', async (request, reply) => {
    const q = request.query;
    const client = q.client_id ? await getClient(q.client_id) : null;
    // Anti-open-redirect: never redirect to an unregistered/invalid redirect_uri.
    if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
      return reply.code(400).type('text/html').send('<h1>Invalid client or redirect_uri</h1>');
    }
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) {
      return redirectError(reply, q.redirect_uri, q.state, 'invalid_request', 'PKCE S256 + response_type=code required');
    }
    return reply.type('text/html').send(consentPage(q));
  });

  // ── Authorization submit: verify credentials, issue code ──
  fastify.post('/authorize', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string>;
    const client = b.client_id ? await getClient(b.client_id) : null;
    if (!client || !b.redirect_uri || !client.redirectUris.includes(b.redirect_uri)) {
      return reply.code(400).type('text/html').send('<h1>Invalid client or redirect_uri</h1>');
    }
    if (!b.code_challenge || b.code_challenge_method !== 'S256') {
      return redirectError(reply, b.redirect_uri, b.state, 'invalid_request', 'PKCE S256 required');
    }

    const email = (b.email ?? '').trim().toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const ok = user ? await verifyPassword(b.password ?? '', user.passwordHash) : false;
    if (!user || !ok) {
      return reply
        .code(401)
        .type('text/html')
        .send(consentPage({ ...(b as AuthorizeParams), error: 'Invalid email or password' }));
    }

    const scope = b.scope && b.scope.trim() ? b.scope : OAUTH_SCOPES.join(' ');
    const code = await createAuthCode({
      userId: user.id,
      role: (user.role ?? 'member') as 'owner' | 'admin' | 'member' | 'viewer',
      clientId: client.clientId,
      redirectUri: b.redirect_uri,
      codeChallenge: b.code_challenge,
      scope,
    });

    const u = new URL(b.redirect_uri);
    u.searchParams.set('code', code);
    if (b.state) u.searchParams.set('state', b.state);
    return reply.redirect(u.toString());
  });

  // ── Token endpoint: authorization_code + refresh_token grants ──
  fastify.post('/token', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string>;
    const grant = b.grant_type;

    if (grant === 'authorization_code') {
      if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const payload = await consumeAuthCode(b.code);
      if (!payload) return reply.code(400).send({ error: 'invalid_grant', error_description: 'code expired or already used' });
      if (payload.clientId !== b.client_id || payload.redirectUri !== b.redirect_uri) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'client/redirect mismatch' });
      }
      if (!verifyPkceS256(b.code_verifier, payload.codeChallenge)) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      const tokens = await issueTokens({ userId: payload.userId, role: payload.role, scope: payload.scope });
      return reply.send({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
    }

    if (grant === 'refresh_token') {
      if (!b.refresh_token) return reply.code(400).send({ error: 'invalid_request' });
      const tokens = await rotateRefreshToken(b.refresh_token);
      if (!tokens) return reply.code(400).send({ error: 'invalid_grant', error_description: 'refresh token invalid or expired' });
      return reply.send({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: tokens.scope,
      });
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });
}
