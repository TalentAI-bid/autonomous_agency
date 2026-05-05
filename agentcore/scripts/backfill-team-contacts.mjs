#!/usr/bin/env node
// Backfill contacts rows from companies.raw_data.people for tenants where
// the dispatcher's contact insert failed (missing masterAgentId, strict
// lastName rule, etc.). Idempotent: skips people whose linkedinUrl is
// already a contact for the same (tenantId, masterAgentId, companyId).
//
// Usage:
//   node scripts/backfill-team-contacts.mjs --tenant-id <uuid> [--dry-run]
//   node scripts/backfill-team-contacts.mjs --tenant-id <uuid> --master-agent-id <uuid>
//
// Env: DATABASE_URL (preferred) OR defaults to localhost/agentcore/agentcore.

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

const tenantId = flags['tenant-id'];
const masterAgentScope = flags['master-agent-id'];
const dryRun = !!flags['dry-run'];

if (!tenantId) {
  console.error('Usage: backfill-team-contacts.mjs --tenant-id <uuid> [--master-agent-id <uuid>] [--dry-run]');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────
// Sanitizers — port of agentcore/src/services/extension-dispatcher.ts
// ────────────────────────────────────────────────────────────────────────
const JUNK_TITLE_REGEX = /^(status is (online|offline)|message|follow|connect|view profile|see more)$/i;

function sanitizeTitle(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (JUNK_TITLE_REGEX.test(trimmed)) return null;
  return trimmed;
}

function sanitizePersonName(raw) {
  if (!raw) return null;
  let name = String(raw).trim().replace(/\s+/g, ' ');
  if (name.length < 2) return null;

  const inner = name.match(/View\s+(.+?)(?:[’'‘`]s\s+profile|\s+profile)/i);
  if (inner && inner[1]) {
    const candidate = inner[1].trim();
    if (candidate.length >= 2 && candidate.length <= 100) name = candidate;
  } else {
    name = name.replace(/\s*View\s+\S.*?(?:[’'‘`]s\s+profile|\s+profile)\s*$/i, '').trim();
  }

  name = name.replace(/(?<=[A-Za-zÀ-ÿ])View\b.*$/i, '').trim();
  name = name.replace(/[‘’'"`]+\s*$/, '').trim();

  if (name.length < 2 || name.length > 100) return null;
  if (/View\b/i.test(name)) return null;
  if (/\bprofile\b/i.test(name)) return null;
  if (/%[0-9A-Fa-f]{2}/.test(name)) return null;
  return name;
}

function scorePersonTitle(title) {
  if (!title) return 0;
  const t = String(title).toLowerCase();
  if (/\b(ceo|cto|cfo|coo|cmo|chro|cio|ciso)\b/.test(t)) return 100;
  if (/chief\s+\w+(?:\s+\w+)?\s+officer/.test(t)) return 100;
  if (/\b(founder|co[\s-]?founder|owner|president|managing\s+director|managing\s+partner)\b/.test(t)) return 100;
  if (/\b(talent\s+(acquisition|partner|manager|lead|director))\b/.test(t)) return 90;
  if (/\b(recruit(er|ing|ment)?|sourcer|head\s+of\s+(talent|people|hr))\b/.test(t)) return 90;
  if (/\b(hr\s+(director|manager|partner|lead)|chief\s+people|people\s+(ops|operations|partner))\b/.test(t)) return 85;
  if (/\b(hiring\s+manager)\b/.test(t)) return 85;
  if (/\bvp\b|vice\s+president/.test(t)) return 75;
  if (/\bhead\s+of\b/.test(t)) return 70;
  if (/\b(director|principal)\b/.test(t)) return 55;
  if (/\b(engineering|product|design|sales|marketing|operations)\s+(manager|lead|director)\b/.test(t)) return 40;
  if (/\b(tech\s+lead|team\s+lead|staff\s+engineer)\b/.test(t)) return 35;
  if (/\b(manager|lead)\b/.test(t)) return 25;
  return 5;
}

function rankPeople(people) {
  return [...people].sort((a, b) => scorePersonTitle(b.title) - scorePersonTitle(a.title));
}

// ────────────────────────────────────────────────────────────────────────
// Main
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

const totals = {
  companiesScanned: 0,
  companiesWithPeople: 0,
  contactsInserted: 0,
  contactsSkippedExisting: 0,
  errors: 0,
};

try {
  console.log(`Backfill scope: tenant=${tenantId}` + (masterAgentScope ? ` masterAgent=${masterAgentScope}` : '') + (dryRun ? ' (DRY RUN)' : ''));

  const companyQuery = masterAgentScope
    ? `SELECT id, name, master_agent_id, raw_data FROM companies
        WHERE tenant_id = $1
          AND master_agent_id = $2
          AND raw_data ? 'people'
          AND jsonb_typeof(raw_data->'people') = 'array'
          AND jsonb_array_length(raw_data->'people') > 0`
    : `SELECT id, name, master_agent_id, raw_data FROM companies
        WHERE tenant_id = $1
          AND raw_data ? 'people'
          AND jsonb_typeof(raw_data->'people') = 'array'
          AND jsonb_array_length(raw_data->'people') > 0`;

  const companyParams = masterAgentScope ? [tenantId, masterAgentScope] : [tenantId];
  const { rows: companyRows } = await client.query(companyQuery, companyParams);

  totals.companiesWithPeople = companyRows.length;
  console.log(`Found ${companyRows.length} companies with people[] populated.\n`);

  for (const company of companyRows) {
    totals.companiesScanned += 1;
    const people = Array.isArray(company.raw_data?.people) ? company.raw_data.people : [];
    const ranked = rankPeople(people).slice(0, 3);

    const wouldInsert = [];
    let inserted = 0;
    let skippedExisting = 0;
    let errors = 0;

    for (const person of ranked) {
      const cleanName = sanitizePersonName(person?.name);
      if (!cleanName) continue;
      const parts = cleanName.split(/\s+/);
      const firstName = parts[0] || '';
      const lastName = parts.slice(1).join(' ');
      if (!firstName) continue;
      if (/^(view|profile)$/i.test(firstName) || (lastName && /\b(view|profile)\b/i.test(lastName))) continue;

      const linkedinUrl = person?.linkedinUrl ? String(person.linkedinUrl).trim() : null;

      // Idempotent dedup: skip when the same (tenantId, masterAgentId, companyId, linkedinUrl) row exists.
      // IS NOT DISTINCT FROM treats null = null, matching the dispatcher's "fallback when masterAgentId null" semantics.
      if (linkedinUrl) {
        const { rows: existingRows } = await client.query(
          `SELECT id FROM contacts
            WHERE tenant_id = $1
              AND linkedin_url = $2
              AND master_agent_id IS NOT DISTINCT FROM $3
              AND company_id IS NOT DISTINCT FROM $4
            LIMIT 1`,
          [tenantId, linkedinUrl, company.master_agent_id ?? null, company.id],
        );
        if (existingRows.length > 0) {
          skippedExisting += 1;
          continue;
        }
      }

      wouldInsert.push({ name: cleanName, title: person?.title ?? null, linkedinUrl });

      if (dryRun) continue;

      try {
        await client.query(
          `INSERT INTO contacts (
             tenant_id, master_agent_id, first_name, last_name, title,
             linkedin_url, company_id, company_name, source, is_primary_contact, raw_data
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'linkedin_profile', false, $9)`,
          [
            tenantId,
            company.master_agent_id ?? null,
            firstName,
            lastName,
            sanitizeTitle(person?.title),
            linkedinUrl,
            company.id,
            company.name,
            JSON.stringify({ discoverySource: 'linkedin_extension_people_backfill', ...person }),
          ],
        );
        inserted += 1;
      } catch (err) {
        errors += 1;
        console.warn(`  ! ${company.name} — failed to insert ${cleanName}: ${err.message}`);
      }
    }

    if (wouldInsert.length > 0 || skippedExisting > 0) {
      const summary = dryRun
        ? `wouldInsert=${wouldInsert.length} skippedExisting=${skippedExisting}`
        : `inserted=${inserted} skippedExisting=${skippedExisting} errors=${errors}`;
      console.log(`  ${company.name} (${company.id})  peopleScraped=${people.length}  ${summary}`);
      if (dryRun && wouldInsert.length > 0) {
        for (const p of wouldInsert) {
          console.log(`     → ${p.name}  ·  ${p.title ?? '(no title)'}  ·  ${p.linkedinUrl ?? '(no url)'}`);
        }
      }
    }

    totals.contactsInserted += inserted;
    totals.contactsSkippedExisting += skippedExisting;
    totals.errors += errors;
  }

  console.log('\n=== Final summary ===');
  console.log(totals);
  if (dryRun) console.log('(dry run — no rows inserted)');
} catch (err) {
  console.error('Backfill failed:', err);
  process.exitCode = 1;
} finally {
  await client.end();
  process.exit(process.exitCode ?? 0);
}
