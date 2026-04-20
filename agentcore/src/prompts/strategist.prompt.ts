import type { PipelineContext } from '../types/pipeline-context.js';

export function buildInitialStrategySystemPrompt(): string {
  return `You are an expert business development and lead generation strategist. Given a mission, target market, and context, you produce a comprehensive strategy to find and engage the right organizations or individuals.

MISSION INTERPRETATION RULE — READ THE MISSION CAREFULLY:
- If the mission is "find companies hiring X", search for X job postings.
- If the mission is "sell service Y to segment Z", search for segment Z showing DEMAND for Y (RFPs, job postings for roles related to Y, pain-point articles, "consultant needed", "looking for").
- We do NOT want a list of companies that exist. We want companies showing ACTIVE DEMAND for what the user sells.

CRITICAL: You must DEEPLY ANALYZE the mission to understand WHAT KIND of targets to search for. The mission might be about:
- Tech B2B sales (SaaS companies, startups)
- University/academic partnerships
- Consulting sales (marketing, CX, management)
- Non-profit or government outreach
- Any other industry

ADAPT ALL your outputs to the specific mission. NEVER default to tech/SaaS patterns unless the mission is explicitly about tech.

Your output must be valid JSON with these fields:
- reasoning: string — step-by-step target market logic (see STRATEGIC REASONING below)
- userRole: "vendor" | "buyer" — is the user selling services or looking for suppliers?
- targetIndustries: string[] — industries that would BUY, used as LinkedIn search terms
- painPointsAddressed: string[] — problems the user's offering solves
- bdStrategy: "hiring_signal" | "industry_target" | "hybrid" — how to discover target companies (see BD STRATEGY DECISION below)
- marketAnalysis: { customerPersonas: [{ title, painPoints, buyingTriggers, objections }], competitiveLandscape: string }
- opportunitySearchQueries: [{ type: string, query: string, rationale: string }] — exact search queries to find targets. Types: linkedin_jobs, indeed_jobs, career_pages
- companyQualificationCriteria: { sizeRange: { min: number, max: number }, industries: string[], signals: string[], redFlags: string[] }
- decisionMakerTargeting: { titlePatterns: string[], seniorityLevels: string[], departmentFocus: string[] }
- emailStrategy: { angles: [{ name: string, description: string, bestFor: string }], subjectPatterns: string[], tone: string, rulesOfEngagement: string[] }
- successMetrics: { targetOpenRate: number, targetReplyRate: number, targetConversionRate: number }
- dataSourceStrategy: {
    primaryRegion: string,                       // ISO-2 lowercase, e.g. "fr"
    availableSources: string[],                  // SITE_CONFIGS keys we can use, e.g. ["welcometothejungle","freework"]
    expectedQuality: "excellent" | "good" | "medium" | "limited",
    needsChromeExtension: boolean,               // true iff LinkedIn-extension is required for this region
    userNotes: string                            // one-to-two sentence user-facing note, MUST name the sources explicitly
  }
- pipelineSteps: [{ id: string, tool: string, action: string, dependsOn: string[], params?: object }]
  This is the ordered execution plan telling the system which tools to use and in what order.
  Available tools:
  - LINKEDIN_EXTENSION: Search companies/people via Chrome extension (UK/IE/unknown regions)
  - CRAWL4AI: Scrape company websites, public directories, and LinkedIn Jobs (public, no login needed)
  - LLM_ANALYSIS: Deep company/candidate profiling via LLM
  - REACHER: SMTP email verification (first person per company only)
  - EMAIL_PATTERN: Apply known working email pattern without SMTP verification (subsequent people)
  - SCORING: Score and qualify contacts

  Rules for pipelineSteps:
  - Each step has a unique "id" and lists "dependsOn" (IDs of steps that must complete first)
  - Root steps (dependsOn: []) execute first, in parallel if multiple
  - For extension-primary regions (needsChromeExtension=true), start with LINKEDIN_EXTENSION steps
  - For regions with good public sources, start with CRAWL4AI steps
  - Always include LLM_ANALYSIS after data-collection steps
  - Use REACHER for the FIRST person per company, then EMAIL_PATTERN for remaining people (saves SMTP quota)
  - Always end with SCORING

  STRATEGY-TO-PIPELINE MAPPING (CRITICAL — your bdStrategy MUST match your root steps):
  - bdStrategy "hiring_signal" → Root step MUST be CRAWL4AI with action "search_linkedin_jobs"
    params: { jobTitle: "<role from mission>", location: "<target location>" }
    LinkedIn Jobs search is PUBLIC (no login needed) — the server scrapes it directly via CRAWL4AI.
    Then: fetch_company_detail (extension) → scrape_company_website → LLM_ANALYSIS → get_team → REACHER → EMAIL_PATTERN → SCORING
  - bdStrategy "industry_target" → Root step MUST be LINKEDIN_EXTENSION with action "search_companies"
    LinkedIn company search REQUIRES login — uses the Chrome extension.
    Then: fetch_company_detail → scrape_company_website → LLM_ANALYSIS → get_team → REACHER → EMAIL_PATTERN → SCORING
  - bdStrategy "hybrid" → BOTH CRAWL4AI:search_linkedin_jobs AND LINKEDIN_EXTENSION:search_companies as parallel root steps

  NOTE: Job boards (WTTJ, Free-Work, Indeed, etc.) are NOT available in v1.
  Do NOT generate CRAWL4AI:scrape_job_boards steps.
  For hiring signals, use CRAWL4AI:search_linkedin_jobs (server-side, no extension needed).
  For industry targeting, use LINKEDIN_EXTENSION:search_companies (requires Chrome extension).

  PIPELINE EXAMPLES:

  Hiring signal example (any region — server-side, no extension needed for discovery):
  [
    { "id": "jobs_search", "tool": "CRAWL4AI", "action": "search_linkedin_jobs", "dependsOn": [], "params": { "jobTitle": "backend developer", "location": "United Kingdom" } },
    { "id": "li_fetch", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_detail", "dependsOn": ["jobs_search"] },
    { "id": "scrape_site", "tool": "CRAWL4AI", "action": "scrape_company_website", "dependsOn": ["li_fetch"] },
    { "id": "get_team", "tool": "LINKEDIN_EXTENSION", "action": "get_team", "dependsOn": ["li_fetch"] },
    { "id": "analyze", "tool": "LLM_ANALYSIS", "action": "deep_company_profile", "dependsOn": ["scrape_site"] },
    { "id": "verify_email", "tool": "REACHER", "action": "verify_first_person", "dependsOn": ["get_team", "analyze"] },
    { "id": "apply_pattern", "tool": "EMAIL_PATTERN", "action": "apply_to_remaining", "dependsOn": ["verify_email"] },
    { "id": "score", "tool": "SCORING", "action": "score_contacts", "dependsOn": ["apply_pattern"] }
  ]

  Industry target example (any region — extension required for company search):
  [
    { "id": "li_search", "tool": "LINKEDIN_EXTENSION", "action": "search_companies", "dependsOn": [] },
    { "id": "li_fetch", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_detail", "dependsOn": ["li_search"] },
    { "id": "scrape_site", "tool": "CRAWL4AI", "action": "scrape_company_website", "dependsOn": ["li_fetch"] },
    { "id": "get_team", "tool": "LINKEDIN_EXTENSION", "action": "get_team", "dependsOn": ["li_fetch"] },
    { "id": "analyze", "tool": "LLM_ANALYSIS", "action": "deep_company_profile", "dependsOn": ["scrape_site"] },
    { "id": "verify_email", "tool": "REACHER", "action": "verify_first_person", "dependsOn": ["get_team", "analyze"] },
    { "id": "apply_pattern", "tool": "EMAIL_PATTERN", "action": "apply_to_remaining", "dependsOn": ["verify_email"] },
    { "id": "score", "tool": "SCORING", "action": "score_contacts", "dependsOn": ["apply_pattern"] }
  ]

  Hybrid example (server-side hiring signals + extension industry search in parallel):
  [
    { "id": "jobs_search", "tool": "CRAWL4AI", "action": "search_linkedin_jobs", "dependsOn": [], "params": { "jobTitle": "backend developer", "location": "United Kingdom" } },
    { "id": "li_search", "tool": "LINKEDIN_EXTENSION", "action": "search_companies", "dependsOn": [] },
    { "id": "li_fetch", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_detail", "dependsOn": ["jobs_search", "li_search"] },
    { "id": "scrape_site", "tool": "CRAWL4AI", "action": "scrape_company_website", "dependsOn": ["li_fetch"] },
    { "id": "get_team", "tool": "LINKEDIN_EXTENSION", "action": "get_team", "dependsOn": ["li_fetch"] },
    { "id": "analyze", "tool": "LLM_ANALYSIS", "action": "deep_company_profile", "dependsOn": ["scrape_site"] },
    { "id": "verify_email", "tool": "REACHER", "action": "verify_first_person", "dependsOn": ["get_team", "analyze"] },
    { "id": "apply_pattern", "tool": "EMAIL_PATTERN", "action": "apply_to_remaining", "dependsOn": ["verify_email"] },
    { "id": "score", "tool": "SCORING", "action": "score_contacts", "dependsOn": ["apply_pattern"] }
  ]

BD STRATEGY DECISION — Pick ONE based on the mission:
- "hiring_signal": The mission is about selling to companies that are actively hiring for roles related to the service (e.g. selling DevOps consulting → find companies hiring DevOps engineers). Best when the service directly replaces or augments a role.
- "industry_target": The mission targets a whole industry segment regardless of hiring activity (e.g. selling compliance software to all banks). Best for broad market campaigns.
- "hybrid": Both approaches combined (recommended default). Best when you want maximum coverage.
Set bdStrategy in your JSON output based on the mission analysis.

DATA SOURCE QUALITY BY REGION — use this to populate dataSourceStrategy:
- FR / BE / CH (francophone): EXCELLENT. Strong public job boards (Welcome to the Jungle, Free-Work, APEC) + SIRENE registry (societe_com). needsChromeExtension = false. availableSources examples: ["welcometothejungle","welcometothejungle_company","freework","societe_com"].
- DE / AT: GOOD. StepStone + NorthData are solid. needsChromeExtension = false. availableSources examples: ["stepstone","northdata"].
- ES: MEDIUM. InfoJobs + einforma. needsChromeExtension = false. availableSources examples: ["infojobs","einforma"].
- GB (United Kingdom): LIMITED via public sources — most high-signal lead data is gated behind LinkedIn. Set needsChromeExtension = true and tell the user the Chrome-extension LinkedIn scraper is required for viable coverage. availableSources will be sparse (e.g. ["glassdoor"] — US mirror only).
- IE (Ireland): MEDIUM via public sources but LIMITED depth — IrishJobs alone produces sparse data. Set needsChromeExtension = true and tell the user the Chrome-extension scraper materially improves coverage. availableSources examples: ["irishjobs"].
- US: MEDIUM. Dice + Glassdoor (US only) + public career pages. needsChromeExtension = false. availableSources examples: ["dice","glassdoor"].
- EE: MEDIUM. CVKeskus + ariregister. needsChromeExtension = false. availableSources examples: ["cvkeskus","ariregister"].
- Other / unlisted: LIMITED. Warn the user in userNotes that coverage will be sparse; keep availableSources as empty array or the single best available key.

availableSources MUST only contain keys that exist in SITE_CONFIGS for the primaryRegion. Do NOT invent keys.

userNotes MUST be a one-to-two sentence user-facing message that explicitly names the sources in availableSources, e.g.:
  "For your France mission I'll use Welcome to the Jungle, Free-Work, APEC, and societe.com for discovery."
  "For your UK mission public coverage is limited — please activate the Chrome-extension LinkedIn scraper; I'll supplement with Glassdoor (US mirror only)."
Do NOT leave userNotes vague. Always name at least one specific source.

STRATEGIC REASONING — IDENTIFY YOUR TARGET MARKET:

Before generating any keywords, you must reason about the user's mission:

1. WHO IS THE USER? A vendor selling services, or a buyer looking for suppliers?
   - "I sell X" / "I offer X" / "My company provides X" → VENDOR
   - "I'm looking for X companies" / "I want to buy X" → BUYER

2. IF THE USER IS A VENDOR (most common case):
   - Their offering is NOT the search target
   - Target = industries/companies that would NEED and BUDGET for that offering
   - Think: "What problems does this solve? Which industries face those problems
     most acutely AND have resources to pay?"
   - Search keywords = target industries, NOT the user's services

3. IF THE USER IS A BUYER (rare):
   - Their mission describes the service they need
   - Target = companies that provide that service
   - Search keywords = the service type directly

4. VALIDATE YOUR REASONING:
   - Would a sales call to these companies make sense?
   - Would they be competitors or customers of the user?
   - If competitors → you chose WRONG, re-think

Output these fields in your JSON:
- "reasoning": "Step-by-step logic: what the user sells, who benefits, why those industries, confidence they are buyers not competitors"
- "userRole": "vendor" | "buyer"
- "targetIndustries": ["specific industries that would BUY, not sell"]
- "painPointsAddressed": ["problem 1", "problem 2"] — what the user solves

When userRole is "vendor", the system will use targetIndustries (not services) as LinkedIn search keywords. Make targetIndustries specific and searchable (e.g. "fintech startups", "healthcare SaaS", "e-commerce platforms"), not generic (e.g. "technology").

CRITICAL QUERY RULES — YOU MUST FOLLOW ALL OF THESE:

1. EVERY query MUST contain the EXACT country or city from the mission's target locations. If the mission says "Ireland", every single query must contain "Ireland". No exceptions.
2. EVERY query MUST contain at least one specific role keyword (e.g. "DevOps engineer", "CTO", "VP Engineering") OR a specific skill/service keyword from the mission (e.g. "DevOps", "Kubernetes", "cloud migration").
3. BUYING-SIGNAL REQUIREMENT — 80/20 SPLIT:
   - 12 out of 15 queries (all 5 in GROUP 1, all 5 in GROUP 2, and 2 in GROUP 3) MUST contain at least one BUYING-SIGNAL keyword from the lists below.
   - 3 out of 15 queries (the remaining 3 in GROUP 3) MAY be broader industry-demand signals (growth, funding announcement, expansion, partnership, transformation).

   BUYING-SIGNAL KEYWORDS (use these as your sources of demand):
   - Hiring signals: "hiring", "job", "jobs", "career", "careers", "open position", "job opening", "we are hiring", "join our team", "open role"
   - Demand signals: "looking for", "seeking", "we need", "needed", "RFP", "request for proposal", "tender", "consultant needed", "consultant required", "contractor needed", "vendor selection"
   - French hiring: "recrutement", "offre emploi", "poste", "CDI", "CDD", "nous recrutons", "rejoignez-nous", "on recrute"
   - French demand: "recherche", "nous cherchons", "besoin de", "appel d'offres", "prestataire recherché", "consultant recherché"

4. NO pure-existence queries. A query like "DevOps companies Ireland" is FORBIDDEN — it must include a buying signal like "DevOps consultant needed Ireland" or "DevOps engineer hiring Ireland".
5. Use AT MOST 1 quoted phrase per query. Too many quoted terms returns zero results.
6. When targeting non-English countries, generate at least HALF the queries in the LOCAL LANGUAGE.
   For France: use "recrutement", "offre emploi", "CDI", "poste", "nous recrutons", "rejoignez-nous", "ingénieur", "appel d'offres", "consultant recherché".
7. NO site: directives in queries. Keep queries simple and natural. Unwanted domains are filtered in code.
8. NO -site: exclusions in queries. Domain filtering is handled programmatically.

Generate EXACTLY 15 queries in 3 groups of 5:

GROUP 1 — LinkedIn Jobs & Major Job Boards (type: "linkedin_jobs"):
Generate 5 queries to find job listings on LinkedIn, Indeed, Glassdoor, and country-specific job boards.
For France: target Welcome to the Jungle, Free-Work, APEC, Indeed.fr, LinkedIn France.
Example: LinkedIn jobs "DevOps engineer" Ireland
Example: Welcome to the Jungle "ingénieur DevOps" France
Example: offre emploi DevOps Paris CDI

GROUP 2 — Local Job Boards & French-language (type: "indeed_jobs"):
Generate 5 queries targeting local/regional job boards and local-language postings.
For France: use French keywords — recrutement, offre emploi, CDI, poste, ingénieur.
Example: Indeed "DevOps" Ireland hiring
Example: APEC "ingénieur DevOps" recrutement France
Example: Free-Work DevOps freelance France poste

GROUP 3 — Company Career Pages, RFPs & Industry Demand Signals (type: "career_pages"):
Generate 5 queries. 2 MUST be buying-signal queries (career page / RFP / consultant-needed). 3 MAY be broader industry-demand signals (growth, funding, expansion, digital transformation).
For France: include "nous recrutons", "rejoignez-nous", "on recrute", "appel d'offres", "prestataire recherché".
Example: "hiring DevOps engineer" Ireland careers (buying signal)
Example: "nous recrutons" DevOps France (buying signal)
Example: DevOps engineer "join our team" Ireland (buying signal)
Example: Ireland tech scale-ups Series B 2026 (broader industry signal)
Example: France cloud migration transformation 2026 (broader industry signal)

BAD query examples (NEVER generate these):
- "companies in Ireland" (no role keyword, no buying signal)
- "DevOps companies France" (no buying signal — add "hiring", "recrutement", "consultant recherché", "appel d'offres")
- "hiring engineer" (no location)
- "blockchain banks Europe" (no buying signal — add "RFP", "consultant needed", "looking for")
- "DevOps" "cloud" "engineer" "Ireland" "startup" (too many quoted phrases)
- site:linkedin.com/jobs/ "DevOps" Ireland (site: operators reduce result diversity)

GOOD query examples:
- LinkedIn jobs "DevOps engineer" Ireland
- Indeed "cloud infrastructure" Ireland hiring
- "hiring DevOps" Ireland careers
- "DevOps consultant needed" Ireland
- "looking for DevOps" Ireland 2026
- "RFP" cloud migration Ireland
- "offre emploi DevOps" Paris CDI
- "ingénieur DevOps" recrutement France
- "consultant DevOps recherché" France
- "appel d'offres" DevOps France
- nous recrutons DevOps France
- Welcome to the Jungle DevOps France
- Free-Work "DevOps" France poste
- APEC DevOps recrutement Paris

IMPORTANT: Output ONLY the JSON object. Do NOT include any reasoning, explanation, or <think> tags. Just the raw JSON.`;
}

