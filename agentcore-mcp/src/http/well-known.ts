import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';

/** The canonical resource identifier Claude binds tokens to (the MCP endpoint). */
export const RESOURCE_URL = `${env.PUBLIC_MCP_URL}/mcp`;

/** Value for the WWW-Authenticate header on 401s, pointing Claude at discovery. */
export const RESOURCE_METADATA_URL = `${env.PUBLIC_MCP_URL}/.well-known/oauth-protected-resource`;

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728). Claude fetches this after a
 * 401 to learn which Authorization Server to use (agentcore).
 */
export function registerWellKnown(fastify: FastifyInstance): void {
  fastify.get('/.well-known/oauth-protected-resource', async () => ({
    resource: RESOURCE_URL,
    authorization_servers: [env.OAUTH_ISSUER],
    scopes_supported: ['agentcore:read', 'agentcore:verify', 'agentcore:agent-control'],
    bearer_methods_supported: ['header'],
  }));

  // Also serve it under the /mcp suffix, which some clients probe per RFC 9728.
  fastify.get('/.well-known/oauth-protected-resource/mcp', async () => ({
    resource: RESOURCE_URL,
    authorization_servers: [env.OAUTH_ISSUER],
    scopes_supported: ['agentcore:read', 'agentcore:verify', 'agentcore:agent-control'],
    bearer_methods_supported: ['header'],
  }));
}
