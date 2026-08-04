import { env } from '../config/env.js';
import { ToolError } from '../util/errors.js';
import { hydrateSelectedFromDefault, type SessionCtx, type Workspace } from './session-store.js';

export interface ProxyOpts {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Set false for list_workspaces/use_workspace which run before a workspace is chosen. */
  requireWorkspace?: boolean;
  /** Override the default 60s request timeout (e.g. agent start runs the strategist inline). */
  timeoutMs?: number;
}

/**
 * Single choke point for every call into agentcore. Forwards the session's
 * bearer token plus the chosen workspace as X-Active-Workspace, so agentcore's
 * existing auth middleware resolves tenancy and re-verifies membership. Returns
 * the unwrapped `data` payload (agentcore wraps successful responses as { data }).
 */
export async function agentcoreFetch<T = unknown>(ctx: SessionCtx, opts: ProxyOpts): Promise<T> {
  if (opts.requireWorkspace !== false && !ctx.tenantId) {
    // Fresh session (the claude.ai client doesn't reliably reuse the same MCP
    // session across calls). Recover the workspace the user last selected from
    // their persisted default (user_tenants.is_default) — one fetch per session.
    if (!ctx.restoreAttempted) {
      ctx.restoreAttempted = true;
      const ws = await agentcoreFetch<Workspace[]>(ctx, {
        method: 'GET',
        path: '/api/workspaces',
        requireWorkspace: false,
      });
      hydrateSelectedFromDefault(ctx, ws);
    }
    if (!ctx.tenantId) {
      throw new ToolError(
        'No workspace selected. Call use_workspace("<name or id>") first — list_workspaces shows your options.',
      );
    }
  }

  const url = new URL(opts.path, env.AGENTCORE_URL);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${ctx.bearer}` };
  if (ctx.tenantId) headers['X-Active-Workspace'] = ctx.tenantId;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
  } catch (err) {
    throw new ToolError(`Could not reach agentcore: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    const j = json as Record<string, any> | null;
    const msg =
      j?.error?.message ?? (typeof j?.error === 'string' ? j.error : undefined) ?? j?.message ?? res.statusText;
    throw new ToolError(`agentcore ${res.status}: ${msg}`);
  }

  const j = json as Record<string, any> | null;
  return (j && 'data' in j ? j.data : json) as T;
}