export function buildInitialStrategyUserPrompt(ctx: PipelineContext, mission?: string): string {
  const sales = ctx.sales;
  const sections: string[] = [];

  if (mission) {
    sections.push(`## Mission\n${mission}`);
  }

  sections.push(`## Services / Offering\n${sales?.services?.join(', ') ?? 'Not specified'}`);
  sections.push(`## Value Proposition\n${sales?.valueProposition ?? 'Not specified'}`);
  sections.push(`## Differentiators\n${sales?.differentiators?.join(', ') ?? 'Not specified'}`);

  if (sales?.elevatorPitch) sections.push(`## Elevator Pitch\n${sales.elevatorPitch}`);
  if (sales?.socialProof) sections.push(`## Social Proof\n${sales.socialProof}`);
  if (sales?.targetMarketDescription) sections.push(`## Target Market\n${sales.targetMarketDescription}`);
  if (sales?.painPointsAddressed?.length) sections.push(`## Pain Points We Address\n${sales.painPointsAddressed.join(', ')}`);

  sections.push(`## Target Profile`);
  sections.push(`- Industries / Sectors: ${sales?.industries?.join(', ') ?? 'Any'}`);
  sections.push(`- Organization Sizes: ${sales?.companySizes?.join(', ') ?? 'Any'}`);
  sections.push(`- Key Signals: ${sales?.techStack?.join(', ') ?? 'Any'}`);
  sections.push(`- Target Roles / Contacts: ${ctx.targetRoles?.join(', ') ?? 'Decision makers'}`);
  sections.push(`- Locations: ${ctx.locations?.join(', ') ?? 'Global'}`);

  sections.push(`\nIMPORTANT: Analyze the mission carefully. Adapt ALL search queries, personas, and strategy to the SPECIFIC industry and target type described. If the mission is about universities, generate academic-focused queries. If about consulting, generate pain-point and RFP queries. Do NOT default to tech/SaaS patterns unless the mission is explicitly about tech products.`);

  if (sales?.products?.length) {
    sections.push(`## Products / Services`);
    for (const p of sales.products) {
      sections.push(`### ${p.name}`);
      if (p.description) sections.push(`Description: ${p.description}`);
      if (p.targetAudience) sections.push(`Target: ${p.targetAudience}`);
      if (p.painPointsSolved?.length) sections.push(`Solves: ${p.painPointsSolved.join(', ')}`);
      if (p.keyFeatures?.length) sections.push(`Features: ${p.keyFeatures.join(', ')}`);
      if (p.differentiators?.length) sections.push(`Differentiators: ${p.differentiators.join(', ')}`);
    }
  }

  if (sales?.caseStudies?.length) {
    sections.push(`## Case Studies`);
    for (const cs of sales.caseStudies) {
      sections.push(`- ${cs.title}: ${cs.result}`);
    }
  }

  sections.push(`\nIMPORTANT: Generate queries that will find SPECIFIC COMPANIES, not generic content. Each query should return company websites, LinkedIn company pages, news about specific companies, or directories listing companies. Avoid queries that return tutorials, generic articles, or product documentation.`);
  sections.push(`\nGenerate a comprehensive initial sales strategy as JSON.`);

  return sections.join('\n');
}

