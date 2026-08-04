/**
 * Backfill: create a CRM deal (at the "Replied" stage) for every contact that
 * is marked replied / engaged but has NO deal row — so it shows on the
 * deal-based kanban board (GET /api/crm/board).
 *
 * Why: the PATCH /api/contacts/:id replied-handler used to call recordResponse
 * (→ prospect_stages.current_stage='engaged') WITHOUT ensureDeal. Agent-
 * discovered / never-touched contacts therefore had no deal and were invisible
 * on the board (e.g. Muazam A, b3ffd0f9-...). The forward fix adds ensureDeal +
 * moveDealStage('replied'); this script repairs the already-broken rows (the
 * `prior.status !== 'replied'` guard means the forward fix won't self-heal them).
 *
 * Scope: contacts with no deal AND (status='replied' OR
 * prospect_stages.current_stage='engaged'). Both map to the Replied column.
 *
 * Reuses the exact same services as the forward path (ensureDeal, moveDealStage,
 * findStageBySlug) so the repaired deals are identical to newly-created ones.
 * Idempotent — re-running repairs 0 (ensureDeal dedups by contactId,
 * moveDealStage is a no-op if already at Replied).
 *
 * Usage:
 *   cd agentcore && npx tsx scripts/backfill-replied-deals.ts [--dry-run]
 * Env: reads agentcore/.env (DATABASE_URL etc.) if present.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** Load agentcore/.env into process.env (only vars not already set). Mirrors test-scraping-pipeline.ts. */
function loadEnv(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const envPath = join(scriptDir, '..', '.env');
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();

const dryRun = process.argv.slice(2).includes('--dry-run');

// Imported after env is loaded so config/env validation sees the vars.
const { db, closeDatabase } = await import('../src/config/database.js');
const { ensureDeal, moveDealStage, findStageBySlug } = await import('../src/services/crm-activity.service.js');
const { sql } = await import('drizzle-orm');

interface Row {
  tenant_id: string;
  id: string;
  master_agent_id: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
  current_stage: string | null;
}

const totals = { scanned: 0, repaired: 0, alreadyHadDeal: 0, errors: 0 };

try {
  // BYPASSRLS role → cross-tenant. Candidates: no deal yet, but replied/engaged.
  const { rows } = (await db.execute(sql`
    SELECT c.tenant_id, c.id, c.master_agent_id, c.first_name, c.last_name,
           c.status, ps.current_stage
    FROM contacts c
    LEFT JOIN prospect_stages ps ON ps.contact_id = c.id
    WHERE NOT EXISTS (SELECT 1 FROM deals d WHERE d.contact_id = c.id)
      AND (c.status = 'replied' OR ps.current_stage = 'engaged')
    ORDER BY c.tenant_id
  `)) as unknown as { rows: Row[] };

  console.log(`Found ${rows.length} replied/engaged contact(s) with no deal${dryRun ? ' (DRY RUN)' : ''}.\n`);

  for (const r of rows) {
    totals.scanned += 1;
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id;
    if (dryRun) {
      console.log(`  would repair: ${name} (${r.id})  tenant=${r.tenant_id}  status=${r.status} stage=${r.current_stage}`);
      continue;
    }
    try {
      const deal = await ensureDeal({
        tenantId: r.tenant_id,
        contactId: r.id,
        masterAgentId: r.master_agent_id ?? undefined,
      });
      if (!deal.created) totals.alreadyHadDeal += 1;
      const repliedStage = await findStageBySlug(r.tenant_id, 'replied');
      if (repliedStage) {
        await moveDealStage({ tenantId: r.tenant_id, dealId: deal.id, newStageId: repliedStage.id });
      }
      totals.repaired += 1;
      console.log(`  ✓ ${name} (${r.id})  dealId=${deal.id}  created=${deal.created}  → Replied`);
    } catch (err) {
      totals.errors += 1;
      console.warn(`  ! ${name} (${r.id}) failed: ${(err as Error).message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(totals);
  if (dryRun) console.log('(dry run — no deals created)');
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
} finally {
  await closeDatabase();
  process.exit(process.exitCode ?? 0);
}
