/**
 * Structured pain point with required citation. The LLM must output this
 * shape going forward; legacy `string[]` saves are normalised at the read
 * boundary by `normalizeLegacyPainPoint`.
 */
export interface GroundedPainPoint {
  claim: string;
  citation: string;
}

export interface GroundedOutreachAngle {
  angle: string;
  citation: string;
}

export interface DeepCompanyProfile {
  name: string;
  domain: string;
  industry: string;
  size: string;
  techStack: string[];
  funding: string;
  description: string;
  linkedinUrl: string;
  products: string[];
  foundedYear: string;
  headquarters: string;
  cultureValues: string[];
  recentNews: Array<{ headline: string; date: string }>;
  openPositions: Array<{
    title: string;
    location: string;
    requiredSkills: string[];
    salary: string;
    description: string;
    url: string;
  }>;
  keyPeople: Array<{ name: string; title: string; department: string }>;
  competitors: string[];
  contactEmail: string;
  hiringContactEmails: string[];
  glassdoorRating: string;
  employeeCount: string;
  recentFunding: string;
  teamPageUrl: string;
  // Grounded-or-nothing fields. New writes use structured shape; legacy
  // string[] reads should pass through normalizeLegacyPainPoints first.
  painPoints: GroundedPainPoint[];
  techGapScore: number;
  techGapScoreEvidence: string | null;
  outreachAngle: GroundedOutreachAngle | null;
}

/**
 * Normalise a painPoint that might be in the legacy `string` format or the
 * new `{ claim, citation }` format. Returns `{ claim, citation: null }` for
 * legacy strings so consumers can iterate uniformly.
 */
export function normalizeLegacyPainPoint(
  pp: string | { claim?: string; citation?: string | null; description?: string; type?: string },
): { claim: string; citation: string | null } {
  if (typeof pp === 'string') return { claim: pp, citation: null };
  if (pp && typeof pp === 'object') {
    const claim = pp.claim ?? pp.description ?? '';
    const citation = pp.citation ?? null;
    return { claim, citation };
  }
  return { claim: String(pp), citation: null };
}

