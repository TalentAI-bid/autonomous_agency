/**
 * Cleanup script — run with: npx tsx src/scripts/cleanup-data.ts
 *
 * 1. Delete companies named "..." / "…" / dots-only
 * 2. Delete contacts linked to those companies
 * 3. For companies with > 5 contacts, keep only the 5 most recent
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://agentcore:agentcore@localhost:5432/agentcore';

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const db = drizzle(pool);

  console.log('=== Cleanup Script ===\n');

  // 1. Find companies with junk names ("...", "…", dots-only)
  const junkCompanies = await db.execute<{ id: string; name: string; tenant_id: string }>(
    sql`SELECT id, name, tenant_id FROM companies WHERE name IN ('...', '…') OR name ~ '^\.{2,}$'`
  );
  const junkRows = junkCompanies.rows ?? junkCompanies;
  console.log(`Found ${junkRows.length} junk companies ("...", "…", dots-only)`);

  if (junkRows.length > 0) {
    const junkIds = junkRows.map((r: any) => r.id);

    // Delete contacts linked to junk companies
    const deletedContacts = await db.execute(
      sql`DELETE FROM contacts WHERE company_id = ANY(${junkIds}) RETURNING id`
    );
    const deletedContactRows = deletedContacts.rows ?? deletedContacts;
    console.log(`  Deleted ${deletedContactRows.length} contacts linked to junk companies`);

    // Delete the junk companies
    const deletedCompanies = await db.execute(
      sql`DELETE FROM companies WHERE id = ANY(${junkIds}) RETURNING id`
    );
    const deletedCompanyRows = deletedCompanies.rows ?? deletedCompanies;
    console.log(`  Deleted ${deletedCompanyRows.length} junk companies`);
  }

  // 2. Cap contacts per company to 5 (keep most recent by updated_at)
  console.log('\nCapping contacts to 5 per company...');
  const excessResult = await db.execute(
    sql`
      WITH ranked AS (
        SELECT id, company_id,
               ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY updated_at DESC) AS rn
        FROM contacts
        WHERE company_id IS NOT NULL
      ),
      excess AS (
        SELECT id FROM ranked WHERE rn > 5
      )
      DELETE FROM contacts WHERE id IN (SELECT id FROM excess) RETURNING id
    `
  );
  const excessRows = excessResult.rows ?? excessResult;
  console.log(`  Deleted ${excessRows.length} excess contacts (> 5 per company)`);

  console.log('\n=== Cleanup complete ===');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
