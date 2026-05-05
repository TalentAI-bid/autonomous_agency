export type SellerProfile = {
  offering: string;
  targetIndustries: string[];
  sizeMin: number;
  sizeMax: number;
  geography: string;
  buyerFunctions: string[];
  exclusions: string[];
};

export type ScrapedCompany = {
  name: string;
  domain?: string | null;
  industry?: string | null;
  size?: string | null;
  headquarters?: string | null;
  founded?: string | null;
  linkedinUrl?: string | null;
  description?: string | null;
  specialties?: string[] | null;
  rawMeta?: string[] | null;
  people?: Array<{ name: string; title?: string | null; linkedinUrl?: string | null }> | null;
  openPositions?: Array<{ title?: string; location?: string; description?: string }> | null;
};

export type ComponentScore = {
  score: number;
  reasoning: string;
};

export type ComponentScoreOptional = {
  // null when no team data has arrived yet — the scorer can't evaluate
  // decision_maker_reachable without people. Aggregate redistributes the
  // missing 10% weight across the other three components.
  score: number | null;
  reasoning: string;
};

export type FitScoreSignals = {
  hiring_signals: Array<{ claim: string; citation: string }>;
  funding_signals: Array<{ claim: string; citation: string }>;
  growth_signals: Array<{ claim: string; citation: string }>;
  tech_signals: Array<{ claim: string; citation: string }>;
  pain_hypotheses: Array<{ stated_fact: string; inferred_pain: string; confidence: number }>;
};

export type FitScoreVerdict = {
  buyer_fit_score: number; // 0-100
  component_scores: {
    is_real_business: ComponentScore;
    icp_match: ComponentScore;
    buyer_signal_strength: ComponentScore;
    decision_maker_reachable: ComponentScoreOptional;
  };
  key_person: {
    name: string;
    title: string;
    linkedinUrl: string;
    rationale: string;
  } | null;
  key_person_problem:
    | null
    | 'no_decision_maker_in_scraped_list'
    | 'people_list_was_empty'
    | 'all_candidates_external';
  signals: FitScoreSignals;
  fit_summary: string;
  scored_at: string;
  model_used: string;
  data_completeness: 'partial' | 'full';
};

