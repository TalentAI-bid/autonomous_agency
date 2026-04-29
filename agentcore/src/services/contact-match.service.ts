import { sql, and, eq } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts } from '../db/schema/index.js';

export interface ContactCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  companyName: string | null;
  masterAgentId: string | null;
  matchType: 'email' | 'name';
  score: number;
}

const MIN_SCORE = 30;

/**
 * Fuzzy-match contacts in a tenant by name and/or email.
 *
 * Name matching is word-boundary aware: a token must (a) equal a name field,
 * (b) match the start of one (e.g. "hart" matches "Hart Lambur" but NOT
 * "Matys ACHART"), or (c) be wrapped in word boundaries inside a multi-word
 * field. Substring-anywhere is rejected — that produced false positives like
 * "Hart" hitting "ACHART".
 *
 * Email matching is more permissive (exact = 100, contains = 80) since
 * email addresses are already unique-ish.
 */
export async function matchContacts(args: {
  tenantId: string;
  name?: string | null;
  email?: string | null;
  limit?: number;
}): Promise<ContactCandidate[]> {
  const limit = args.limit ?? 5;
  const tokens = (args.name ?? '')
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
  const email = (args.email ?? '').trim().toLowerCase();

  if (tokens.length === 0 && !email) return [];

  return withTenant(args.tenantId, async (tx) => {
    // Pull a wide-ish candidate set, then score precisely in JS. We still
    // pre-filter at SQL level to avoid scanning the full contacts table:
    // any token can be a starts-with prefix on first OR last name, OR the
    // email matches.
    const conditions = [eq(contacts.tenantId, args.tenantId)];
    const orParts: ReturnType<typeof sql>[] = [];
    if (email) {
      orParts.push(sql`LOWER(${contacts.email}) = ${email}`);
      orParts.push(sql`LOWER(${contacts.email}) LIKE ${'%' + email + '%'}`);
    }
    for (const tok of tokens) {
      // starts-with on either field — narrow + index-friendly
      orParts.push(sql`LOWER(${contacts.firstName}) LIKE ${tok + '%'}`);
      orParts.push(sql`LOWER(${contacts.lastName}) LIKE ${tok + '%'}`);
      // word-boundary anywhere (covers middle name / "first last" multi-word fields)
      orParts.push(sql`LOWER(${contacts.firstName}) ~ ${'\\m' + escapeRegex(tok) + '\\M'}`);
      orParts.push(sql`LOWER(${contacts.lastName}) ~ ${'\\m' + escapeRegex(tok) + '\\M'}`);
    }
    if (orParts.length === 0) return [];
    conditions.push(sql`(${sql.join(orParts, sql` OR `)})`);

    const rows = await tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        companyName: contacts.companyName,
        masterAgentId: contacts.masterAgentId,
      })
      .from(contacts)
      .where(and(...conditions))
      .limit(50);

    const scored: ContactCandidate[] = rows.map((r) => {
      const score = scoreCandidate({
        rowFirst: (r.firstName ?? '').toLowerCase(),
        rowLast: (r.lastName ?? '').toLowerCase(),
        rowEmail: (r.email ?? '').toLowerCase(),
        tokens,
        email,
      });
      const matchType: 'email' | 'name' =
        email && score.email > 0 ? 'email' : 'name';
      return {
        id: r.id,
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        companyName: r.companyName,
        masterAgentId: r.masterAgentId,
        matchType,
        score: score.total,
      };
    });

    return scored
      .filter((c) => c.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score || ((b.email ? 1 : 0) - (a.email ? 1 : 0)))
      .slice(0, limit);
  });
}

interface ScoreParts { email: number; name: number; total: number }

function scoreCandidate(args: {
  rowFirst: string;
  rowLast: string;
  rowEmail: string;
  tokens: string[];
  email: string;
}): ScoreParts {
  let emailScore = 0;
  if (args.email && args.rowEmail) {
    if (args.rowEmail === args.email) emailScore = 100;
    else if (args.rowEmail.includes(args.email)) emailScore = 80;
  }

  // Name token hits: each token can match either field. Hit kinds:
  // - 'full'    : token equals the whole field (best)
  // - 'start'   : token is the prefix of the field
  // - 'wordmid' : token sits at a word boundary inside a multi-word field
  // - 'none'    : no clean match (substring inside a single word — rejected)
  type HitKind = 'full' | 'start' | 'wordmid' | 'none';
  function classify(value: string, token: string): HitKind {
    if (!value) return 'none';
    if (value === token) return 'full';
    if (value.startsWith(token)) return 'start';
    // word boundary inside a multi-word value (e.g. "ana maria garcia" + "maria")
    const re = new RegExp(`\\b${escapeRegex(token)}\\b`);
    if (re.test(value)) return 'wordmid';
    return 'none';
  }

  const hits = args.tokens.map((tok) => {
    const f = classify(args.rowFirst, tok);
    const l = classify(args.rowLast, tok);
    return f !== 'none' ? f : l;
  });
  const cleanHits = hits.filter((h) => h !== 'none').length;

  let nameScore = 0;
  if (args.tokens.length === 0) {
    nameScore = 0;
  } else if (cleanHits >= 2) {
    // both tokens hit — strong full-name match
    nameScore = 60;
  } else if (cleanHits === 1) {
    // only one token hit — single-name match. Penalise asymmetry: if the
    // input was "First Last" but only one token hit, this is likely a
    // different person sharing a first or last name, so cap at 30.
    nameScore = args.tokens.length >= 2 ? 30 : 30;
  } else {
    nameScore = 0;
  }

  // Email beats name. If both, take max (don't double-count).
  return { email: emailScore, name: nameScore, total: Math.max(emailScore, nameScore) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
