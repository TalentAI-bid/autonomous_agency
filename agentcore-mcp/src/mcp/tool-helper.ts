import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape } from 'zod';
import { ToolError } from '../util/errors.js';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Wrap any value as a text tool result (JSON-pretty for non-strings). */
export function text(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
  };
}

/**
 * Register a tool with uniform error handling: ToolError messages (proxy
 * failures, precondition failures) surface as a clean isError result instead of
 * crashing the session; anything unexpected is wrapped too.
 */
export function defineTool(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema?: ZodRawShape },
  handler: (args: Record<string, unknown>) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    { title: config.title, description: config.description, inputSchema: config.inputSchema ?? {} },
    (async (args: Record<string, unknown>) => {
      try {
        return await handler(args ?? {});
      } catch (err) {
        const msg =
          err instanceof ToolError
            ? err.message
            : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
    }) as never,
  );
}
