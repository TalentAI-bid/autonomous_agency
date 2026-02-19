import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { env } from './env.js';
import * as schema from '../db/schema/index.js';

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Execute a callback within a transaction that has tenant RLS context set.
 * All tenant-scoped queries MUST go through this helper.
 */
export async function withTenant<T>(
  tenantId: string,
  callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
    return callback(tx);
  });
}

/**
 * Close the database pool gracefully.
 */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}
