/**
 * Error whose message is safe to surface to the model as a tool result.
 * Thrown by the proxy on a non-2xx agentcore response or by tools on a
 * precondition failure (e.g. no workspace selected).
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
