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

/**
 * Fuzzy-match contacts in a tenant by name and/or email.
 * Returns up to `limit` candidates ordered by score (email matches first).
 *
 * Strategy:
 * - If `email` is given, prefer exact and case-insensitive matches.
 * - For `name`, split on whitespace and ILIKE-match each token against
 *   first_name OR last_name. Boost when both tokens hit.
 */
export async function matchContacts(args: {
  tenantId: string;
  name?: string | null;
  email?: string | null;
  limit?: number;
}): Promise<ContactCandidate[]> {
  const limit = args.limit ?? 5;
  const tokens = (args.name ?? '').trim().split(/\s+/).filter((t) => t.length >= 2);
  const email = (args.email ?? '').trim().toLowerCase();

  if (tokens.length === 0 && !email) return [];

  return withTenant(args.tenantId, async (tx) => {
    const conditions = [eq(contacts.tenantId, args.tenantId)];
    const orParts: ReturnType<typeof sql>[] = [];
    if (email) {
      orParts.push(sql`LOWER(${contacts.email}) = ${email}`);
      orParts.push(sql`LOWER(${contacts.email}) LIKE ${'%' + email + '%'}`);
    }
    for (const tok of tokens) {
      orParts.push(sql`${contacts.firstName} ILIKE ${'%' + tok + '%'}`);
      orParts.push(sql`${contacts.lastName} ILIKE ${'%' + tok + '%'}`);
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

    // Score in JS: email exact = 100, email contains = 80, both name tokens = 60,
    // single token = 30. Tiebreak: any email present.
    const scored: ContactCandidate[] = rows.map((r) => {
      let score = 0;
      let matchType: 'email' | 'name' = 'name';
      if (email && r.email) {
        const e = r.email.toLowerCase();
        if (e === email) { score = 100; matchType = 'email'; }
        else if (e.includes(email)) { score = 80; matchType = 'email'; }
      }
      if (score === 0 && tokens.length > 0) {
        const fn = (r.firstName ?? '').toLowerCase();
        const ln = (r.lastName ?? '').toLowerCase();
        const hits = tokens.filter((t) => fn.includes(t.toLowerCase()) || ln.includes(t.toLowerCase())).length;
        score = hits >= 2 ? 60 : hits === 1 ? 30 : 0;
      }
      return { ...r, matchType, score };
    });

    return scored
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || ((b.email ? 1 : 0) - (a.email ? 1 : 0)))
      .slice(0, limit);
  });
}
