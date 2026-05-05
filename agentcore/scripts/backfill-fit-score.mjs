#!/usr/bin/env node
// Fit-score backfill — runs the LLM buyer-fit scorer over every unscored
// company for one master agent (or all agents in the workspace). Costly
// (one LLM call per company); use for catch-up rather than per-deploy.
//
// Usage:
//   npm run build  # required: imports from dist/
//   node scripts/backfill-fit-score.mjs                  # all agents
//   node scripts/backfill-fit-score.mjs <masterAgentId>  # one agent
//
// Env: DATABASE_URL (required), AWS_BEARER_TOKEN_BEDROCK, AWS_BEDROCK_REGION

import pg from 'pg';
import { batchScoreCompanies } from '../dist/services/buyer-fit-score.service.js';

const argMasterAgentId = process.argv[2];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const totals = { agents: 0, scored: 0, errors: 0, full: 0, partial: 0 };

try {
  let agentRows;
  if (argMasterAgentId) {
    const r = await client.query(
      `SELECT id, tenant_id, name FROM master_agents WHERE id = $1`,
      [argMasterAgentId],
    );
    agentRows = r.rows;
  } else {
    const r = await client.query(
      `SELECT id, tenant_id, name FROM master_agents ORDER BY created_at DESC`,
    );
    agentRows = r.rows;
  }

  if (agentRows.length === 0) {
    console.log('No master agents found.');
    process.exit(0);
  }

  console.log(`Backfilling fit-score for ${agentRows.length} agent(s).`);

  for (const agent of agentRows) {
    totals.agents += 1;
    console.log(`\n— ${agent.name} (${agent.id}) — tenant ${agent.tenant_id}`);

    const counts = await batchScoreCompanies({
      tenantId: agent.tenant_id,
      masterAgentId: agent.id,
      force: false,
      concurrency: 3,
    });

    console.log(
      `  done — scored: ${counts.scored}  errors: ${counts.errors}  avg: ${counts.avgScore}  full: ${counts.fullDataCount}  partial: ${counts.partialDataCount}`,
    );
    console.log(`  distribution:`, counts.distribution);

    totals.scored += counts.scored;
    totals.errors += counts.errors;
    totals.full += counts.fullDataCount;
    totals.partial += counts.partialDataCount;
  }

  console.log('\n=== Final summary ===');
  console.log(totals);
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
} finally {
  await client.end();
  process.exit(process.exitCode ?? 0);
}