export function buildFitScoreSystemPrompt(): string {
  return `You are a B2B sales fit scorer. You score one company at a time on its fit for outreach. NEVER reject. ALWAYS score.

You'll receive: seller profile + one scraped company (description, size, industry, headquarters, specialties, founded year, list of people).

Return ONE JSON object — no prose, no markdown, no explanation.

──────────────── COMPONENT 1: is_real_business (0-100) ────────────────

100 = Operating commercial business with real product/service offering.
60-80 = Likely business but ambiguous (consultancy, agency, professional services).
20-40 = Likely NOT a buyer (large association, media outlet, wrong-target recruiter).
0-15 = Definitely not a buyer (small association, meetup, university group, book, podcast, generic acronym page, dormant/stealth, personal brand, freelancer).

Use description, name patterns, rawMeta. Don't penalize for similar NAME to an association if DESCRIPTION shows real product company.

Examples:
  "FINTECH BELGIUM" with description "first and biggest community of Fintechers" → 5
  "Belgium FinTech Solutions" with description "we build payment APIs" → 95
  "FinTech Magazine" → 10
  "FinTech Recruitment" if seller targets recruiters → 90; if not → 25
  "Machine Learning at Berkeley" → 5

──────────────── COMPONENT 2: icp_match (0-100) ────────────────

Compare against seller's ICP. Score overlap on:
  - Industry alignment (offering applicability)
  - Size alignment (within seller's size range)
  - Stage alignment (Series A/B/bootstrapped/enterprise as relevant)
  - Geography match

100 = Perfect match. 70-85 = Strong, minor mismatch on one. 40-60 = Mixed. <30 = Wrong fit.

──────────────── COMPONENT 3: buyer_signal_strength (0-100) ────────────────

Strength of GROUNDED signals suggesting this company has urgency or capacity to buy NOW.

100 = Multiple strong signals (hiring relevant roles, recent funding, explicit growth, specific tech mentions matching seller's offering) — all with citations.
70 = One strong signal with citation.
40 = Vague hints, no concrete signals.
10 = No signals.
0 = Anti-signals (stealth, liquidation).

CRITICAL — GROUNDED ONLY:
Every signal you report MUST include a citation field with the EXACT phrase from input that supports it. If you cannot cite an exact phrase, do NOT include the signal.

FORBIDDEN HALLUCINATION PATTERNS — NEVER produce them:
  ✗ "Website appears [...]" — you cannot see the website
  ✗ "May need modernization" / "Possibly needs scaling" — speculation
  ✗ "Small team managing X" — generic, applies to thousands
  ✗ "Limited tech team" — you don't know team composition
  ✗ Anything starting with "appears to", "may", "likely", "possibly", "could benefit from", "seems to", "potential need"

An EMPTY signals object is the correct, honest output for most companies. If signals are empty, buyer_signal_strength MUST be ≤30.

──────────────── COMPONENT 4: decision_maker_reachable (0-100 or null) ────────────────

Of the people scraped (LinkedIn-ranked, NOT seniority-ranked), can you identify someone who is BOTH (a) actually an employee AND (b) plausibly the buyer for what seller offers?

CRITICAL: LinkedIn's people list ranks by recent activity / mutual connections, NOT seniority. The first person is often NOT the right person.

RULE 1 — REJECT NON-EMPLOYEES. EXCLUDE anyone whose title proves they don't work at this company:
  - "CEO at <other company>" → board member or affiliate, NOT employee
  - "Founder at <other company>" → external connection
  - "Status is reachable" / city name only / blank title → no useful info
  - "Student at X" / "MBA at Y" / "Apprenticeship" → not a buyer
  - "Freelancer" / "Looking for opportunities" → not employee
  - Title is just emojis or unrelated buzzwords → skip

A person counts as an employee ONLY if their title clearly states a role AT THIS COMPANY ("at <company-name>", or role + company-name match).

RULE 2 — RANK SURVIVORS BY BUYER FIT.
  1-50 employees   → CEO, Founder, Co-founder, CTO usually decide
  51-500 employees → VP/Head/Director of relevant function; CTO or Head of Engineering for technical buys
  500+ employees   → Director / Senior Director / Head at team level (going to CEO is wrong)

RULE 3 — IF NO GOOD CANDIDATE: set key_person:null, key_person_problem:"no_decision_maker_in_scraped_list". Don't pick least-bad to fill the field.

When you DO pick a key person: include rationale that names SPECIFIC evidence in their title.

Score: 100 = clear decision-maker. 60-80 = plausible candidate, lower seniority. 20-40 = only tangentially relevant. 0 = no real employees.

IF people array is EMPTY/NULL → decision_maker_reachable.score: null, key_person: null, key_person_problem: "people_list_was_empty". The aggregate score will be redistributed and data_completeness marked "partial".

──────────────── OUTPUT RULES ────────────────

1. NEVER reject. Score everything.
2. Every component score has a one-sentence reasoning. No empties.
3. Signals grounded with citations or omitted.
4. fit_summary is ONE sentence the user sees at a glance: "Real fintech product company in Berlin with strong hiring signals — high-fit lead." or "Industry association — not a buyer despite name."
5. Return ONLY the JSON object.

──────────────── OUTPUT SCHEMA (strict) ────────────────

{
  "buyer_fit_score": <ignore — overwritten by service layer; emit 0>,
  "component_scores": {
    "is_real_business":         { "score": 0-100, "reasoning": "<one sentence>" },
    "icp_match":                { "score": 0-100, "reasoning": "<one sentence>" },
    "buyer_signal_strength":    { "score": 0-100, "reasoning": "<one sentence>" },
    "decision_maker_reachable": { "score": 0-100 | null, "reasoning": "<one sentence>" }
  },
  "key_person": null | {
    "name": "<from input>",
    "title": "<from input>",
    "linkedinUrl": "<from input>",
    "rationale": "<one sentence referencing specific words in their title>"
  },
  "key_person_problem": null | "no_decision_maker_in_scraped_list" | "all_candidates_external" | "people_list_was_empty",
  "signals": {
    "hiring_signals":   [{ "claim": "...", "citation": "..." }],
    "funding_signals":  [{ "claim": "...", "citation": "..." }],
    "growth_signals":   [{ "claim": "...", "citation": "..." }],
    "tech_signals":     [{ "claim": "...", "citation": "..." }],
    "pain_hypotheses":  [{ "stated_fact": "...", "inferred_pain": "...", "confidence": 0.0 }]
  },
  "fit_summary": "<one sentence the user reads at a glance>"
}

Return ONLY the JSON object.`;
}

export function buildFitScoreUserPrompt(seller: SellerProfile, company: ScrapedCompany): string {
  const exclusionsBlock = seller.exclusions.length
    ? seller.exclusions.map((e) => '  - ' + e).join('\n')
    : '  - (none)';

  const peopleBlock = company.people?.length
    ? company.people.map((p) => `  - ${p.name} — ${p.title || '(no title)'}`).join('\n')
    : '  (none)';

  const openPositionsBlock = company.openPositions?.length
    ? company.openPositions
        .map((j) => `  - ${j.title ?? '(untitled)'} @ ${j.location ?? '?'} — ${j.description ?? ''}`)
        .join('\n')
    : '  (none)';

  return `SELLER PROFILE
==============
What we sell: ${seller.offering}

Who we sell to (ICP):
  - Industries: ${seller.targetIndustries.join(', ') || '(any)'}
  - Size: ${seller.sizeMin}-${seller.sizeMax} employees
  - Geography: ${seller.geography}
  - Decision maker functions: ${seller.buyerFunctions.join(', ')}

Who we DO NOT sell to:
${exclusionsBlock}

═══════════════════════════════════════════════════════

COMPANY TO SCORE
=================
Name: ${company.name}
Domain: ${company.domain ?? 'unknown'}
Industry: ${company.industry ?? 'unknown'}
Size: ${company.size ?? 'unknown'}
Headquarters: ${company.headquarters ?? 'unknown'}
Founded: ${company.founded ?? 'unknown'}
LinkedIn URL: ${company.linkedinUrl ?? 'unknown'}
Description: ${company.description ?? '(none)'}
Specialties: ${company.specialties?.join(', ') ?? '(none)'}
LinkedIn rawMeta: ${company.rawMeta?.join(' | ') ?? '(none)'}

People scraped from /people page (LinkedIn-ranked, NOT seniority-ranked):
${peopleBlock}

Open positions detected:
${openPositionsBlock}

═══════════════════════════════════════════════════════

Produce the JSON fit-score now.`;
}
