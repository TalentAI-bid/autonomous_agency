#!/usr/bin/env node
// One-time backfill: insert user_tenants(user_id, tenant_id, role='owner') for
// every user whose users.tenant_id is missing from user_tenants.
//
// Why this exists: signup originally only wrote to users.tenant_id. The
// user_tenants bridge was added later but never backfilled, so any user who
// signed up before that and then created a second workspace lost the
// workspace-switcher entry pointing at their original tenant — making it look
// like their data was deleted.
//
// Idempotent: relies on the (user_id, tenant_id) unique constraint via
// ON CONFLICT DO NOTHING.
//
// Usage:   node scripts/backfill-user-tenants.mjs
// Env:     DATABASE_URL (required)

import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows: candidates } = await client.query(`
    SELECT u.id AS user_id, u.email, u.tenant_id, t.name AS tenant_name
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
    WHERE NOT EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = u.id AND ut.tenant_id = u.tenant_id
    )
    ORDER BY u.email
  `);

  console.log(`Found ${candidates.length} (user, tenant) pairs missing from user_tenants.`);
  for (const row of candidates) {
    console.log(`  - ${row.email}  →  ${row.tenant_name} (${row.tenant_id})`);
  }

  if (candidates.length === 0) {
    console.log('Nothing to backfill.');
    process.exit(0);
  }

  const result = await client.query(`
    INSERT INTO user_tenants (user_id, tenant_id, role)
    SELECT u.id, u.tenant_id, 'owner'
    FROM users u
    WHERE NOT EXISTS (
      SELECT 1 FROM user_tenants ut
      WHERE ut.user_id = u.id AND ut.tenant_id = u.tenant_id
    )
    ON CONFLICT (user_id, tenant_id) DO NOTHING
    RETURNING user_id, tenant_id
  `);

  console.log(`Inserted ${result.rowCount} user_tenants rows.`);
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
} finally {
  await client.end();
}
