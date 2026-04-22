#!/usr/bin/env node
// Backfill people[] names in companies.raw_data:
//   - URL-decode "%C5%A1"-style residue → proper UTF-8
//   - Expand first-name-only entries ("Laura") to full name from /in/ slug
//     ("laura-dijokiene-1a64053b" → "Laura Dijokiene")
//
// Usage:  node scripts/fix-people-names.mjs
//
// Env:    DATABASE_URL (preferred) OR defaults to localhost/agentcore/agentcore.

import pg from 'pg';

const client = process.env.DATABASE_URL
  ? new pg.Client({ connectionString: process.env.DATABASE_URL })
  : new pg.Client({
      host: 'localhost',
      user: 'agentcore',
      password: 'agentcore',
      database: 'agentcore',
    });

await client.connect();

function decodeSlugToName(slug) {
  let cleaned = slug.replace(/-[a-z0-9]{6,}$/i, '');
  try { cleaned = decodeURIComponent(cleaned); } catch {}
  return cleaned
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

function isValidName(name) {
  if (!name || name.length < 2) return false;
  if (/%[0-9A-Fa-f]{2}/.test(name)) return false;
  if (/^Status/i.test(name)) return false;
  return true;
}

const { rows } = await client.query(
  "SELECT id, raw_data->'people' AS people FROM companies WHERE raw_data->'people' IS NOT NULL",
);

let fixed = 0;
let updated = 0;

for (const row of rows) {
  const people = row.people;
  if (!Array.isArray(people)) continue;

  let changed = false;
  const cleaned = people.map((p) => {
    const currentName = String(p.name || '').trim();
    const url = String(p.linkedinUrl || '');
    const slugMatch = url.match(/\/in\/([^\/?#]+)/);

    // 1) URL-encoded residue → decode
    if (/%[0-9A-Fa-f]{2}/.test(currentName)) {
      try {
        const decoded = decodeURIComponent(currentName);
        if (isValidName(decoded)) {
          changed = true;
          fixed++;
          return { ...p, name: decoded };
        }
      } catch {}
    }

    // 2) Single-name entries ("Laura") with a richer slug → expand
    if (
      slugMatch &&
      currentName &&
      !currentName.includes(' ') &&
      currentName.length < 15
    ) {
      const slugParts = slugMatch[1]
        .split('-')
        .filter((s) => !/^[a-z0-9]{6,}$/i.test(s));
      if (slugParts.length >= 2) {
        const fullName = decodeSlugToName(slugMatch[1]);
        if (isValidName(fullName) && fullName.length > currentName.length) {
          changed = true;
          fixed++;
          return { ...p, name: fullName };
        }
      }
    }

    // 3) Invalid/missing names → rebuild from slug
    if (!isValidName(currentName) && slugMatch) {
      const fullName = decodeSlugToName(slugMatch[1]);
      if (isValidName(fullName)) {
        changed = true;
        fixed++;
        return { ...p, name: fullName };
      }
    }

    return p;
  });

  if (changed) {
    await client.query(
      "UPDATE companies SET raw_data = jsonb_set(raw_data, '{people}', $1::jsonb) WHERE id = $2",
      [JSON.stringify(cleaned), row.id],
    );
    updated++;
  }
}

console.log(`Fixed ${fixed} people across ${updated} companies`);
await client.end();
