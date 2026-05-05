#!/usr/bin/env node
// One-shot migration: synthesize a rawData.fitScore (new continuous shape)
// from each company's legacy rawData.triage (old binary verdict). NO LLM
// calls — this is a deterministic mapping so deploys are cheap and quick.
//
//   verdict 'accept' → buyer_fit_score 70, all 4 components 70
//   verdict 'reject' → 20
//   verdict 'review' → 50
//
// Each synthesized verdict carries model_used: 'migrated',
// data_completeness: 'partial' so the dashboard can show the user that
// these scores aren't full LLM grades. Real re-scores happen on the next
// scrape or when the user clicks Re-score.
//
// rawData.triage is left in place for audit; the dashboard reads
// rawData.fitScore preferentially.
//
// Usage:
//   node scripts/migrate-triage-to-fit-score.mjs
//   node scripts/migrate-triage-to-fit-score.mjs --dry-run
// Env: DATABASE_URL

import pg from 'pg';

const dryRun = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const VERDICT_TO_SCORE = { accept: 70, reject: 20, review: 50 };

function synthesizeFitScore(triage) {
  const verdict = triage?.verdict;
  const score = VERDICT_TO_SCORE[verdict] ?? 50;
  const summaryFromOld =
    typeof triage?.fit_score_explanation === 'string' && triage.fit_score_explanation
      ? triage.fit_score_explanation
      : `Migrated from legacy '${verdict ?? 'unknown'}' verdict. Re-score for an accurate result.`;
  return {
    buyer_fit_score: score,
    component_scores: {
      is_real_business: { score, reasoning: 'Migrated from legacy verdict.' },
      icp_match: { score, reasoning: 'Migrated from legacy verdict.' },
      buyer_signal_strength: { score, reasoning: 'Migrated from legacy verdict.' },
      decision_maker_reachable: { score: null, reasoning: 'Not evaluated by the legacy scorer.' },
    },
    key_person: triage?.key_person ?? null,
    key_person_problem: triage?.key_person_problem ?? null,
    signals: triage?.signals ?? {
      hiring_signals: [],
      funding_signals: [],
      growth_signals: [],
      tech_signals: [],
      pain_hypotheses: [],
    },
    fit_summary: summaryFromOld,
    scored_at: new Date().toISOString(),
    model_used: 'migrated',
    data_completeness: 'partial',
  };
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const summary = { tenants: new Set(), candidates: 0, migrated: 0, skipped: 0 };

try {
  const { rows } = await client.query(
    `SELECT id, tenant_id, name, raw_data
     FROM companies
     WHERE raw_data ? 'triage'
       AND NOT (raw_data ? 'fitScore')`,
  );

  console.log(`Found ${rows.length} company row(s) with rawData.triage and no rawData.fitScore.`);
  if (dryRun) {
    console.log('--dry-run set — no writes will be performed.');
  }
  summary.candidates = rows.length;

  for (const row of rows) {
    summary.tenants.add(row.tenant_id);
    const triage = row.raw_data?.triage;
    if (!triage || typeof triage !== 'object') {
      summary.skipped++;
      continue;
    }
    const fitScore = synthesizeFitScore(triage);
    const newRaw = { ...row.raw_data, fitScore };

    if (!dryRun) {
      await client.query(
        `UPDATE companies SET raw_data = $1, updated_at = NOW() WHERE id = $2`,
        [newRaw, row.id],
      );
    }
    summary.migrated++;
    if (summary.migrated % 50 === 0) {
      console.log(`  …migrated ${summary.migrated}/${rows.length}`);
    }
  }

  console.log('\n=== Migration summary ===');
  console.log(`  tenants touched: ${summary.tenants.size}`);
  console.log(`  candidates:      ${summary.candidates}`);
  console.log(`  migrated:        ${summary.migrated}${dryRun ? ' (dry-run)' : ''}`);
  console.log(`  skipped:         ${summary.skipped}`);
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await client.end();
  process.exit(process.exitCode ?? 0);
}
