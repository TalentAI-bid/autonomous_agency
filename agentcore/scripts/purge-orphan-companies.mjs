#!/usr/bin/env node
// Purge orphan companies + contacts for the Talentai tenant.
//   - Orphan company = companies.master_agent_id IS NULL
//   - Orphan contact = company_id IS NULL OR belongs to an orphan company
//
// Cascades handled by FK constraints:
//   companies → prospect_actions (CASCADE)
//   companies → opportunities.company_id (SET NULL)
//   contacts  → campaign_contacts, crm_activities, deals, outreach_emails,
//               prospect_stages, interviews (CASCADE)
//   contacts  → email_threads, documents, opportunities.contact_id, replies,
//               reddit_opportunities, email_queue (SET NULL)
// timeline_events: untouched (append-only).
//
// Usage:
//   node scripts/purge-orphan-companies.mjs              # dry-run, ROLLBACK
//   node scripts/purge-orphan-companies.mjs --confirm    # COMMIT

import pg from 'pg';

const TENANT_ID = 'd4158081-2e10-4986-8cfb-86ea16f5db2c'; // Talentai
const CONFIRM = process.argv.includes('--confirm');

const client = process.env.DATABASE_URL
  ? new pg.Client({ connectionString: process.env.DATABASE_URL })
  : new pg.Client({
      host: 'localhost',
      user: 'agentcore',
      password: 'agentcore',
      database: 'agentcore',
    });

async function counts(c) {
  const q = (sql) => c.query(sql, [TENANT_ID]).then((r) => r.rows[0].n);
  return {
    orphanCompanies: await q(
      `SELECT count(*)::int n FROM companies WHERE tenant_id=$1 AND master_agent_id IS NULL`,
    ),
    ownedCompanies: await q(
      `SELECT count(*)::int n FROM companies WHERE tenant_id=$1 AND master_agent_id IS NOT NULL`,
    ),
    orphanContacts: await q(
      `SELECT count(*)::int n FROM contacts WHERE tenant_id=$1
         AND (company_id IS NULL
              OR company_id IN (SELECT id FROM companies WHERE tenant_id=$1 AND master_agent_id IS NULL))`,
    ),
    totalContacts: await q(
      `SELECT count(*)::int n FROM contacts WHERE tenant_id=$1`,
    ),
    pendingActions: await q(
      `SELECT count(*)::int n FROM prospect_actions WHERE tenant_id=$1 AND status='pending'`,
    ),
  };
}

await client.connect();

try {
  console.log(`Tenant: ${TENANT_ID} (Talentai)`);
  console.log(`Mode  : ${CONFIRM ? 'COMMIT' : 'DRY RUN (rollback at end)'}\n`);

  await client.query('BEGIN');

  const pre = await counts(client);
  console.log('PRE :', pre);

  // 1) Contacts first. contacts.company_id FK is SET NULL, not CASCADE, so
  //    deleting orphan companies alone leaves these contacts dangling with
  //    company_id = NULL. We want them gone too.
  const delContacts = await client.query(
    `
    DELETE FROM contacts
    WHERE tenant_id = $1
      AND (
        company_id IS NULL
        OR company_id IN (
          SELECT id FROM companies WHERE tenant_id = $1 AND master_agent_id IS NULL
        )
      )
    `,
    [TENANT_ID],
  );
  console.log(`contacts deleted: ${delContacts.rowCount}`);

  // 2) Orphan companies. prospect_actions cascades; opportunities.company_id
  //    SET NULLs; timeline_events is untouched (append-only).
  const delCompanies = await client.query(
    `DELETE FROM companies WHERE tenant_id = $1 AND master_agent_id IS NULL`,
    [TENANT_ID],
  );
  console.log(`companies deleted: ${delCompanies.rowCount}`);

  const post = await counts(client);
  console.log('POST:', post);

  if (CONFIRM) {
    await client.query('COMMIT');
    console.log('\nCOMMITTED.');
  } else {
    await client.query('ROLLBACK');
    console.log('\nDRY RUN — rolled back. Re-run with --confirm to commit.');
  }
} catch (err) {
  try {
    await client.query('ROLLBACK');
  } catch {}
  console.error('Purge failed:', err);
  process.exitCode = 1;
} finally {
  await client.end();
  process.exit(process.exitCode ?? 0);
}
