// LinkedIn URL validation helpers — prevent fabricated/wrong-company URLs from
// reaching outreach. Used by enrichment.agent.ts and discovery sources.

const COMMON_COMPANY_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'gmbh', 'sarl', 'sa', 'sas', 'co', 'company',
  'corp', 'corporation', 'holdings', 'group', 'technologies', 'tech', 'labs',
  'studio', 'studios', 'software', 'solutions', 'systems', 'plc', 'ag', 'kg',
  'bv', 'nv', 'oy', 'ab', 'as', 'spa', 'srl', 'pty', 'llp',
]);

/** Tokenize a company name for slug-matching: lowercase, drop legal suffixes/punctuation, keep ≥3-char tokens. */
export function normalizeCompanyNameForMatch(name: string): string[] {
  if (!name) return [];
  return name
    .toLowerCase()
    .replace(/[,.()&'"!?]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !COMMON_COMPANY_SUFFIXES.has(t));
}

/**
 * Pick the best linkedin.com/company/<slug> URL from search candidates by scoring slug-token
 * and title-token matches against the target company name. Returns null if NOTHING matches —
 * never returns a guess.
 */
export function pickBestLinkedInCompanyUrl(
  candidates: Array<{ url: string; title: string; snippet: string }>,
  companyName: string,
): string | null {
  const tokens = normalizeCompanyNameForMatch(companyName);
  if (tokens.length === 0) return null;

  const linkedinResults = candidates.filter((r) => r.url.includes('linkedin.com/company/'));
  if (linkedinResults.length === 0) return null;

  const scored = linkedinResults.map((r) => {
    if (!r.url) return { url: '', score: 0 };
    const slug = r.url.match(/linkedin\.com\/company\/([^/?#]+)/)?.[1]?.toLowerCase() ?? '';
    const titleLower = (r.title ?? '').toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (slug.includes(tok)) score += 3;
      if (titleLower.startsWith(tok)) score += 2;
      else if (titleLower.includes(tok)) score += 1;
    }
    return { url: r.url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  // Require at least 1 token match — otherwise it's a guess and we return null
  return scored[0] && scored[0].score >= 1 ? scored[0].url : null;
}

/**
 * Verify that a linkedin.com/in/<slug> URL belongs to the named person. LinkedIn slugs are
 * typically firstname-lastname[-numbers], so we require BOTH names to appear in the slug.
 * Returns false on any mismatch — never a guess.
 */
export function slugMatchesPerson(
  linkedinUrl: string,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): boolean {
  if (!linkedinUrl || !firstName || !lastName) return false;
  const slug = linkedinUrl.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1]?.toLowerCase() ?? '';
  if (!slug) return false;
  const fn = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const ln = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (fn.length < 2 || ln.length < 2) return false;
  return slug.includes(fn) && slug.includes(ln);
}

/**
 * Find the first linkedin.com/in/<slug> URL in search results that passes the person slug check.
 * Returns null if none of the candidates match — never returns a guess.
 */
export function pickBestLinkedInPersonUrl(
  candidates: Array<{ url: string; title: string; snippet: string }>,
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  if (!firstName || !lastName) return null;
  for (const c of candidates) {
    if (!c.url.includes('linkedin.com/in/')) continue;
    if (slugMatchesPerson(c.url, firstName, lastName)) return c.url;
  }
  return null;
}
