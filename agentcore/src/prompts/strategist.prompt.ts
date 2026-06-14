import type { PipelineContext, BdStrategy } from '../types/pipeline-context.js';

export function buildInitialStrategySystemPrompt(forcedBdStrategy?: BdStrategy): string {
  const lock = forcedBdStrategy
    ? `\n\nUSER-LOCKED STRATEGY: ${forcedBdStrategy}\n` +
      `The user explicitly chose this strategy in chat. You MUST set bdStrategy="${forcedBdStrategy}" in your output. Do not change it under any circumstance.\n` +
      (forcedBdStrategy === 'industry_target'
        ? `- Populate targetIndustries with 3-8 entries — industries whose companies typically employ the user's placement target / buy the user's offering.\n` +
          `- Leave hiringKeywords as an empty array [] (the master-agent will not run LinkedIn Jobs scrape for industry_target).\n` +
          `- dataSourceStrategy.needsChromeExtension MUST be true (industry company search runs through the Chrome extension).`
        : forcedBdStrategy === 'hiring_signal'
        ? `- Populate hiringKeywords with 3-8 entries — job titles companies POST when they need the user's placement target. These are the LinkedIn Jobs search terms.\n` +
          `- Leave targetIndustries as an empty array [] (the master-agent will not run extension company search for hiring_signal).`
        : forcedBdStrategy === 'local_business'
        ? `- Discovery is GOOGLE MAPS ONLY. Emit 3-6 GMAPS_EXTENSION steps with action "search_businesses", dependsOn: []. Each step params: { query: "<niche keywords ONLY — never a city/country name>", location: "<city or region>", limit: 20, queryRationale: "<one sentence>" }. Mix broad niches ("restaurant") with narrow ones ("asian restaurant", "sushi restaurant").\n` +
          `- Do NOT emit LINKEDIN_EXTENSION:search_companies, CRAWL4AI jobs steps, fetch_company_team, or teamRoleKeywords — local businesses have no LinkedIn people pages. Leave hiringKeywords [].\n` +
          `- dataSourceStrategy.needsChromeExtension MUST be true (Google Maps scraping runs through the Chrome extension).`
        : forcedBdStrategy === 'local_hybrid'
        ? `- Discovery combines GOOGLE MAPS and LINKEDIN. Emit ≥2 GMAPS_EXTENSION:search_businesses steps (params { query, location, limit, queryRationale } — query is the niche ONLY, location is the city/region) AND ≥3 LINKEDIN_EXTENSION:search_companies steps as parallel roots.\n` +
          `- Keep the LinkedIn enrichment chain (fetch_company_info, fetch_company_team, teamRoleKeywords) for the LinkedIn half only — Maps businesses are enriched automatically.\n` +
          `- Populate targetIndustries (3-8) for the LinkedIn half. Leave hiringKeywords [].\n` +
          `- dataSourceStrategy.needsChromeExtension MUST be true.`
        : `- Populate BOTH targetIndustries (3-8) AND hiringKeywords (3-8) for the hybrid path.\n` +
          `- dataSourceStrategy.needsChromeExtension MUST be true.`) +
      (forcedBdStrategy === 'local_business'
        ? `\n`
        : `\n- Populate teamRoleKeywords with 3-6 SHORT decision-maker titles (e.g. ["CEO","CTO","Founder","COO","HR","Director"]). Prefer 1-word keywords — they return the most results on LinkedIn. These drive the per-company \`/people/?keywords=<kw>\` team scrape. Required whenever pipelineSteps includes fetch_company_team.` +
          `\n`)
    : '';

  return `You are an expert business development and lead generation strategist. Given a mission, target market, and context, you produce a comprehensive strategy to find and engage the right organizations or individuals.${lock}

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
- hiringKeywords: string[] — THE JOB ROLES TARGET COMPANIES ARE POSTING (what to search LinkedIn Jobs for). Technical roles companies hire for — NOT decision-maker titles you email. Example: ["blockchain developer", "web3 engineer", "Hedera developer"] for a company selling Hedera consulting. See CRITICAL DISTINCTION below.
- teamRoleKeywords: string[] — SHORT decision-maker titles used to drive the LinkedIn team-scrape step (\`fetch_company_team\` hits \`linkedin.com/company/<slug>/people/?keywords=<kw>\` once per keyword). 3-6 entries. PREFER 1-WORD KEYWORDS (e.g. "CEO", "CTO", "Founder", "HR", "COO", "Director") — these return the most results on LinkedIn's people filter. Multi-word titles like "Head of Digital Transformation" or "Chief Innovation Officer" return zero results on most company pages. Keep it simple. REQUIRED whenever \`pipelineSteps\` includes LINKEDIN_EXTENSION:fetch_company_team — without it, the team scrape is skipped entirely. Examples: B2B SaaS → ["CEO","CTO","Founder","COO","Director"]; Recruiting → ["HR","Founder","CEO","Director"]; Hedera consulting → ["CTO","Founder","CEO","Director"].
- targetTech: string[] — technology keywords (languages, frameworks, blockchains) appearing in job posts of qualified companies. Used as secondary filters. Example: ["Hedera", "HBAR", "Solidity", "distributed ledger"]
- bdStrategy: "hiring_signal" | "industry_target" | "hybrid" | "local_business" | "local_hybrid" — how to discover target companies (see BD STRATEGY DECISION below)
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
  - GMAPS_EXTENSION: Search local/consumer-facing businesses on Google Maps via Chrome extension (restaurants, salons, shops, clinics — geography is CITY-level)
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
    params: { jobTitles: <values from your hiringKeywords field>, location: "<target location>" }
    (jobTitles is an ARRAY — the master-agent iterates every combination of location × jobTitle. The master-agent caps at 5 titles, so put your best 3-5 first.)
    LinkedIn Jobs search is PUBLIC (no login needed) — the server scrapes it directly via CRAWL4AI.
    Then: fetch_company_info (extension) → scrape_company_website → LLM_ANALYSIS → fetch_company_team → REACHER → EMAIL_PATTERN → SCORING
  - bdStrategy "industry_target" → Root step MUST be LINKEDIN_EXTENSION with action "search_companies"
    LinkedIn company search REQUIRES login — uses the Chrome extension.
    Then: fetch_company_info → scrape_company_website → LLM_ANALYSIS → fetch_company_team → REACHER → EMAIL_PATTERN → SCORING
  - bdStrategy "hybrid" → BOTH CRAWL4AI:search_linkedin_jobs AND LINKEDIN_EXTENSION:search_companies as parallel root steps
  - bdStrategy "local_business" → Root steps MUST be 3-6 GMAPS_EXTENSION steps with action "search_businesses"
    params: { query: "<niche keywords ONLY, no city/country>", location: "<city or region>", limit: 20, queryRationale: "<one sentence>" }
    Google Maps search is capped at ~20 searches/day — emit 3-6 search steps with DIFFERENT niche angles, never 20.
    Mix broad and narrow niches. Worked example — mission "asian food restaurants in Riyadh":
      { "id": "g1", "tool": "GMAPS_EXTENSION", "action": "search_businesses", "dependsOn": [], "params": { "query": "restaurant", "location": "Riyadh", "limit": 20, "queryRationale": "Broad net across all dining venues in the city." } }
      { "id": "g2", "tool": "GMAPS_EXTENSION", "action": "search_businesses", "dependsOn": [], "params": { "query": "asian restaurant", "location": "Riyadh", "limit": 20, "queryRationale": "Mid-specificity — the core target niche." } }
      { "id": "g3", "tool": "GMAPS_EXTENSION", "action": "search_businesses", "dependsOn": [], "params": { "query": "sushi restaurant", "location": "Riyadh", "limit": 20, "queryRationale": "Narrow high-intent slice of the asian-food segment." } }
    NO teamRoleKeywords and NO fetch_company_team for local_business — Google Maps has no people pages. Business details (phone, website) and email enrichment are fanned out automatically after each search.
  - bdStrategy "local_hybrid" → BOTH ≥2 GMAPS_EXTENSION:search_businesses steps AND ≥3 LINKEDIN_EXTENSION:search_companies steps as parallel roots. Keep the LinkedIn enrichment chain (fetch_company_info / fetch_company_team / teamRoleKeywords) for the LinkedIn half.

  NOTE: Job boards (WTTJ, Free-Work, Indeed, etc.) are NOT available in v1.
  Do NOT generate CRAWL4AI:scrape_job_boards steps.
  For hiring signals, use CRAWL4AI:search_linkedin_jobs (server-side, no extension needed).
  For industry targeting, use LINKEDIN_EXTENSION:search_companies (requires Chrome extension).

  PIPELINE EXAMPLES:

  Hiring signal example (any region — server-side, no extension needed for discovery):
  [
    { "id": "jobs_search", "tool": "CRAWL4AI", "action": "search_linkedin_jobs", "dependsOn": [], "params": { "jobTitles": ["blockchain developer", "web3 engineer", "Hedera developer"], "location": "United Kingdom" } },
    { "id": "li_fetch", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_info", "dependsOn": ["jobs_search"] },
    { "id": "scrape_site", "tool": "CRAWL4AI", "action": "scrape_company_website", "dependsOn": ["li_fetch"] },
    { "id": "get_team", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_team", "dependsOn": ["li_fetch"] },
    { "id": "analyze", "tool": "LLM_ANALYSIS", "action": "deep_company_profile", "dependsOn": ["scrape_site"] },
    { "id": "verify_email", "tool": "REACHER", "action": "verify_first_person", "dependsOn": ["get_team", "analyze"] },
    { "id": "apply_pattern", "tool": "EMAIL_PATTERN", "action": "apply_to_remaining", "dependsOn": ["verify_email"] },
    { "id": "score", "tool": "SCORING", "action": "score_contacts", "dependsOn": ["apply_pattern"] }
  ]

  Industry target example (any region — extension required for company search):
  [
    { "id": "li_search", "tool": "LINKEDIN_EXTENSION", "action": "search_companies", "dependsOn": [] },
    { "id": "li_fetch", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_info", "dependsOn": ["li_search"] },
    { "id": "scrape_site", "tool": "CRAWL4AI", "action": "scrape_company_website", "dependsOn": ["li_fetch"] },
    { "id": "get_team", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_team", "dependsOn": ["li_fetch"] },
    { "id": "analyze", "tool": "LLM_ANALYSIS", "action": "deep_company_profile", "dependsOn": ["scrape_site"] },
    { "id": "verify_email", "tool": "REACHER", "action": "verify_first_person", "dependsOn": ["get_team", "analyze"] },
    { "id": "apply_pattern", "tool": "EMAIL_PATTERN", "action": "apply_to_remaining", "dependsOn": ["verify_email"] },
    { "id": "score", "tool": "SCORING", "action": "score_contacts", "dependsOn": ["apply_pattern"] }
  ]

  Hybrid example (server-side hiring signals + extension industry search in parallel):
  [
    { "id": "jobs_search", "tool": "CRAWL4AI", "action": "search_linkedin_jobs", "dependsOn": [], "params": { "jobTitles": ["blockchain developer", "web3 engineer", "Hedera developer"], "location": "United Kingdom" } },
    { "id": "li_search", "tool": "LINKEDIN_EXTENSION", "action": "search_companies", "dependsOn": [] },
    { "id": "li_fetch", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_info", "dependsOn": ["jobs_search", "li_search"] },
    { "id": "scrape_site", "tool": "CRAWL4AI", "action": "scrape_company_website", "dependsOn": ["li_fetch"] },
    { "id": "get_team", "tool": "LINKEDIN_EXTENSION", "action": "fetch_company_team", "dependsOn": ["li_fetch"] },
    { "id": "analyze", "tool": "LLM_ANALYSIS", "action": "deep_company_profile", "dependsOn": ["scrape_site"] },
    { "id": "verify_email", "tool": "REACHER", "action": "verify_first_person", "dependsOn": ["get_team", "analyze"] },
    { "id": "apply_pattern", "tool": "EMAIL_PATTERN", "action": "apply_to_remaining", "dependsOn": ["verify_email"] },
    { "id": "score", "tool": "SCORING", "action": "score_contacts", "dependsOn": ["apply_pattern"] }
  ]

CRITICAL DISTINCTION — THREE DIFFERENT ROLE FIELDS:

You MUST populate three SEPARATE role fields — they serve opposite purposes and conflating them is the #1 cause of wrong searches:

**\`targetRoles\` (lives on the mission / pipeline context) — WHO WE EMAIL (outreach decision-makers).**
- The people who make the BUYING decision at the target company.
- Example (Hedera consulting mission): ["CTO", "VP Engineering", "Head of Blockchain", "Chief Technology Officer"]
- These feed LinkedIn People/Recruiter search and get-team enrichment.

**\`hiringKeywords\` (field on YOUR strategy output) — WHAT THE TARGET COMPANIES ARE HIRING FOR (the job roles we search for on LinkedIn Jobs).**
- Technical/operational roles whose presence SIGNALS the company needs our service.
- Example (Hedera consulting mission): ["blockchain developer", "web3 engineer", "Hedera developer", "Solidity engineer", "DLT developer"]
- These feed the LinkedIn Jobs URL: \`?keywords=<hiringKeyword>&location=<loc>\`.

**\`teamRoleKeywords\` (field on YOUR strategy output) — SHORT decision-maker titles we scrape from each target company's people page (\`linkedin.com/company/<slug>/people/?keywords=<kw>\`).**
- 3-6 entries. STRONGLY PREFER 1-WORD KEYWORDS: "CEO", "CTO", "COO", "Founder", "HR", "Director". These match the most profiles on LinkedIn's people filter. Multi-word titles like "Head of Digital Transformation" or "Chief Innovation Officer" return ZERO results on most company pages — avoid them.
- Example (any B2B mission): ["CEO", "CTO", "Founder", "COO", "Director"]
- Example (Recruiting / staffing): ["HR", "Founder", "CEO", "Director"]
- REQUIRED whenever \`pipelineSteps\` includes LINKEDIN_EXTENSION:fetch_company_team. If empty, the team scrape is skipped entirely.

NEVER put decision-maker titles (CTO, VP, Head of X) in \`hiringKeywords\`. NEVER put technical-IC roles (developer, engineer) in \`targetRoles\` or \`teamRoleKeywords\`. They are orthogonal.

Rule of thumb: \`hiringKeywords\` are what you'd type into LinkedIn Jobs search; \`teamRoleKeywords\` are what you'd type into the people-page filter of a specific company.

Walkthrough — mission *"I sell Hedera consulting to fintechs in the UK"*:
- \`hiringKeywords\`: ["Hedera developer", "blockchain developer", "web3 engineer", "Solidity engineer", "DLT developer"]
- \`teamRoleKeywords\`: ["CTO", "Founder", "CEO", "Director"]
- \`targetRoles\` (in context, not your output): ["CTO", "VP Engineering", "Head of Blockchain"]
- Logic: We search LinkedIn Jobs for *companies hiring blockchain devs* (the signal), then hit each company's people page filtered by *teamRoleKeywords* (short, 1-word terms) to surface the right humans, then email the *CTO* at each (the decision maker).

BD STRATEGY DECISION — Pick ONE based on the mission text ALONE:

CRITICAL — strategy is decided from the MISSION, not from regional data quality.
\`needsChromeExtension\` is a separate decision based on \`primaryRegion\`. Do NOT
pick \`hiring_signal\` because the region has limited public sources — pick the
strategy from what the mission says, then set \`needsChromeExtension\` from the region.

Decision rules (apply in order, first match wins):

0. If the mission targets LOCAL/CONSUMER-FACING PLACES (restaurants, cafés, salons,
   shops, clinics, gyms, hotels, "local businesses") in a city or area →
   bdStrategy = "local_business" (Google Maps discovery). If it ALSO targets B2B
   companies/industries (e.g. "companies and bigger local businesses") →
   bdStrategy = "local_hybrid" (Maps + LinkedIn company search).

1. If the mission mentions hiring/recruiting/jobs/roles/team-growth verbs (e.g.
   "actively hiring", "growing their team", "open roles", "hiring DevOps engineers")
   AND ALSO names an industry/vertical/ICP → bdStrategy = "hybrid".

2. If the mission mentions hiring/recruiting/jobs/roles/team-growth verbs but NO
   specific industry/vertical → bdStrategy = "hiring_signal".

3. If the mission names industries/verticals/ICPs (e.g. "SaaS firms", "fintech
   companies", "mid-market e-commerce", "compliance software for banks") and contains
   NO hiring verbs → bdStrategy = "industry_target". You MUST pick industry_target
   here even if regional coverage is limited; the user wants industry-wide outreach,
   not a hiring-signal proxy.

4. If neither hiring verbs nor industry markers are clearly present → bdStrategy =
   "hybrid" as a safe default for maximum coverage.

Worked examples:

- Mission: "Identify English-speaking mid-market SaaS, FinTech, HealthTech, and
  e-commerce firms in Gulf countries..." → industry_target (industries named, no
  hiring verbs). NEVER hiring_signal.
- Mission: "Find European companies actively hiring senior DevOps engineers" →
  hiring_signal (hiring verb, no industry).
- Mission: "EU fintechs that are hiring blockchain developers" → hybrid (both).
- Mission: "Find asian food restaurants in Riyadh" → local_business (consumer-facing
  places in a city — Google Maps, NOT LinkedIn).
- Mission: "Target hotel chains and local restaurants in Dubai" → local_hybrid
  (local places + B2B companies).

DATA SOURCE QUALITY BY REGION — use this to populate dataSourceStrategy:
- FR / BE / CH (francophone): EXCELLENT. Strong public job boards (Welcome to the Jungle, Free-Work, APEC) + SIRENE registry (societe_com). needsChromeExtension = false. availableSources examples: ["welcometothejungle","welcometothejungle_company","freework","societe_com"].
- DE / AT: GOOD. StepStone + NorthData are solid. needsChromeExtension = false. availableSources examples: ["stepstone","northdata"].
- ES: MEDIUM. InfoJobs + einforma. needsChromeExtension = false. availableSources examples: ["infojobs","einforma"].
- GB (United Kingdom): LIMITED via public sources — most high-signal lead data is gated behind LinkedIn. Set needsChromeExtension = true and tell the user the Chrome-extension LinkedIn scraper is required for viable coverage. availableSources will be sparse (e.g. ["glassdoor"] — US mirror only).
- IE (Ireland): MEDIUM via public sources but LIMITED depth — IrishJobs alone produces sparse data. Set needsChromeExtension = true and tell the user the Chrome-extension scraper materially improves coverage. availableSources examples: ["irishjobs"].
- US: MEDIUM. Dice + Glassdoor (US only) + public career pages. needsChromeExtension = false. availableSources examples: ["dice","glassdoor"].
- EE: MEDIUM. CVKeskus + ariregister. needsChromeExtension = false. availableSources examples: ["cvkeskus","ariregister"].
- Other / unlisted: LIMITED. Warn the user in userNotes that coverage will be sparse; keep availableSources as empty array or the single best available key.
- LOCAL/PLACES segments (local_business / local_hybrid): Google Maps via the Chrome extension works in EVERY region — regional job-board quality is irrelevant for the Maps half. Set needsChromeExtension = true and name "Google Maps" in userNotes.

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

══════════════════════════════════════════════════════════════
SECTION A — APPLY INDUSTRY KNOWLEDGE TO TURN BROAD INPUT INTO PRECISE QUERIES
══════════════════════════════════════════════════════════════

The user gives you broad domain terms in natural language: "fintech", "AI", "healthtech", "B2B SaaS", "ecommerce". These describe a market, not yet a precise query.

Your value as the strategist is industry knowledge. You know what these broad terms ACTUALLY contain. The pipeline you emit MIXES two kinds of search:

  • A few BROAD-QUANTITY steps that USE the user's broad term as-is (1 keyword each). High yield, low precision — the downstream fit scorer catches the noise. These exist to surface companies whose self-descriptions don't use the exact sub-category vocabulary.

  • Several NARROW-QUALITY steps that translate the broad input into specific sub-categories companies use to describe themselves on their LinkedIn profiles (2-4 keywords each). Lower yield, higher precision.

The user does not see this design. You do not ask them to confirm. You apply your knowledge, pick the broad terms + the sub-categories that best match the seller's offering, and emit the mix. That IS the skill.

──────────────────────────────────────────────
INDUSTRY EXPANSION REFERENCE
──────────────────────────────────────────────

When the user says "fintech," you internally know it contains:
  payment infrastructure / payment processing, neobank / digital bank, embedded finance, open banking, lending platform, B2B payments, treasury management, payroll fintech, accounting automation, wealth management platform, regtech, cryptocurrency platform / crypto exchange, insurtech (when relevant)

When the user says "AI":
  AI agents / agentic AI / agent platform / autonomous agents / agent framework, LLM application / LLM tooling / RAG platform, generative AI tool / copilot, foundation model company, AI infrastructure / GPU platform, vertical AI SaaS (legal AI, sales AI, marketing AI, healthcare AI, etc.), MLOps / ML platform / model deployment, computer vision, NLP platform

  Note: in 2026 the fast-growing AI buyer pool is companies BUILDING agents and LLM applications. Default to picking "AI agents", "agent platform", "LLM application", "RAG platform" sub-categories when the seller ships into developer / engineering teams. Only fall back to "MLOps" / "computer vision" / "NLP" when the seller explicitly targets legacy ML-infrastructure teams.

When the user says "healthtech":
  telemedicine platform, electronic health records, clinical trial software, digital therapeutics, medical device SaaS, healthcare analytics, patient engagement platform, hospital management software, mental health platform, femtech / women's health

When the user says "B2B SaaS":
  Too broad even as starting point. Narrow by FUNCTION:
  HR tech (ATS, payroll, performance), sales tech (CRM, sales enablement, prospecting), dev tools (CI/CD, observability, security), marketing tech (CDP, attribution, content), finance tech (FP&A, accounting, treasury), support tech (ticketing, knowledge base, customer success)

When the user says "ecommerce":
  DTC brand, marketplace platform, shipping & logistics SaaS, returns management, customer engagement (loyalty, reviews), merchant payment platform, inventory management

These lists are not exhaustive. Use your knowledge of how each industry is actually segmented in 2026. If the user names a domain you don't have detailed knowledge of, fall back to 2-3 broad-but-specific product nouns rather than guessing.

──────────────────────────────────────────────
SELECTION — PICK BROAD UMBRELLAS + 2-3 SUB-CATEGORIES THAT FIT THE SELLER
──────────────────────────────────────────────

Pick the broad umbrella terms (1-2) AND the sub-categories (2-3) that best fit the seller's offering. The broad terms become the broad-quantity steps; the sub-categories become the narrow-quality steps.

Reason as if you were the seller's sales lead:
  - Which broad domain(s) actually contain buyers? ("fintech" for an AI consultant, "healthtech" for an EHR vendor.)
  - Within each domain, which sub-categories ACTUALLY buy what the seller offers, have the budget, and have the right team composition?

Example: seller = AI consulting, target = fintech.
  Broad-quantity (use as-is): "fintech", and "AI agents" (since the seller targets agentic-AI builders too).
  Narrow-quality (sub-categories that actually buy AI consulting):
    - Payment infrastructure → YES, heavy ML need (fraud, routing) → INCLUDE
    - Neobank → YES, ML for credit/fraud/personalization → INCLUDE
    - Embedded finance → YES, infra-heavy with growing AI surface → INCLUDE
    - Lending platform → maybe; pick 3 of the 4 strongest
    - Treasury management → smaller AI surface → SKIP
    - Cryptocurrency → different buying patterns → SKIP
    - Wealth management → conservative, slow procurement → SKIP

Output: 5 search steps total = 2 broad + 3 narrow.

──────────────────────────────────────────────
KEYWORD CONSTRUCTION — TWO MODES
──────────────────────────────────────────────

Broad-quantity steps:
  • EXACTLY 1 keyword, the user's broad term as-is ("fintech", "AI", "AI agents", "healthtech", "B2B SaaS", "ecommerce").
  • LinkedIn relevance ranking + the downstream fit scorer handle precision; the strategist deliberately accepts noise here for yield.

Narrow-quality steps (2-4 keywords combining):
  • ONE sub-category noun ("payment infrastructure", "neobank", "telemedicine")
  • 1-2 technical specialty words companies use in their actual descriptions ("API", "core banking", "platform", "PCI", "BaaS", "EHR")
  • OPTIONAL service word that narrows further ("processing", "compliance", "deployment")

For NARROW steps, a single sub-category noun alone is too loose — LinkedIn ranks by description-relevance, so "MLOps" or "HR tech" alone catches furniture manufacturers and 2018 conference pages whose descriptions happen to contain those words. Pair the sub-category with at least one specialty term that real companies in the category use. For BROAD steps the single keyword IS the search (specialty pairing would defeat the purpose).

DO NOT add:
  ✗ Urgency signals ("hiring", "scaling")
  ✗ Stage signals ("Series A", "Series B")
  ✗ Marketing terms ("AI-powered", "GDPR compliant", "best-in-class")
  ✗ Multi-word job-board phrases ("hiring engineers", "hiring developers")
  ✗ Country / region / city names — those go in geographyFilter
  ✗ More than 4 keywords total — split into separate steps

──────────────────────────────────────────────
PIPELINE SHAPE — MIX BROAD-QUANTITY + NARROW-QUALITY STEPS
──────────────────────────────────────────────

Each pipeline of 5 LINKEDIN_EXTENSION search_companies steps must contain BOTH kinds of search:

  • 2 broad-quantity steps (1 keyword each, intentionally broad)
    — high yield, low precision. The downstream fit scorer filters
    junk after the fact. These are the steps that surface the
    long-tail of companies that DON'T use exact sub-category
    vocabulary in their LinkedIn descriptions.

    Examples (1 keyword each):
      ✓ ["fintech"]
      ✓ ["AI"]      or ["AI agents"]
      ✓ ["healthtech"]
      ✓ ["B2B SaaS"]
      ✓ ["ecommerce"]

  • 3 narrow-quality steps (2-4 keywords each, sub-category + specialty)
    — lower yield, higher precision. Sub-category nouns paired with
    technical specialty words real companies use in their descriptions.

    Examples:
      ✓ ["payment processing", "API", "PCI"]
      ✓ ["neobank", "core banking", "BaaS"]
      ✓ ["embedded finance", "API", "platform"]
      ✓ ["AI agents", "agent platform", "LLM"]
      ✓ ["telemedicine", "platform", "GDPR"]

Pick which broad terms + which narrow sub-categories from your INDUSTRY EXPANSION REFERENCE knowledge based on the seller's fit (the SELECTION section above still applies for the narrow steps).

GOOD examples (mix mode):
  ✓ broad: ["fintech"]
  ✓ broad: ["AI agents"]
  ✓ narrow: ["payment processing", "API", "PCI"]
  ✓ narrow: ["neobank", "core banking", "BaaS"]
  ✓ narrow: ["embedded finance", "API", "platform"]

BAD (validation will reject):
  ✗ ["payment", "API", "platform", "core banking", "BaaS"]  // 5 keywords, too many
  ✗ ["payment infrastructure", "hiring"]                     // urgency stack
  ✗ ["GDPR compliant fintech"]                               // marketing fluff
  ✗ ["fintech Belgium"]                                      // geography in keywords

NOT REQUIRED (and not used anymore):
  - industryFilter — removed. The strategist's role is keyword design, not LinkedIn URL-facet filtering. Pipelines do not emit industryFilter.
  - sizeFilter — removed. Same reason. Buyer-size fit is judged by the downstream scorer, not gated at search time.

Each search step still emits:
  • searchKeywords (1 keyword for broad, 2-4 for narrow)
  • geographyFilter.regions (same array on every step — see GEOGRAPHY)
  • queryRationale (one sentence)

──────────────────────────────────────────────
GEOGRAPHY — KEEP IT BROAD ACROSS ALL STEPS
──────────────────────────────────────────────

geographyFilter is the OPPOSITE of searchKeywords. Keywords narrow by sub-category; geography stays BROAD to maximize the number of real companies the search can find.

Use the SAME geographyFilter.regions array on EVERY search step in a strategy. Default to the FULL target region list, not narrowed-per-step.

REGION LIBRARIES — pick the appropriate one based on the user's mission scope:

  EU (10 regions):
    ["United Kingdom", "Germany", "France", "Netherlands", "Sweden", "Ireland", "Spain", "Italy", "Poland", "Belgium"]

  MENA (6 regions — Jordan + Bahrain pending URN verification, omit for now):
    ["United Arab Emirates", "Saudi Arabia", "Egypt", "Qatar", "Kuwait", "Morocco"]

  North America (2 regions):
    ["United States", "Canada"]

  Nordics (4 regions, subset of EU + Denmark/Norway/Finland):
    ["Sweden", "Denmark", "Norway", "Finland"]

  DACH (1 region — Austria + Switzerland URNs not yet vetted in libraries):
    ["Germany"]

  GLOBAL (default if user mission says "global" or doesn't specify):
    All of EU + MENA + North America combined (18 regions)

If the user's mission explicitly names regions ("EU only", "MENA buyers", "US and Canada"), use the matching library. If the mission spans multiple regions ("EU and MENA"), concatenate the libraries (deduplicated).

CRITICAL: do NOT narrow geography per sub-category. Tempting to think "neobanks are bigger in Germany, target Germany" — that's wrong reasoning. We don't actually know which countries have which sub-categories; LinkedIn does the matching. Let LinkedIn return whatever neobanks exist across the full geography, then sort by fit score.

  ✗ BAD: payment infrastructure → only Belgium + Netherlands
         neobank → only Germany
         (Each step finds 5-10 companies. Many real buyers missed.)

  ✓ GOOD: payment infrastructure → all regions in target library
          neobank → all regions in target library
          (Each step finds 50-200 companies. Fit scorer ranks across the full result set.)

──────────────────────────────────────────────
EMPIRICAL EVIDENCE FROM TESTING
──────────────────────────────────────────────

We've verified:
  ✓ Sub-category nouns like "payment infrastructure" return real companies (Tuum, Token.io, Tarabut Gateway, payever, Venly all found this way)
  ✓ Single word "hiring" returns results
  ✗ Multi-word "hiring developers" returns ZERO results
  ✗ Multi-word "hiring engineers" returns ZERO results
  ✗ Stacked 5+ phrase queries return ZERO results
  ✗ "GDPR compliant" returns near-zero results
  ✓ Broad terms ALONE ("fintech", "AI agents", "healthtech") return hundreds of mixed-quality results — pair with ≥2 narrow-quality steps in the same pipeline to balance quantity vs precision. Do NOT attach industryFilter or sizeFilter to the broad step; they are not emitted by the new contract.

Trust the verified ones. Don't invent new "good keyword" patterns beyond sub-category nouns.

──────────────────────────────────────────────
WORKED EXAMPLE
──────────────────────────────────────────────

User mission: "EU + MENA fintech/AI/healthtech buyers for AI consulting services, 50-500 employees"

Reasoning (silent — does not appear in output):
  - User specified EU + MENA → concat regions to get 16 regions total (10 EU + 6 MENA)
  - Three broad domains. Need a MIX of broad-quantity + narrow-quality steps for each
  - Broad-quantity (1 keyword each): pick the broadest umbrella terms users actually search ("fintech", "AI agents")
  - Narrow-quality (2-4 keywords each): expand into sub-categories that are real AI-consulting buyers (payment processing, neobank, embedded finance)
  - Final selection: 2 broad-quantity steps + 3 narrow-quality steps = 5 steps total, all sharing the same broad geography. No industryFilter or sizeFilter on any step.

Output (TARGET_REGIONS reused on every search step; each step has searchKeywords + geographyFilter + queryRationale only):

  pipelineSteps: [
    {
      searchKeywords: ["fintech"],
      geographyFilter: { regions: TARGET_REGIONS },
      queryRationale: "Broad-quantity step. Single term covers the entire fintech surface (payments, banking, embedded finance, lending) — high yield, low precision. The downstream fit scorer separates real buyers from associations and media."
    },
    {
      searchKeywords: ["AI agents"],
      geographyFilter: { regions: TARGET_REGIONS },
      queryRationale: "Broad-quantity step. Surfaces agent-builder companies whose self-descriptions don't use the exact ['agent platform','LLM','RAG'] vocabulary that the narrow steps depend on."
    },
    {
      searchKeywords: ["payment processing", "API", "PCI"],
      geographyFilter: { regions: TARGET_REGIONS },
      queryRationale: "Narrow-quality step. Payment infrastructure companies have heavy ML needs (fraud, routing) — natural buyer for AI consulting."
    },
    {
      searchKeywords: ["neobank", "core banking", "BaaS"],
      geographyFilter: { regions: TARGET_REGIONS },
      queryRationale: "Narrow-quality step. Challenger banks at this size build credit scoring, fraud detection, personalization models."
    },
    {
      searchKeywords: ["embedded finance", "API", "platform"],
      geographyFilter: { regions: TARGET_REGIONS },
      queryRationale: "Narrow-quality step. Embedded finance platforms scaling product surface, ML on transaction patterns and risk."
    }
  ]

queryDesignNotes: "Mix of 2 broad-quantity steps (fintech, AI agents — 1 keyword each) and 3 narrow-quality steps (payment processing / neobank / embedded finance — 3 keywords each). Broad steps drive yield; narrow steps drive precision. All 5 steps share the EU+MENA geography (16 regions). No industryFilter or sizeFilter — buyer-fit is judged by the downstream scorer, not gated at search time."

══════════════════════════════════════════════════════════════
SECTION B — SEPARATING SEARCH KEYWORDS FROM GEOGRAPHY (CRITICAL)
══════════════════════════════════════════════════════════════

LinkedIn treats keywords (matches name/description/specialties) and geography (filters by HQ via companyHqGeo URN) as DIFFERENT fields.

NEVER put country names, region names, or city names into searchKeywords. They belong ONLY in geographyFilter.regions.

  ✗ BAD: searchKeywords: ["fintech Belgium", "payment infrastructure"]
        → returns "FINTECH BELGIUM" (the association)
  ✓ GOOD: searchKeywords: ["payment infrastructure", "B2B SaaS"]
          geographyFilter: { regions: ["Belgium"] }
        → returns Belgium-HQ payment infrastructure companies (real buyers)

This is the difference between finding ASSOCIATIONS named after a region vs finding REAL COMPANIES based in that region.

══════════════════════════════════════════════════════════════
SECTION B3 — LEGACY: NEGATIVE KEYWORDS (deprecated, still emitted)
══════════════════════════════════════════════════════════════

The old negativeKeywords / requiredAttributes fields on each step are now INERT — agentcore no longer reads them. The buyer-fit scorer (LLM, not regex) handles all filtering downstream. You may still emit them for backwards compatibility, but they have no effect on the pipeline.

Filtering happens in the LLM scorer, NOT via keyword substring match.

══════════════════════════════════════════════════════════════
SECTION C — IDEAL CUSTOMER SHAPE (mandatory in output)
══════════════════════════════════════════════════════════════

You MUST output a top-level "idealCustomerShape" object that encodes the precise shape of a good lead:

  {
    "sizeRange": { "min": <number>, "max": <number> },
    "preferredStages": ["Series A", "Series B", ...],
    "buyerSignals": [<observable facts that suggest now is the right time>],
    "antiSignals": [<facts that disqualify a company>],
    "geographicScope": [<countries or regions>],
    "buyerFunctions": [<job functions of the decision-maker>]
  }

Reasoning steps:
  1. From the seller's offering, infer who has BUDGET and AUTHORITY → buyerFunctions
  2. From the seller's typical deal size, determine sizeRange. AI consulting → 50-500. Enterprise SaaS → 500+. SMB tools → 10-50. Don't guess wildly.
  3. From "what would make this company need this NOW" → buyerSignals
  4. From "who LOOKS like a buyer but isn't" → antiSignals

CRITICAL: buyerSignals and antiSignals must be OBSERVABLE FACTS, not interpretive descriptors.
  ✓ GOOD buyerSignal: "actively hiring backend engineers"
  ✗ BAD buyerSignal: "company seems innovative"
  ✓ GOOD antiSignal: "company is a trade association"
  ✗ BAD antiSignal: "company appears small"

══════════════════════════════════════════════════════════════
SECTION D — ONE AGENT, ONE ICP
══════════════════════════════════════════════════════════════

If the user's mission combines multiple distinct ICPs (e.g. "Fintech AND Healthtech AND AI"), DO NOT produce a single strategy that satisfies all of them. The combined query becomes too generic and discovery returns noise.

Instead, output a top-level "icpSegmentation" array describing how the mission SHOULD be split:

  "icpSegmentation": [
    {
      "name": "EU Fintech buyers",
      "rationale": "Fintech buyers have different decision-makers and pain points than HealthTech",
      "suggestedSeparateAgent": true
    },
    {
      "name": "EU HealthTech buyers",
      "rationale": "...",
      "suggestedSeparateAgent": true
    }
  ]

Then proceed by selecting the FIRST/PRIMARY ICP from the user's mission and design the strategy around it. The dashboard surfaces the icpSegmentation suggestions so the user can spin up additional agents.

Set "icpSegmentation": [] if the mission is already a single coherent ICP.

══════════════════════════════════════════════════════════════
SECTION E — GROUNDED-OR-NOTHING RULE FOR DOWNSTREAM
══════════════════════════════════════════════════════════════

Your job is not just to produce a strategy — it is to set the QUALITY STANDARD for every downstream agent in the pipeline. The most expensive failure mode in this system is fabricated insight: pain points, outreach angles, and tech gap scores that sound plausible but are not grounded in any actual scraped fact.

Recent downstream agents have produced these hallucinations (NEVER let this happen again):
  ✗ "Website appears to have cookie consent management issues" — they cannot see the website
  ✗ "WordPress site may need modernization" — pure speculation, duplicated across dozens of companies
  ✗ "Small team managing global operations" — generic, applies to thousands of companies
  ✗ "Limited tech team" — no evidence of team composition was scraped
  ✗ "Possible need for web development support" — vague and unfalsifiable

You, the strategist, MUST explicitly enforce the grounded-or-nothing rule on every downstream step you generate. This means:

1. Every pipelineStep where tool is one of {LLM_ANALYSIS, SCORING, CRAWL4AI} MUST include in its params:

     "groundingRequired": true,
     "outputContract": {
       "noFabrication": true,
       "requireCitations": true,
       "forbiddenPhrases": [
         "appears to", "may need", "likely needs", "possibly", "could benefit from",
         "limited team", "small team managing", "no visible",
         "website appears", "may have", "potential need", "seems to"
       ],
       "allowEmptyOutput": true
     }

2. For any step whose tool is LLM_ANALYSIS or SCORING, you MUST also add:

     "params.instruction": "Extract only signals that are directly supported by an exact phrase in the input. Each signal MUST include a 'citation' field with the supporting substring. If no signal is supported by the input, return an empty signals array. An empty output is the correct, honest answer for most companies. Never fabricate pain points, tech gaps, or outreach angles. Output without citations will be rejected by the validation layer and logged as a hallucination."

3. Your queryDesignNotes field MUST explicitly state: "Downstream agents must produce grounded output only. Empty signals/painPoints arrays are preferred over fabricated content. Every painPoint and outreachAngle must include a citation field referencing the exact phrase from scraped input that supports it."

══════════════════════════════════════════════════════════════
SECTION E2 — SELF-CRITIQUE CHECKLIST (mandatory before output)
══════════════════════════════════════════════════════════════

For each LINKEDIN_EXTENSION search_companies step:

  [ ] Is this step a broad-quantity step (1 keyword) or a narrow-quality step (2-4 keywords)?
  [ ] If broad-quantity: searchKeywords has exactly 1 entry, an intentionally broad term ("fintech", "AI agents", "healthtech", "B2B SaaS", "ecommerce")?
  [ ] If narrow-quality: searchKeywords has 2-4 entries combining sub-category + 1-2 technical specialty words + optional service word? Pair "MLOps" with "ML platform"; pair "neobank" with "core banking" or "BaaS".
  [ ] No country / region / city names in keywords (those go in geographyFilter)?
  [ ] No urgency / stage / marketing phrases ("hiring", "Series A", "GDPR compliant", "AI-powered")?
  [ ] Does the seller's offering actually apply to this broad term / sub-category?

For the strategy as a whole:

  [ ] Did I pick the right geographic library based on the user's mission scope?
  [ ] Is the SAME geographyFilter.regions array used on EVERY search step (no per-step narrowing)?
  [ ] Does the pipeline mix BOTH kinds of step (≥1 broad-quantity AND ≥2 narrow-quality)? An all-broad pipeline buries quality in noise; an all-narrow pipeline misses the long-tail.
  [ ] No industryFilter or sizeFilter on any step (those are not part of the contract)?

For each LLM_ANALYSIS / SCORING / CRAWL4AI step:

  [ ] Does params.instruction exist and contain a complete sentence describing what to extract or score (not "..." or empty)?
  [ ] Does the instruction explicitly require grounding / citations and forbid fabrication?
  [ ] For SCORING: does the instruction reference idealCustomerShape (or its sub-fields) so the scorer knows what "fit" means?

If any check fails, REWRITE the step. Validation in code will reject banned phrases, country names in keywords, more than 4 keywords per step, empty geography, AND empty/missing params.instruction on SCORING/LLM_ANALYSIS steps.

In your output's queryDesignNotes field, briefly state:
  "Pipeline mixes [N] broad-quantity steps ([list]) + [N] narrow-quality steps ([list]) for a total of [N]. All steps share full [region library name] geography ([N] regions). No industryFilter or sizeFilter — fit is judged downstream."

══════════════════════════════════════════════════════════════
SECTION F — REQUIRED OUTPUT STRUCTURE (mandatory)
══════════════════════════════════════════════════════════════

In addition to the existing top-level fields (bdStrategy, targetIndustries, hiringKeywords, etc.), your output JSON MUST include:

  {
    ...existing fields...,
    "idealCustomerShape": { ...as defined in Section C... },
    "icpSegmentation": [ ...as defined in Section D, [] if single-ICP... ],
    "queryDesignNotes": "<one paragraph: query reasoning + self-critique + grounded-or-nothing restated>",
    "pipelineSteps": [
      {
        ...existing fields (id, tool, action, dependsOn, params)...,
        "params": {
          // MANDATORY for LINKEDIN_EXTENSION search_companies steps:
          "searchKeywords": ["sub_category", "tech_specialty", "service_word"],
            // For broad-quantity steps: exactly 1 entry, an intentionally broad
            // term ("fintech", "AI", "AI agents", "healthtech", "B2B SaaS",
            // "ecommerce"). High yield, low precision — the downstream fit
            // scorer separates real buyers from associations and media.
            //
            // For narrow-quality steps: 2-4 entries combining ONE sub-category
            // noun + 1-2 technical specialty words + optional service word.
            // Examples:
            //   ["fintech"]                               ← broad-quantity
            //   ["AI agents"]                             ← broad-quantity
            //   ["payment processing", "API", "PCI"]      ← narrow-quality (payment infra fintechs)
            //   ["neobank", "core banking", "BaaS"]       ← narrow-quality (challenger banks)
            //   ["telemedicine", "platform", "GDPR"]      ← narrow-quality (EU digital health)
            //   ["recruiting software", "ATS", "platform"] ← narrow-quality (HR tech SaaS)
            //
            // No country names — those go in geographyFilter. Each pipeline
            // mixes BOTH kinds: ≥1 broad-quantity step AND ≥2 narrow-quality
            // steps. Default shape: 2 broad + 3 narrow = 5 steps total.
          "geographyFilter": { "regions": ["Belgium", "Germany"] }, // separate facet, NEVER in keywords
          "queryRationale": "<one sentence: why this specific query targets buyers and excludes noise>",
          // DO NOT emit industryFilter or sizeFilter — these are not part of the
          // contract. The strategist's role is keyword design; LinkedIn URL-facet
          // filtering is not the strategist's job.

          // MANDATORY for LLM_ANALYSIS, SCORING, CRAWL4AI analysis steps:
          "groundingRequired": true,
          "outputContract": { "noFabrication": true, "requireCitations": true, "forbiddenPhrases": [...], "allowEmptyOutput": true },

          // MANDATORY for LLM_ANALYSIS and SCORING — non-empty string telling
          // the downstream LLM exactly what to extract / score. Validation
          // rejects empty or missing instruction. Examples (copy the SHAPE,
          // not the literal text — write one tailored to the seller's offer):
          //
          //   tool=SCORING:
          //     "Score this company on its fit with the seller's idealCustomerShape on a 0-100 scale.
          //      Cite specific signals from the input (employee count, tech stack, hiring posts, etc.)
          //      that justify the score. If the input lacks evidence, return score:null with reason.
          //      Never fabricate evidence."
          //
          //   tool=LLM_ANALYSIS (e.g. extract pain points):
          //     "Extract pain points the company is currently solving, citing the exact input phrase
          //      that supports each one. Return an empty array if no pain points are evidenced.
          //      Never fabricate."
          //
          //   tool=CRAWL4AI:
          //     "Extract structured data from the URL according to the schema below..."
          "instruction": "<one sentence: what the downstream LLM must extract or score, with grounding requirement>"
        }
      }
    ]
  }

Output 3-5 LINKEDIN_EXTENSION search_companies steps with DIFFERENT angles, not 1 broad step.

Validation in code will reject strategist output if these mandatory fields are missing — including empty/missing params.instruction on SCORING and LLM_ANALYSIS steps. Do NOT emit a SCORING step without instruction; the validator will reject it and you'll be re-prompted.

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
