// ─── cors.ts ────────────────────────────────────────────────────────────────
// Shared origin allow-list logic used by:
//   - the @fastify/cors plugin (src/index.ts)
//   - the SSE chat stream's manually-written headers (src/routes/chat.routes.ts)
//   - the global error handler's CORS headers (src/utils/errors.ts)
//
// Rules:
//   - No Origin header (curl, server-to-server) → allowed.
//   - chrome-extension://* → always allowed (extension popup, IDs are unguessable).
//   - Anything in env.CORS_ORIGINS (comma-separated) → allowed.
//   - Everything else → rejected.

import { env } from '../config/env.js';

let cachedAllowList: string[] | null = null;

function getAllowList(): string[] {
  if (cachedAllowList) return cachedAllowList;
  cachedAllowList = env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return cachedAllowList;
}

export function isOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://')) return true;
  return getAllowList().includes(origin);
}
