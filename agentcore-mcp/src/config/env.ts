import { z } from 'zod';

// Mirrors agentcore/src/config/env.ts — zod-validated, fail-fast at boot.
const envSchema = z.object({
  PORT: z.coerce.number().default(3100),
  // Internal hop to the agentcore REST API (same host in prod).
  AGENTCORE_URL: z.string().url().default('http://localhost:4000'),
  // Public URL this MCP server is reached at (used in OAuth protected-resource metadata).
  PUBLIC_MCP_URL: z.string().url().default('http://localhost:3100'),
  // The OAuth Authorization Server (agentcore's public host).
  OAUTH_ISSUER: z.string().url().default('http://localhost:4000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

function loadEnv(): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