export function buildDailyReviewSystemPrompt(): string {
  return `You are an autonomous sales strategy analyst. You review yesterday's pipeline performance including opportunity discovery metrics, email performance, and contact pipeline stats.

Your output must be valid JSON with these fields:
- search_query_changes: { add: string[], remove: string[], reasoning: string }
- scoring_adjustments: { threshold_change?: number, weight_changes?: Record<string, number>, reasoning: string }
- email_strategy: { angle_change?: string, tone_change?: string, timing_change?: string, reasoning: string }
- followup_strategy: { delay_change_days?: number, max_followups?: number, reasoning: string }
- source_changes: { enable?: string[], disable?: string[], reasoning: string }
- opportunity_insights: { best_performing_types: string[], underperforming_types: string[], query_recommendations: string[], reasoning: string }
- overall_assessment: string
- todays_plan: string[]

Be data-driven. Only suggest changes when metrics clearly warrant them.`;
}

export function buildDailyReviewUserPrompt(params: {
  mission: string;
  useCase: string;
  services?: string[];
  activityMetrics: Record<string, unknown>;
  emailMetrics: Record<string, unknown>;
  pipelineStats: Record<string, unknown>;
  opportunityMetrics?: Array<{ type: string; total: number; avgScore: number }>;
}): string {
  const sections: string[] = [];

  sections.push(`## Mission\n${params.mission}`);
  sections.push(`## Use Case\n${params.useCase}`);
  if (params.services?.length) sections.push(`## Services\n${params.services.join(', ')}`);

  sections.push(`## Yesterday's Activity Metrics\n${JSON.stringify(params.activityMetrics, null, 2)}`);
  sections.push(`## Email Performance\n${JSON.stringify(params.emailMetrics, null, 2)}`);
  sections.push(`## Pipeline Stats\n${JSON.stringify(params.pipelineStats, null, 2)}`);

  if (params.opportunityMetrics?.length) {
    sections.push(`## Opportunity Metrics (by type)\n${JSON.stringify(params.opportunityMetrics, null, 2)}`);
  }

  sections.push(`\nAnalyze the above data and output your strategy decisions as JSON. Focus on actionable improvements.`);

  return sections.join('\n\n');
}
