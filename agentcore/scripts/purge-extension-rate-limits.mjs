#!/usr/bin/env node
// Purge daily-counter state on extension_sessions for a user / tenant. Mirrors
// the POST /api/admin/extension/reset-rate-limits endpoint but runs out-of-band
// (no audit-log row — direct DB ops are out-of-band by definition).
//
// Usage:
//   node scripts/purge-extension-rate-limits.mjs --email hatemazaiez1@gmail.com [--dry-run]
//   node scripts/purge-extension-rate-limits.mjs --user-id <uuid>
//   node scripts/purge-extension-rate-limits.mjs --tenant-id <uuid>
//   node scripts/purge-extension-rate-limits.mjs --email ... --task-types linkedin:search_companies,linkedin:fetch_company
//
// Env: DATABASE_URL (preferred) OR localhost defaults; REDIS_URL (optional).

import pg from 'pg';

// ────────────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
}

const email = flags.email;
const userIdArg = flags['user-id'];
const tenantIdArg = flags['tenant-id'];
const taskTypesCsv = flags['task-types'];
const dryRun = !!flags['dry-run'];

if (!email && !userIdArg && !tenantIdArg) {
  console.error('Usage: purge-extension-rate-limits.mjs --email <addr> | --user-id <uuid> | --tenant-id <uuid>');
  console.error('       [--task-types site:type,site:type] [--dry-run]');
  process.exit(1);
}

const taskTypes = taskTypesCsv
  ? String(taskTypesCsv).split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// ────────────────────────────────────────────────────────────────────────
// Connect
// ────────────────────────────────────────────────────────────────────────
const client = process.env.DATABASE_URL
  ? new pg.Client({ connectionString: process.env.DATABASE_URL })
  : new pg.Client({
      host: 'localhost',
      user: 'agentcore',
      password: 'agentcore',
      database: 'agentcore',
    });

await client.connect();

try {
  // Resolve --email → userId.
  let userId = userIdArg;
  if (email && !userId) {
    const { rows } = await client.query('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
    if (rows.length === 0) {
      console.error(`No user found with email ${email}`);
      process.exit(1);
    }
    userId = rows[0].id;
    console.log(`Resolved ${email} → ${userId}`);
  }

  // Build scope clause.
  const conds = ['revoked_at IS NULL'];
  const params = [];
  if (userId) {
    params.push(userId);
    conds.push(`user_id = $${params.length}`);
  }
  if (tenantIdArg) {
    params.push(tenantIdArg);
    conds.push(`tenant_id = $${params.length}`);
  }
  const scopeClause = conds.join(' AND ');

  console.log(`Scope: ${scopeClause}` + (dryRun ? ' (DRY RUN)' : ''));
  console.log(`taskTypes: ${taskTypes.length === 0 ? '<all>' : taskTypes.join(', ')}\n`);

  // Pre-state.
  const beforeQuery = `SELECT id, user_id, daily_tasks_count, daily_reset_at FROM extension_sessions WHERE ${scopeClause}`;
  const before = await client.query(beforeQuery, params);
  if (before.rows.length === 0) {
    console.log('No active sessions match this scope. Nothing to do.');
    process.exit(0);
  }

  console.log(`Before:`);
  for (const r of before.rows) {
    console.log(`  session ${r.id}  user=${r.user_id}  dailyTasksCount=${JSON.stringify(r.daily_tasks_count)}  resetAt=${r.daily_reset_at?.toISOString?.() ?? r.daily_reset_at}`);
  }

  if (dryRun) {
    console.log('\n(dry run — no rows updated)');
    process.exit(0);
  }

  // Apply update.
  const setClause = (taskTypes.length > 0)
    ? `daily_tasks_count = daily_tasks_count - $${params.length + 1}::text[],
       daily_reset_at = NOW(),
       updated_at = NOW()`
    : `daily_tasks_count = '{}'::jsonb,
       daily_reset_at = NOW(),
       updated_at = NOW()`;
  const updateParams = (taskTypes.length > 0) ? [...params, taskTypes] : params;

  const updateQuery = `UPDATE extension_sessions SET ${setClause} WHERE ${scopeClause}
                       RETURNING id, user_id, daily_tasks_count, daily_reset_at`;
  const updated = await client.query(updateQuery, updateParams);

  console.log(`\nAfter (${updated.rows.length} sessions reset):`);
  for (const r of updated.rows) {
    console.log(`  session ${r.id}  user=${r.user_id}  dailyTasksCount=${JSON.stringify(r.daily_tasks_count)}`);
  }

  // Best-effort: publish a WS event so connected extensions clear their local mirror.
  if (process.env.REDIS_URL) {
    try {
      const { default: Redis } = await import('ioredis');
      const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
      for (const r of updated.rows) {
        const msg = JSON.stringify({ type: 'rate_limits_purged', taskTypes: taskTypes.length > 0 ? taskTypes : null });
        await redis.publish(`extension-dispatch:${r.id}`, msg);
      }
      await redis.quit();
      console.log(`\nPublished rate_limits_purged to ${updated.rows.length} extension WS channel(s).`);
    } catch (err) {
      console.warn('\nRedis publish failed (extension will reconcile on next reconnect):', err?.message ?? err);
    }
  } else {
    console.log('\nREDIS_URL not set — extension state will reconcile on next reconnect (via GET /api/extension/me/rate-limits).');
  }
} catch (err) {
  console.error('Purge failed:', err);
  process.exitCode = 1;
} finally {
  await client.end();
  process.exit(process.exitCode ?? 0);
}
