import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Per-MCP-session context. `bearer` is the validated access token (refreshed on
 * every request, since Claude re-attaches it and it may rotate). `tenantId` is
 * the workspace the user explicitly selected via use_workspace — it starts
 * undefined and every workspace-scoped tool refuses to run until it is set.
 */
export interface SessionCtx {
  bearer: string;
  tenantId?: string;
  tenantName?: string;
  /**
   * True once we've tried to restore tenantId from the user's persisted default
   * (user_tenants.is_default) via agentcore. Bounds the restore to one fetch per
   * session so a user with no default set isn't re-queried on every tool call.
   */
  restoreAttempted?: boolean;
}

export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  ctx: SessionCtx;
}

/** A workspace as returned by agentcore's GET /api/workspaces. */
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
  /** The user's persisted active workspace (user_tenants.is_default). */
  isDefault?: boolean;
}

/**
 * Populate ctx's selected workspace from the isDefault row when it isn't already
 * set — this is how a fresh session recovers the workspace the user picked on an
 * earlier request. No-op if a workspace is already selected. Returns true if the
 * ctx ends up with a selection.
 */
export function hydrateSelectedFromDefault(ctx: SessionCtx, workspaces: Workspace[]): boolean {
  if (ctx.tenantId) return true;
  const def = workspaces.find((w) => w.isDefault);
  if (def) {
    ctx.tenantId = def.id;
    ctx.tenantName = def.name;
  }
  return !!ctx.tenantId;
}

export const sessions = new Map<string, SessionEntry>();
