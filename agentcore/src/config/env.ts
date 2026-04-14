import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),
  PGBOUNCER_URL: z.string().url().optional(),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  // AWS Bedrock
  AWS_BEARER_TOKEN_BEDROCK: z.string(),
  AWS_BEDROCK_REGION: z.string().default('us-east-1'),

  // Legacy AI Services (unused — kept for backward compat)
  TOGETHER_API_KEY: z.string().optional(),
  TOGETHER_API_URL: z.string().url().default('https://api.together.xyz/v1'),
  CLAUDE_API_KEY: z.string().optional(),

  // External Services
  SEARXNG_URL: z.string().url().default('http://localhost:8888'),
  CRAWL4AI_URL: z.string().url().default('http://localhost:11235'),
  GITHUB_TOKEN: z.string().optional(),
  COMPANIES_HOUSE_API_KEY: z.string().optional(),
  OPENCORPORATES_API_TOKEN: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  GENERECT_API_KEY: z.string().optional(),
  REACHER_URL: z.string().default('http://173.212.232.243:8070'),
  LINKEDIN_VOYAGER_URL: z.string().default('http://173.212.232.243:8072'),
  LINKEDIN_VOYAGER_DELAY_MS: z.coerce.number().default(4000),
  LINKEDIN_VOYAGER_DAILY_LIMIT: z.coerce.number().default(80),

  // SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // Email encryption
  EMAIL_ENCRYPTION_KEY: z.string().optional(),

  // Feature flags
  USE_COMPANY_FINDER: z.coerce.boolean().default(true),

  // App
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
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
