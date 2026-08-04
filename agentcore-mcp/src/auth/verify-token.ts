import type { FastifyRequest } from 'fastify';

/**
 * Stage 1: extract the Bearer token from the Authorization header. We do not
 * validate it locally — agentcore validates on every proxied call and rejects
 * bad/expired tokens, which surface as clean tool errors. Stage 2 (OAuth) swaps
 * this for opaque-token → agentcore-JWT unwrapping.
 */
export function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}
