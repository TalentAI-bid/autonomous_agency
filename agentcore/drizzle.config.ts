import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/db/schema/*.js',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL || 'postgresql://agentcore:agentcore@localhost:5432/agentcore',
  },
});
