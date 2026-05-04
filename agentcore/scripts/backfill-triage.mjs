#!/usr/bin/env node
// Triage backfill — runs the LLM triage layer over every untriaged
// company for one master agent (or all agents in the workspace).
//
// Usage:
//   npm run build  # required: imports from dist/
//   node scripts/backfill-triage.mjs                  # all agents
//   node scripts/backfill-triage.mjs <masterAgentId>  # one agent
//
// Env: DATABASE_URL (required), AWS_BEARER_TOKEN_BEDROCK, AWS_BEDROCK_REGION

import pg from 'pg';
import { batchTriageCompanies } from '../dist/services/company-triage.service.js';

const argMasterAgentId = process.argv[2];

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const totals = { agents: 0, triaged: 0, accepted: 0, rejected: 0, reviewed: 0, errors: 0 };

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

  console.log(`Backfilling triage for ${agentRows.length} agent(s).`);

  for (const agent of agentRows) {
    totals.agents += 1;
    console.log(`\n— ${agent.name} (${agent.id}) — tenant ${agent.tenant_id}`);

    const counts = await batchTriageCompanies({
      tenantId: agent.tenant_id,
      masterAgentId: agent.id,
      force: false,
      concurrency: 3,
    });

    console.log(
      `  done — triaged: ${counts.triaged}  accepted: ${counts.accepted}  rejected: ${counts.rejected}  reviewed: ${counts.reviewed}  errors: ${counts.errors}`,
    );

    totals.triaged += counts.triaged;
    totals.accepted += counts.accepted;
    totals.rejected += counts.rejected;
    totals.reviewed += counts.reviewed;
    totals.errors += counts.errors;
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