export function buildSystemPrompt(missionContext?: string): string {
  const missionBlock = missionContext
    ? `

MISSION CONTEXT:
${missionContext}

KEY PEOPLE PRIORITY — ADAPT TO MISSION ABOVE:
The mission context determines which roles to prioritize:
- Tech services (DevOps, cloud, development, SaaS, platform): CTO, VP Engineering, Head of Engineering, Engineering Manager, Head of DevOps, Head of Platform, Head of Infrastructure
- HR / recruitment / talent services: Head of HR, VP People, Chief People Officer, Talent Acquisition Director, Head of Recruitment, People Ops Lead
- Marketing services: CMO, VP Marketing, Head of Growth, Head of Demand Generation, Head of Brand
- Sales services / tools: VP Sales, Chief Revenue Officer, Head of Sales Ops, Head of Revenue, Sales Director
- Finance / legal / compliance: CFO, VP Finance, General Counsel, Head of Compliance, Head of Risk
- Data / analytics services: Chief Data Officer, Head of Data, VP Analytics, Head of Business Intelligence
- General B2B or unclear mission: CEO, COO, Managing Director, Founder
`
    : '';

  return `You are a company research analyst specializing in deep company intelligence. Your job is to extract comprehensive company data from multiple web sources (company website, about page, careers page, team page, LinkedIn, Crunchbase, news, Glassdoor, search results).${missionBlock}

──────────────────────────────────────────────
GROUNDED-OR-NOTHING RULE (MANDATORY)
──────────────────────────────────────────────

For every painPoint, outreachAngle, techGapScore, or signal you produce, you MUST cite the EXACT phrase from the input text that supports it. If you cannot cite a specific phrase from the description, openPositions, rawMeta, specialties, or other input fields, DO NOT INCLUDE THAT FIELD.

An empty painPoints array is the correct output for most companies. A null outreachAngle is the correct output when no concrete angle is supported. Do NOT manufacture content to fill the field.

FORBIDDEN PATTERNS (these are hallucinations — never produce them):
  ✗ "Website appears [...]" — you cannot see the website
  ✗ "May need modernization" / "Possibly needs scaling" — speculation
  ✗ "Small team managing X" — generic, applies to thousands of companies
  ✗ "Limited tech team" / "No visible engineering team" — you don't know their composition
  ✗ "WordPress / Wix / Squarespace [...]" — you only see this if EXPLICITLY mentioned in the input
  ✗ Anything starting with: "appears to," "likely," "possibly," "may have," "could benefit from," "seems to," "potential need"
  ✗ Recycled boilerplate like "they could use modern web development" — generic outreach is worse than no outreach

ALLOWED PATTERNS (only if input EXPLICITLY supports them):
  ✓ "Hiring 3 backend engineers" — IF openPositions has those entries
  ✓ "Recently raised Series A" — IF the description says so verbatim
  ✓ "Migrating to AWS" — IF specialties or description states it
  ✓ "200 employees and growing 40% YoY" — IF rawMeta or description states the growth rate

Each painPoint and the outreachAngle MUST include a 'citation' field showing the exact substring from input that supports it. Output without citations will be discarded by the validation layer and logged as a hallucination.

techGapScore: only output a non-zero value when grounded signals exist. If signals/painPoints arrays are empty, techGapScore MUST be 0. There is no "vibes-based" tech gap score.

──────────────────────────────────────────────
Rules:
- Extract all available information; use empty strings for unknown text, empty arrays for unknown lists.
- For techStack, infer from job postings, careers page, and product descriptions.
- For size, use ranges: "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+".
- For employeeCount, extract the most precise number available (e.g. "~350", "1200+"). Use "" if unknown.
- For funding, use: "Pre-seed", "Seed", "Series A/B/C/D+", "Public", "Bootstrapped", "Unknown".
- For recentFunding, extract the latest funding round details (e.g. "Series B - $50M led by Acme Ventures, Jan 2026"). Use "" if unknown.
- For glassdoorRating, extract the overall rating (e.g. "4.2/5"). Use "" if not found.
- keyPeople extraction — STRICT ANTI-HALLUCINATION RULES:
  - ONLY extract people whose FULL NAME appears VERBATIM in the provided website content above. Do NOT invent, guess, or infer names.
  - If no people names are visible in the text, return keyPeople: []. An empty array is correct when no names are found.
  - ONLY use HOMEPAGE, ABOUT PAGE, TEAM PAGE, and CAREERS PAGE content. IGNORE LinkedIn, news, or any external source for people names.
  - ONLY include CURRENT employees with a clear title/role visible in the content.
  - Do NOT include: former employees, board advisors, investors, clients, partners, or contractors.
  - Extract a MAXIMUM of 5 people. No more.
  - Priority order: use MISSION CONTEXT to determine which roles matter. Default: CTO, VP Engineering, Head of Engineering, COO, Founder.
  - EXCLUSION: Skip people with titles containing: Intern, Student, Junior, Trainee, Apprentice, Volunteer.
  - If fewer than 5 people are found, return only those found. Do NOT pad the list.
  - For each person: name (exactly as written in content), title, department (e.g. "Engineering", "Sales", "Executive").
  - Do NOT include LinkedIn URLs or email addresses — those are extracted separately.
  - Use empty strings for unknown fields.
- Extract teamPageUrl: the URL of the team/leadership page if found. Use "" if not found.
- Extract open positions from careers page if available. For each position extract: title, location, requiredSkills (array), salary (string, use "" if not found), description (brief), and url (if available).
- Extract culture values from about page or careers page.
- Extract contactEmail (general company contact email) and hiringContactEmails (HR/recruiting emails found on careers pages, job posts, or contact pages). Use empty string / empty array if not found.
- For competitors, infer from industry and product descriptions.
- painPoints: Array of grounded pain points. Each entry MUST be { "claim": "<short pain point>", "citation": "<exact substring from input that supports it>" }. Allowed citations come from the description, openPositions text, careers page, or specialties — NOT from speculation. Examples:
  * { "claim": "Hiring multiple senior engineers — scaling pressure", "citation": "Senior Backend Engineer @ Berlin — Go + k8s" }  (citation taken verbatim from openPositions)
  * { "claim": "Recent Series A — likely investing in infrastructure", "citation": "raised a $12M Series A in October 2025" }  (citation taken verbatim from description)
  Return [] when no pain point can be cited verbatim. An empty array is the correct, honest output for most companies.
- techGapScore: integer 0–100. MUST be 0 when painPoints is empty. Non-zero values REQUIRE at least one grounded painPoint.
- techGapScoreEvidence: string or null. Exact substring from input that justifies a non-zero score. Set to null when techGapScore is 0.
- outreachAngle: { "angle": "<one sentence>", "citation": "<exact substring from input>" } OR null. Return null when no specific angle is grounded in the input.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  companyName: string;
  domain?: string;
  homepageContent?: string;
  aboutPageContent?: string;
  careersPageContent?: string;
  teamPageContent?: string;
  linkedinCompanyContent?: string;
  crunchbaseContent?: string;
  newsContent?: string;
  glassdoorContent?: string;
  searchResults?: string;
}): string {
  const sections: string[] = [];

  sections.push(`COMPANY: ${data.companyName}${data.domain ? ` (${data.domain})` : ''}`);

  if (data.homepageContent) {
    sections.push(`HOMEPAGE CONTENT:\n${data.homepageContent.slice(0, 2500)}`);
  }

  if (data.aboutPageContent) {
    sections.push(`ABOUT PAGE CONTENT:\n${data.aboutPageContent.slice(0, 2000)}`);
  }

  if (data.careersPageContent) {
    sections.push(`CAREERS PAGE CONTENT:\n${data.careersPageContent.slice(0, 1500)}`);
  }

  if (data.teamPageContent) {
    sections.push(`TEAM/LEADERSHIP PAGE CONTENT:\n${data.teamPageContent.slice(0, 2500)}`);
  }

  if (data.linkedinCompanyContent) {
    sections.push(`LINKEDIN COMPANY PAGE CONTENT:\n${data.linkedinCompanyContent.slice(0, 1500)}`);
  }

  if (data.crunchbaseContent) {
    sections.push(`CRUNCHBASE / FUNDING CONTENT:\n${data.crunchbaseContent.slice(0, 1000)}`);
  }

  if (data.newsContent) {
    sections.push(`RECENT NEWS:\n${data.newsContent.slice(0, 1000)}`);
  }

  if (data.glassdoorContent) {
    sections.push(`GLASSDOOR REVIEWS:\n${data.glassdoorContent.slice(0, 500)}`);
  }

  if (data.searchResults) {
    sections.push(`SEARCH RESULTS:\n${data.searchResults.slice(0, 1000)}`);
  }

  return `Extract comprehensive company information from the sources below into a DeepCompanyProfile JSON object.

${sections.join('\n\n---\n\n')}

Return a single JSON object with all DeepCompanyProfile fields.`;
}
