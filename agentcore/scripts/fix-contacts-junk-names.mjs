#!/usr/bin/env node
// One-shot DB cleanup for contacts whose first_name / last_name was
// poisoned by the old LinkedIn /in/ scraper (before profile-sidebar.js
// learned to strip the "Verified" badge label and use document.title).
//
// What it does for each junky contact:
//   1. Try to recover a real name from the LinkedIn URL slug.
//      e.g. /in/john-smith-abc123/ → "John Smith"
//   2. If the slug yields a 2+ token name → split + UPDATE first_name / last_name
//   3. Otherwise → NULL the junk fields. The next manual save from the
//      extension will then trigger the dedup-branch backfill (see
//      extension.routes.ts → isJunky check) and the row gets re-populated.
//
// Junk patterns matched (case-insensitive, word-boundary):
//   - "View" / "View ... profile" / "View ... verifications"
//   - "Verified" / "verifications"
//   - "profile"
//
// Run with:
//   node agentcore/scripts/fix-contacts-junk-names.mjs
//
// Or dry-run first (recommended):
//   DRY_RUN=1 node agentcore/scripts/fix-contacts-junk-names.mjs

import pg from 'pg';

const DRY_RUN = process.env.DRY_RUN === '1';

const client = process.env.DATABASE_URL
  ? new pg.Client({ connectionString: process.env.DATABASE_URL })
  : new pg.Client({
      host: 'localhost',
      user: 'agentcore',
      password: 'agentcore',
      database: 'agentcore',
    });

await client.connect();

const JUNK_RE = /\b(?:View|Verified|profile|verifications?)\b/i;

function isJunky(v) {
  return !v || JUNK_RE.test(String(v));
}

function decodeSlugToName(slug) {
  // Strip trailing LinkedIn hash suffix like "-1bbb37151" or "-94b897255"
  let cleaned = slug.replace(/-[a-z0-9]{6,}$/i, '');
  try { cleaned = decodeURIComponent(cleaned); } catch {}
  return cleaned
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

function isValidName(name) {
  if (!name) return false;
  const t = name.trim();
  if (t.length < 2 || t.length > 100) return false;
  if (JUNK_RE.test(t)) return false;
  if (/%[0-9A-Fa-f]{2}/.test(t)) return false;
  return true;
}

// Pull every contact whose first_name OR last_name OR title looks junky.
const { rows } = await client.query(`
  SELECT id, first_name, last_name, title, company_name, linkedin_url
  FROM contacts
  WHERE first_name ~* '\\m(View|Verified|profile|verifications)\\M'
     OR last_name  ~* '\\m(View|Verified|profile|verifications)\\M'
     OR title      ~* '\\m(View|Verified|profile|verifications)\\M'
`);

console.log(`Found ${rows.length} contacts with junk-pattern names/titles`);

let recoveredFromSlug = 0;
let nullified = 0;
let kept = 0;
let touched = 0;

for (const row of rows) {
  const url = String(row.linkedin_url || '');
  const slugMatch = url.match(/\/in\/([^\/?#]+)/);

  let newFirst = row.first_name;
  let newLast = row.last_name;
  let newTitle = row.title;
  let strategy = 'none';

  // 1. Try to recover from the LinkedIn URL slug.
  if (slugMatch) {
    const decoded = decodeSlugToName(slugMatch[1]);
    const tokens = decoded.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2 && isValidName(decoded)) {
      // Only overwrite the parts that are junky — keep good values.
      if (isJunky(newFirst)) newFirst = tokens[0];
      if (isJunky(newLast))  newLast  = tokens.slice(1).join(' ');
      strategy = 'slug';
      recoveredFromSlug++;
    }
  }

  // 2. If we didn't recover good values from slug, NULL the junky fields
  //    so the extension's lazy backfill repairs them on next manual save.
  if (strategy === 'none') {
    if (isJunky(newFirst)) newFirst = null;
    if (isJunky(newLast))  newLast  = null;
    nullified++;
  }

  // 3. Title — never recoverable from URL. Just NULL if junky.
  if (isJunky(newTitle)) newTitle = null;

  const changed =
    newFirst !== row.first_name ||
    newLast  !== row.last_name  ||
    newTitle !== row.title;

  if (!changed) { kept++; continue; }
  touched++;

  console.log(
    `[${strategy}] ${row.id} ` +
    `first: ${JSON.stringify(row.first_name)} → ${JSON.stringify(newFirst)} | ` +
    `last: ${JSON.stringify(row.last_name)} → ${JSON.stringify(newLast)} | ` +
    `title: ${row.title ? '<junk>' : '<empty>'} → ${newTitle ? '<kept>' : 'null'}`,
  );

  if (!DRY_RUN) {
    await client.query(
      `UPDATE contacts
       SET first_name = $1, last_name = $2, title = $3, updated_at = NOW()
       WHERE id = $4`,
      [newFirst, newLast, newTitle, row.id],
    );
  }
}

console.log(
  `\nDone. ${touched} touched · ${recoveredFromSlug} recovered from URL slug · ` +
  `${nullified} nullified for lazy backfill · ${kept} unchanged.`,
);
if (DRY_RUN) console.log('DRY_RUN=1 → no UPDATE statements were executed.');

await client.end();
