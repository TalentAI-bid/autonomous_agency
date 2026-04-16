// ─── auth-client.js ─────────────────────────────────────────────────────────
// Extension-side auth helper. Stores the JWT + refresh token in
// chrome.storage.local (extensions can't rely on same-origin cookies), and
// auto-provisions the `tai_ext_` API key once authenticated so the WebSocket
// layer can connect without any user action.
//
// Pure ES module — no dependencies, runs in both the service worker and popup.

const SESSION_KEY = 'session';
const LEGACY_KEYS = ['apiKey', 'paused', 'connectionStatus'];
// `serverUrl` is re-used as a *preference* for the sign-in form, so we don't
// wipe it here. It's overwritten by `signIn` anyway.

// ─── Storage ────────────────────────────────────────────────────────────────

export async function getSession() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY);
  return session ?? null;
}

async function setSession(session) {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

async function clearSession() {
  await chrome.storage.local.remove([SESSION_KEY, ...LEGACY_KEYS]);
}

// ─── URL helpers ────────────────────────────────────────────────────────────

// Accepts ws://, wss://, http://, https:// — returns the matching http(s) origin.
export function toHttpOrigin(url) {
  if (!url) return '';
  let u = String(url).trim().replace(/\/+$/, '');
  if (u.startsWith('ws://'))  u = 'http://'  + u.slice(5);
  if (u.startsWith('wss://')) u = 'https://' + u.slice(6);
  return u;
}

// Matching ws(s) origin for WebSocket connections.
export function toWsOrigin(url) {
  if (!url) return '';
  let u = String(url).trim().replace(/\/+$/, '');
  if (u.startsWith('http://'))  u = 'ws://'  + u.slice(7);
  if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  return u;
}

// ─── Core auth flow ─────────────────────────────────────────────────────────

export async function signIn({ serverUrl, email, password }) {
  const origin = toHttpOrigin(serverUrl);
  if (!origin) throw new Error('missing_server_url');
  if (!email || !password) throw new Error('missing_credentials');

  // 1) POST /api/extension/auth/login
  const res = await fetch(`${origin}/api/extension/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const msg = parseErrorMessage(bodyText) || `login_failed:${res.status}`;
    throw new Error(msg);
  }
  const json = await res.json();
  const data = json.data ?? json;
  if (!data?.accessToken || !data?.refreshToken) {
    throw new Error('malformed_login_response');
  }

  const expiresAt = Date.now() + ((data.expiresIn || 900) * 1000) - 60_000;

  const session = {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: data.user,
    tenant: data.tenant,
    serverUrl: origin,
    apiKey: null,
    expiresAt,
  };
  await setSession(session);

  // 2) Auto-provision an extension API key for the WebSocket layer.
  const keyRes = await authedFetch('/api/extension/generate-key', { method: 'POST' });
  if (!keyRes.ok) {
    // Rollback the session so the user doesn't end up in a half-authed state.
    await clearSession();
    throw new Error(`key_provision_failed:${keyRes.status}`);
  }
  const keyJson = await keyRes.json();
  const apiKey = (keyJson.data ?? keyJson)?.apiKey;
  if (!apiKey) {
    await clearSession();
    throw new Error('malformed_key_response');
  }

  const latest = await getSession();
  await setSession({ ...latest, apiKey });

  return { user: session.user, tenant: session.tenant };
}

export async function refreshSession() {
  const session = await getSession();
  if (!session?.refreshToken || !session?.serverUrl) {
    await clearSession();
    throw new Error('no_refresh_token');
  }

  const res = await fetch(`${session.serverUrl}/api/extension/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    await clearSession();
    throw new Error(`refresh_failed:${res.status}`);
  }
  const json = await res.json();
  const data = json.data ?? json;
  if (!data?.accessToken || !data?.refreshToken) {
    await clearSession();
    throw new Error('malformed_refresh_response');
  }

  const expiresAt = Date.now() + ((data.expiresIn || 900) * 1000) - 60_000;
  const latest = await getSession();
  await setSession({
    ...latest,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt,
  });

  return data.accessToken;
}

export async function signOut() {
  // Best-effort revoke — ignore failures (network down, token already invalid).
  try {
    await authedFetch('/api/extension/revoke', { method: 'POST' });
  } catch (_) { /* ignore */ }
  await clearSession();
}

// ─── Authenticated fetch helper ─────────────────────────────────────────────

export async function authedFetch(path, { method = 'GET', body } = {}) {
  let session = await getSession();
  if (!session?.accessToken || !session?.serverUrl) {
    throw new Error('no_session');
  }

  // Proactive refresh if we're within the safety window.
  if (Date.now() >= (session.expiresAt ?? 0)) {
    try {
      await refreshSession();
      session = await getSession();
    } catch (err) {
      throw new Error('session_expired');
    }
  }

  const url = path.startsWith('http') ? path : `${session.serverUrl}${path}`;
  // Only attach Content-Type when there's a body — Fastify rejects empty
  // requests that declare `Content-Type: application/json`
  // (FST_ERR_CTP_EMPTY_JSON_BODY).
  const baseHeaders = { Authorization: `Bearer ${session.accessToken}` };
  const headers = body
    ? { ...baseHeaders, 'Content-Type': 'application/json' }
    : baseHeaders;

  let res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Reactive refresh on 401, then retry once.
  if (res.status === 401) {
    try {
      await refreshSession();
      const fresh = await getSession();
      const retryHeaders = body
        ? { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' }
        : { Authorization: `Bearer ${fresh.accessToken}` };
      res = await fetch(url, {
        method,
        headers: retryHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      await clearSession();
      throw new Error('session_expired');
    }
  }

  return res;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseErrorMessage(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || null;
  } catch {
    return null;
  }
}
