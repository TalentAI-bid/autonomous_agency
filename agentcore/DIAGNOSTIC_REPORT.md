# Discovery Pipeline Diagnostic Report

**Generated:** 2026-04-04
**Scope:** Full pipeline trace from search query generation through contact scoring
**Purpose:** Identify every point where data quality degrades to plan targeted fixes

---

## Table of Contents

1. [Strategist Prompt Analysis](#1-strategist-prompt-analysis)
2. [Discovery Prompt Analysis](#2-discovery-prompt-analysis)
3. [Discovery Agent Analysis](#3-discovery-agent-analysis)
4. [Company Deep Prompt Analysis](#4-company-deep-prompt-analysis)
5. [SearXNG Tool Analysis](#5-searxng-tool-analysis)
6. [Email Intelligence Analysis](#6-email-intelligence-analysis)
7. [Enrichment Agent Analysis](#7-enrichment-agent-analysis)
8. [Scoring Prompt Analysis](#8-scoring-prompt-analysis)
9. [Database Results — Recent Run](#9-database-results--recent-run)
10. [Summary: Data Quality Degradation Map](#10-summary-data-quality-degradation-map)

---

## 1. Strategist Prompt Analysis

**File:** `src/prompts/strategist.prompt.ts` (140 lines)

### Exact Prompt Text Sent to LLM

**System prompt (lines 3–62):**

```
You are an expert business development and lead generation strategist. Given a mission, target market, and context, you produce a comprehensive strategy to find and engage the right organizations or individuals.

CRITICAL: You must DEEPLY ANALYZE the mission to understand WHAT KIND of targets to search for. The mission might be about:
- Tech B2B sales (SaaS companies, startups)
- University/academic partnerships
- Consulting sales (marketing, CX, management)
- Non-profit or government outreach
- Any other industry

ADAPT ALL your outputs to the specific mission. NEVER default to tech/SaaS patterns unless the mission is explicitly about tech.
```

**Critical query generation rules (lines 23–32):**

```
1. EVERY query MUST contain the EXACT country or city from the mission's target locations.
   If the mission says 'Ireland', every single query must contain 'Ireland'. No exceptions.
2. EVERY query MUST contain at least one specific role keyword (e.g. 'DevOps engineer', 'CTO',
   'VP Engineering') OR a specific skill/service keyword from the mission (e.g. 'DevOps',
   'Kubernetes', 'cloud migration').
3. NO generic queries without a role or skill keyword. A query like 'companies in Ireland'
   is FORBIDDEN — it must be 'DevOps companies Ireland' or 'hiring DevOps engineer Ireland'.
4. Use AT MOST 1 quoted phrase per query. Too many quoted terms returns zero results.
5. When targeting non-English countries, include queries in BOTH the local language AND English.
6. NO site: directives in queries. Keep queries simple and natural like a human would type.
   Unwanted domains are filtered in code after results come back.
```

**Query output structure (lines 33–46) — generates EXACTLY 15 queries in 3 groups of 5:**

- GROUP 1 (LinkedIn Jobs): e.g. `LinkedIn jobs "DevOps engineer" Ireland`
- GROUP 2 (Indeed/Job Boards): e.g. `Indeed "DevOps" Ireland hiring 2025`
- GROUP 3 (Career Pages): e.g. `"hiring DevOps engineer" Ireland careers`

### Analysis

| Aspect | Finding |
|--------|---------|
| **Query target** | Job postings (LinkedIn Jobs, Indeed, career pages) — hiring signals |
| **Location enforcement** | MANDATORY in every query, no exceptions |
| **Role/skill keywords** | MANDATORY in every query, no generic searches |
| **Quoting rules** | Max 1 quoted phrase per query (prevents zero-result searches) |

### CURRENT BEHAVIOR
Generates 15 search queries targeting job postings as hiring signals. Location and role keywords are strictly enforced in prompt instructions.

### PROBLEMS FOUND
1. **No validation that the LLM actually followed the rules.** The prompt tells the LLM "every query MUST contain location" but there is no code-level check that the returned queries actually contain the target location or role keywords. The LLM could ignore these instructions.
2. **Hardcoded to 15 queries in 3 groups.** No ability to adjust volume based on market size or specificity.
3. **Year "2025" hardcoded in example queries.** May produce stale or overly specific results if the LLM copies the example.

### RECOMMENDED FIX
1. Add post-generation validation: reject any query that doesn't contain at least one target location string.
2. Make query count configurable.
3. Use dynamic year in examples.

### PRIORITY: Medium

---

## 2. Discovery Prompt Analysis

**File:** `src/prompts/discovery.prompt.ts` (127 lines)

### Exact Prompt Text Sent to LLM

**System prompt — sales mode (lines 2–24):**

```
You are a business development and prospect intelligence expert. Generate targeted search queries
to find decision-makers and key contacts at organizations matching the target profile.

Adapt your search strategy to the TARGET TYPE described in the requirements:
- For companies/startups: LinkedIn company pages, team pages, funding news
- For universities/academic: department pages, research groups, faculty directories
- For government/NGO: program pages, initiative announcements, agency directories
- For consulting targets: pain-point discussions, RFP listings, industry forums

CRITICAL RULE — Location enforcement:
If locations are specified, EVERY query MUST include the location as a required term
(not optional, not in parentheses with OR alternatives that omit it).
Do not generate any query without the target location.
```

**Query format rules (lines 16–23):**

```
- Max 1 quoted phrase per query
- NO site: directives
- NO -site: exclusions
- Mixed quote + unquoted keywords
- Both local language AND English for non-English countries
```

**User prompt — location enforcement block (lines 48–51):**

```
MANDATORY LOCATION FILTER: ${data.locations.join(', ')}
⚠️ Every single query below MUST contain "${data.locations[0]}"
(or the equivalent location term). Queries missing the location will be rejected.
```

**Page type targets (lines 63–70):**

```
- LinkedIn profiles: "[role]" [industry] [location] LinkedIn
- LinkedIn companies: [descriptor] [location] company LinkedIn
- Team/leadership pages: "[org type]" team OR leadership [location]
- Industry directories
- Academic department pages
- Government/NGO initiative pages
- News about company funding/launches
```

### Analysis

| Aspect | Finding |
|--------|---------|
| **Query target** | Company pages, LinkedIn companies, team pages — company discovery |
| **Location enforcement** | Strictly mandatory, enforced in both system and user prompt |
| **Page type distinction** | Yes — academic, government, NGO, consulting targets distinguished |
| **Unknown company handling** | No explicit instruction for what to do when company name isn't found on page |
| **Hallucination rules** | No explicit "do not guess" instruction in this prompt (that's in classifyAndExtract) |

### CURRENT BEHAVIOR
Generates discovery search queries targeting company pages, team pages, and LinkedIn profiles. Adapts query strategy to target type (tech, academic, government, NGO).

### PROBLEMS FOUND
1. **No post-generation validation.** Same issue as strategist — LLM is told to include location but no code verifies compliance.
2. **Only uses `data.locations[0]`** in the "must contain" warning. If multiple locations are specified, only the first is enforced in the warning text.
3. **No instructions about what to do with irrelevant results.** The prompt generates queries but doesn't instruct on filtering; that's entirely delegated to discovery.agent.ts.

### RECOMMENDED FIX
1. Add code-level query validation (check each query contains a location string).
2. Enforce all locations, not just `locations[0]`.

### PRIORITY: Medium

---

## 3. Discovery Agent Analysis

**File:** `src/agents/discovery.agent.ts` (830 lines)

### Model Used

```typescript
const FAST_MODEL = 'openai.gpt-oss-120b-1:0';  // Line 162
```

**Uses the 120B model** for classifyAndExtract — not the smaller 20B model.

### Exact classifyAndExtract System Prompt (lines 585–606)

```
You analyze web page content and extract organizational and people data.

Given a page's content, URL, and title, you must:
1. Classify the page type
2. Extract organizations and people mentioned that are relevant to the mission

Page types:
- "company_page" = a single organization's own website/profile (commercial entity)
- "institution_page" = a university, research institution, or government agency page
- "directory" = a list/article mentioning multiple organizations
- "team_page" = an organization page showing team members/faculty/staff
- "job_listing" = a job/position posting (the hiring organization is valuable data)
- "person_profile" = an individual's profile page
- "irrelevant" = login pages, generic content, error pages, encyclopedia, event registration, geographic info

For EACH organization found, extract: name, domain (if visible), industry (or academic field/sector),
description (1 sentence), size, location (MUST include country — e.g. "Paris, France" or "USA"),
funding (use "N/A" for non-commercial entities like universities), entityType ("company", "university",
"government", "ngo", "agency", "institution"), relevanceScore (0-100), relevanceReason (brief explanation).

⚠️ The "location" field is CRITICAL. Always include the country. Infer from domain
(.fr = France, .de = Germany, .co.uk = UK) or page content if not stated explicitly.

⚠️ The "relevanceScore" field is CRITICAL. Score each entity based on how well it matches
the mission context above.

For EACH person found, extract: name, title/role, organization they work at.

Return ONLY valid JSON. If the page is irrelevant, return { "type": "irrelevant", "companies": [], "people": [] }.
Do NOT invent data — only extract what is clearly stated on the page.
```

**Mission context / relevance rules (lines 578–580):**

```
IMPORTANT RELEVANCE RULES:
- Only extract organizations that PLAUSIBLY match the mission above.
- For each organization, assign a relevanceScore (0-100):
  - 80-100 = strong match (right industry, right location, right signals)
  - 50-79 = partial match (some criteria match)
  - 20-49 = weak match (tangential relation)
  - 0-19 = irrelevant (wrong industry, wrong country, no connection)
- If the mission specifies a location (e.g. "Ireland"), companies NOT in that country should score below 30.
- If the mission specifies an industry/service (e.g. "DevOps"), companies in unrelated industries should score below 30.
- Provide a brief relevanceReason explaining the score.
```

### Exact Flow: SearXNG → URL Filtering → Crawl4AI → LLM Classify → Filters → Save

```
1. Execute search query via SearXNG                           (line 278)
2. If 0 results → strip operators and retry ONCE              (lines 281-292)
3. If still 0 → log warning, continue to next query           (lines 289-292)
4. Prioritize top 5 results                                   (line 297)
5. For each result:
   a. Filter LinkedIn dead profiles                           (lines 306-314)
   b. Filter blocked domains                                  (lines 318-324)
   c. Filter mega-corps in sales mode                         (lines 326-330)
   d. Scrape URL via Crawl4AI                                 (line 336)
   e. If scrape fails or content < 100 chars → skip           (lines 340-346)
   f. Call classifyAndExtract LLM (120B model)                (lines 350-352)
   g. If type === 'irrelevant' → skip                         (lines 354-356)
   h. For each extracted company:
      - Name validation (length >= 2)                         (line 361)
      - Mega-corp filter (sales mode)                         (line 362)
      - Relevance gate (score >= 40 when mission active)      (lines 365-369)
      - Industry filter (substring + word matching)           (lines 371-389)
      - Location filter (matchesTargetLocation)               (lines 391-398)
      - Save to DB + dispatch enrichment                      (lines 401-420)
   i. Save extracted people (max 10 per page)                 (lines 428-465)
```

### Post-LLM Filters

| Filter | Threshold | Line |
|--------|-----------|------|
| Content minimum | 100 chars | 344 |
| Name validation | length >= 2 chars | 361 |
| Mega-corp block | Domain-based list (sales mode only) | 362 |
| Relevance score | >= 40 (when mission context active) | 365 |
| Industry match | Substring + word matching | 371-389 |
| Location match | `matchesTargetLocation()` — unknown location REJECTED when targets set | 391-398 |

### What Happens with Empty Crawl4AI Content

```typescript
if (!pageContent || pageContent.length < 100) {
  skipped++;
  continue;   // Lines 344-347 — silently skipped, no retry
}
```

### Are "Unknown" Companies Filtered or Saved?

**No explicit "Unknown" string filter.** The only name validation is `co.name.length >= 2`. A company named "Unknown" (7 chars) would **pass validation and be saved to DB**.

### CURRENT BEHAVIOR
Uses 120B model to classify page types and extract structured company/person data. Applies 6 post-LLM filters (content length, name, mega-corp, relevance, industry, location). Saves valid companies and dispatches enrichment.

### PROBLEMS FOUND

1. **CRITICAL: No "Unknown" company name filter.** The string "Unknown" passes the `length >= 2` check. DB evidence shows junk companies like "Thomas Kurian" (a person name), "Self-employed" (not a company), and SEC-format names like "SYMANTEC CORP (GEN) (CIK 0000849399)".

2. **CRITICAL: No duplicate detection across queries.** The same company can be extracted from multiple search results and saved multiple times. DB evidence: "Armon Dadgar" appears 6 times as a contact, "Jooble" appears 3 times as a company with 3 different wrong domains.

3. **CRITICAL: Wrong domain extraction.** DB shows: Worldline→zoominfo.com, Carrefour→majidalfuttaim.com, Google→siliconangle.com, Jooble→mail.google.com, Jooble→education.com. The LLM extracts the domain of the PAGE it's reading, not the company's actual domain.

4. **HIGH: 21.5% of companies have no location** (20 out of 93). The prompt says "infer from domain" but the post-LLM filter only rejects unknown locations when `this._ctx?.locations?.length` is set. If context locations aren't configured, companies with no location pass through.

5. **HIGH: Mega-corp filter only in sales mode.** Microsoft, Johnson & Johnson, Schneider Electric all in the DB. These are mega-corps that shouldn't be discovery targets.

6. **MEDIUM: Top-5 result limit per query.** Only processes 5 URLs per search query. Combined with the 15-query strategy, max theoretical throughput is 75 URLs per discovery cycle.

7. **MEDIUM: No retry on Crawl4AI failure.** If scrape fails or returns < 100 chars, the URL is permanently skipped.

8. **LOW: Relevance threshold of 40 is lenient.** Weak matches (40-49) can slip through.

### RECOMMENDED FIX
1. Add blocklist for junk company names: "Unknown", "Self-employed", "Self employed", "N/A", "None", person names (detect via LLM or heuristic).
2. Add domain deduplication before save (check if company name+domain already exists).
3. Add contact deduplication (firstName + lastName + companyName).
4. Validate extracted domain: reject if domain doesn't plausibly belong to the company (e.g., domain is a search engine, news site, or government site).
5. Apply mega-corp filter in all modes, not just sales.
6. Add Crawl4AI retry (1 retry with delay).
7. Raise relevance threshold to 50.

### PRIORITY: Critical

---

## 4. Company Deep Prompt Analysis

**File:** `src/prompts/company-deep.prompt.ts` (120 lines)

### Exact Prompt Text — Team Member Extraction Rules (lines 44–52)

```
keyPeople extraction — STRICT RULES:
  - ONLY extract people found on the company's OWN DOMAIN pages (homepage, about page, team page,
    leadership page). The company domain is provided in the COMPANY header above.
  - COMPLETELY IGNORE people mentioned in: news articles, Crunchbase, external directories,
    press releases, partner pages, or any page NOT on the company's own domain.
  - ONLY include CURRENT employees. Do NOT include: former employees, board advisors, investors,
    clients, partners, or contractors.
  - Extract a MAXIMUM of 5 people. No more.
  - Priority order (extract in this order until you have 5):
    CEO, CTO, VP Engineering, Head of HR, Hiring Manager, COO, CFO, Head of Sales, Head of Marketing.
  - If fewer than 5 people are found on the company's own domain, return only those found.
    Do NOT pad with people from other sources.
  - For each person: name, title, department (e.g. "Engineering", "Sales", "Executive"),
    linkedinUrl (if visible on team page), email (if visible on team/contact page).
  - Use empty strings for unknown fields.
```

### Data Sources Provided to the LLM (lines 62–113)

| Source | Max Chars | Purpose |
|--------|-----------|---------|
| `homepageContent` | 2,500 | Company's own domain |
| `aboutPageContent` | 2,000 | Company's own domain |
| `careersPageContent` | 1,500 | Company's own domain |
| `teamPageContent` | 2,500 | Primary source for people |
| `linkedinCompanyContent` | 1,500 | Company LinkedIn page |
| `crunchbaseContent` | 1,000 | External — should be ignored for people |
| `newsContent` | 1,000 | External — should be ignored for people |
| `glassdoorContent` | 500 | External — should be ignored for people |
| `searchResults` | 1,000 | General web results |

### Analysis

| Aspect | Finding |
|--------|---------|
| **Current vs. former employees** | Explicitly distinguishes — "ONLY include CURRENT employees" |
| **News/external sources** | Explicitly excluded — "COMPLETELY IGNORE people mentioned in news articles, Crunchbase" |
| **Own domain enforcement** | Yes — "ONLY extract people found on the company's OWN DOMAIN pages" |
| **Max people** | 5 people, priority-ordered by role seniority |

### CURRENT BEHAVIOR
Extracts up to 5 key people from company's own domain pages only, with strict rules against external sources and non-current employees. Priority order favors C-suite and VP roles.

### PROBLEMS FOUND
1. **MEDIUM: Conflicting data sources.** Crunchbase, news, Glassdoor content ARE sent to the LLM even though the prompt says "COMPLETELY IGNORE" them. The LLM might still be influenced by this data, especially if the company's own pages have sparse team information.

2. **MEDIUM: No validation that extracted people are actually from own domain.** The prompt instructs the LLM but there's no code-level verification that extracted names actually appeared in the `homepageContent`, `aboutPageContent`, or `teamPageContent` fields.

3. **LOW: LinkedIn company page is ambiguous.** The prompt says "company's OWN DOMAIN" but LinkedIn isn't the company's domain. Should LinkedIn company profiles count?

### RECOMMENDED FIX
1. Don't send Crunchbase/news/Glassdoor content to the LLM at all if they shouldn't be used for people extraction — or send them in a clearly separated section labeled "DO NOT use for keyPeople".
2. Add post-extraction validation: check that each extracted person's name appears in at least one of the own-domain content fields.

### PRIORITY: Medium

---

## 5. SearXNG Tool Analysis

**File:** `src/tools/searxng.tool.ts` (384 lines)

### Rate Limits Configured (lines 15–23)

| Constant | Value | Purpose |
|----------|-------|---------|
| `RATE_LIMIT_MAX` | 10,000 | Main search budget per tenant per hour |
| `DISCOVERY_RATE_LIMIT_MAX` | 10,000 | Separate bucket for discovery searches |
| `RATE_LIMIT_WINDOW_SEC` | 3,600 | 1-hour window |
| `CACHE_TTL_SEC` | 43,200 | 12-hour cache |
| `CIRCUIT_BREAKER_THRESHOLD` | 15 | Failures before circuit opens |
| `CIRCUIT_BREAKER_TTL` | 60 | 1-minute circuit open duration |

### Delay Between Requests (lines 44–70)

Adaptive delay function `getAdaptiveDelay()`:

| Load Level | Requests/10min | Delay |
|------------|---------------|-------|
| Normal | 0–50 | 3–5 seconds |
| Elevated | 50–100 | 8–12 seconds + warning |
| Heavy | 100+ | 60-second pause |

### Zero-Result Retry Logic (lines 193–220)

1. If 0 results: strip quotes, `site:`, `-site:` operators from query
2. Retry stripped query ONCE with adaptive delay
3. If still 0 results: log warning, return empty array
4. **No further retries, no synonym substitution, no query reformulation**

### Engine Parameters

- **Does NOT pass engine parameters** in the fetch URL (line 172)
- URL is simply: `${env.SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`
- Relies entirely on `searxng/settings.yml` for engine configuration
- Settings.yml enables only: **google, brave, startpage, qwant**

### CURRENT BEHAVIOR
Sends search queries to local SearXNG instance with adaptive rate limiting, 12-hour result caching, and circuit breaker. On zero results, strips operators and retries once.

### PROBLEMS FOUND
1. **HIGH: Only ONE retry on zero results.** With only 4 search engines (google, brave, startpage, qwant), zero-result scenarios are common, especially for non-English or niche queries. A single stripped retry is insufficient.

2. **HIGH: No engine parameter control.** Cannot target specific engines per query type. Job-board queries and company-page queries use the same engine set.

3. **MEDIUM: settings.yml has `limiter: false`.** No SearXNG-level rate limiting — all limiting is application-side. If the application rate limiter has a bug, there's no safety net.

4. **MEDIUM: 15-second HTTP timeout hardcoded** (lines 169–170). Not configurable, may be too short for some engines.

5. **LOW: Proxy credentials hardcoded in settings.yml** (Bright Data residential proxy on lines 33–35). Should be environment variables.

6. **LOW: SearXNG secret key is placeholder** (`"changethiskeytosomethingrandom123456"` in settings.yml line 10).

### RECOMMENDED FIX
1. Add multi-step retry: stripped query → simplified query → broader query with fewer terms.
2. Allow per-query engine selection (pass `engines=` parameter for job-board vs. company queries).
3. Enable SearXNG-level limiter as a safety net.
4. Move proxy credentials and secret key to environment variables.

### PRIORITY: High

---

## 6. Email Intelligence Analysis

**File:** `src/tools/email-intelligence.ts` (369 lines)

### Email Discovery Layers

| Layer | Status | Details |
|-------|--------|---------|
| **Generect API** | ACTIVE | Primary and ONLY layer. Confidence threshold: >= 70 |
| **Fallback methods** | NONE | Line 121-122: `// No fallback — return null` |

### Generect Configuration

- **API Key:** Set in `.env` as `GENERECT_API_KEY=af960ba40db5ffec7f901220964f8af0`
- **API Base:** `https://api.generect.com/api/linkedin` (line 40 in `generect-email.ts`)
- **Confidence mapping** (in `generect-email.ts` lines 296–313):
  - 95 = valid email, NOT catch-all
  - 70 = email exists but IS catch-all
  - 0 = email not found or error
- **Billing circuit breaker:** Opens on HTTP 402 for 1 hour (lines 102–106 in `generect-email.ts`)

### What Happens When Generect Fails

```typescript
// Line 103-122 in email-intelligence.ts
try {
  const generectResult = await generectEmailTool.findEmail(first, last, domain);
  if (generectResult.email && generectResult.confidence >= 70) {
    // ... save and return
  }
} catch (err) {
  logger.debug({ err, first, last, domain }, 'Generect discovery failed');
}

// No fallback — return null
return { email: null, confidence: 0, method: null, source: null };
```

**No retry. No fallback. Single attempt only.**

### Domain Resolution

- `resolveDomain()` (lines 214–258): Uses SearXNG to find company domain from name
- Caches found domains for 30 days, "not found" for 1 hour
- Depends on SearXNG working and having search budget remaining

### CURRENT BEHAVIOR
Single email discovery layer (Generect API). Requires >= 70 confidence. No fallback when Generect fails or returns low confidence. Domain resolution via SearXNG web search.

### PROBLEMS FOUND

1. **CRITICAL: Only 1 email discovery layer.** DB shows only 34 out of 272 contacts have emails (12.5% email discovery rate). When Generect fails or returns confidence < 70, the contact gets no email. No pattern-based guessing, no Hunter.io, no GitHub scraping, no LinkedIn extraction.

2. **CRITICAL: No retry on Generect failure.** Single API call with no timeout protection. Network blip = permanent email loss for that contact.

3. **HIGH: Catch-all emails scored at 70.** Catch-all domains accept any email address, so the "found" email may not actually reach a person. These should be flagged differently.

4. **HIGH: Domain resolution depends on SearXNG budget.** If search budget is exhausted during enrichment, domain resolution fails and email discovery can't even start.

5. **MEDIUM: 30-day negative cache.** If Generect can't find an email today (maybe the person just joined the company), it won't retry for 30 days.

6. **MEDIUM: Billing circuit breaker uses setTimeout** (not Redis-backed). Server restart resets it, potentially causing repeated 402 errors.

### RECOMMENDED FIX
1. Add at least 2 fallback layers: pattern-based email generation (first.last@domain.com, f.last@domain.com) with SMTP verification, and a second provider (Hunter.io, Apollo, etc.).
2. Add retry with exponential backoff on Generect API calls.
3. Add timeout on Generect API calls (10 seconds).
4. Reduce negative cache to 24 hours for email lookups.
5. Flag catch-all emails with a distinct status (not just confidence score).
6. Move billing circuit to Redis for persistence across restarts.

### PRIORITY: Critical

---

## 7. Enrichment Agent Analysis

**File:** `src/agents/enrichment.agent.ts` (~1,140 lines)

### Data Completeness Thresholds

**Contact completeness gate (line 597):**

```typescript
const qualityDecision = dataCompleteness >= 40 ? 'pass'
  : (dataCompleteness >= 25 ? 'retry' : 'archive');
```

| Completeness | Decision | Action |
|-------------|----------|--------|
| >= 40% | Pass | Mark enriched, dispatch to scoring |
| 25–39% | Retry | Re-enqueue with `deepMode: true` (max 2 retries) |
| < 25% | Archive | Contact archived, exits pipeline |

**Company completeness gate (line 1004):**

```typescript
const qualityDecision = companyDataCompleteness >= 30 ? 'enriched' : 'incomplete';
```

| Completeness | Decision |
|-------------|----------|
| >= 30% | Enriched — proceed with team extraction |
| < 30% | Incomplete — saved but no team extraction |

**Company completeness calculation (lines 316–318) — 14 fields checked:**
name, domain, industry, size, description, funding, linkedinUrl, foundedYear, headquarters, techStack (array), keyPeople (array), recentNews (array), products (array), competitors (array)

### Retry Logic

| Retry Type | Max | Details |
|------------|-----|---------|
| Hard cap | 3 | Lines 79–87: After 3 total retries, contact archived |
| Soft retry | 2 | Lines 630–664: If 25% <= completeness < 40%, retry with `deepMode: true` |
| After retries exhausted | — | If still >= 25% after 2 retries, proceeds to scoring anyway (line 667) |

### Email Fast-Path (lines 606–628)

```
If email found → immediately mark as enriched and dispatch scoring
Overrides the 40% completeness gate
```

This means a contact with email but very sparse data (e.g., 15% completeness) still proceeds to scoring.

### Email Confidence in Enrichment (lines 500–503)

```typescript
if (result.email && result.confidence >= 50) {
  emailFound = result.email;
  emailVerified = result.confidence >= 80;
}
```

**Note:** Enrichment accepts emails at confidence >= 50, but email-intelligence only returns emails at confidence >= 70. There's a 50–69 gap that's never filled.

### What Happens When Enrichment Fails

| Failure | Handling |
|---------|----------|
| SearXNG budget < 50 remaining | Skip enrichment entirely (lines 44–60) |
| Non-Latin name | Skip enrichment, archive contact (lines 89–98) |
| LLM synthesis fails | Continue with null profile, completeness = 0 (lines 518–550) |
| Company enrichment fails | Continue with null company (lines 463–465) |
| Email discovery fails | Continue without email (lines 506–508) |

### CURRENT BEHAVIOR
Multi-stage enrichment: company deep research → email discovery → LLM profile synthesis → completeness gate → scoring dispatch. Email fast-path bypasses completeness gate. Max 3 retries with deep mode escalation.

### PROBLEMS FOUND

1. **HIGH: `deepMode` flag is passed but never checked.** Line 643 passes `deepMode: true` on retry, but the enrichment code doesn't branch on this flag. Retries do the exact same thing as the first attempt.

2. **HIGH: Email fast-path bypasses quality gate.** A contact with email but 10% completeness (just name + email, nothing else) goes straight to scoring. This produces low-confidence scores and wastes outreach on poorly understood contacts.

3. **MEDIUM: Non-Latin name skip is aggressive.** Contacts with accented characters (common in French names like "Stéphane", "Frédéric") might be incorrectly classified as non-Latin. Need to verify the detection logic.

4. **MEDIUM: Confidence gap.** Email-intelligence returns at >= 70 confidence, but enrichment accepts at >= 50. The 50–69 range is dead code.

5. **LOW: All errors caught silently.** Enrichment catches all exceptions and continues (resilient but may mask systematic failures).

### RECOMMENDED FIX
1. Implement actual `deepMode` behavior: use different search strategies, try additional sources, increase Crawl4AI content limits.
2. Don't bypass completeness gate entirely for email-found contacts. Use a lower threshold (e.g., 25%) but not zero.
3. Verify non-Latin detection handles accented Latin characters correctly (French, German, Spanish names).
4. Align confidence thresholds: either lower email-intelligence to 50 or raise enrichment to 70.

### PRIORITY: High

---

## 8. Scoring Prompt Analysis

**File:** `src/prompts/scoring.prompt.ts` (212 lines)

### Scoring Dimensions — Sales Mode

| Dimension | Weight | Scale |
|-----------|--------|-------|
| Authority | 25% | C-suite=90+, VP=80, Director=70, Manager=55, IC=30 |
| Company Fit | 20% | Industry match, size, tech stack alignment |
| Relevance | 15% | Person/company match to product being sold |
| Accessibility | 15% | Email=90, LinkedIn=70, company page only=40 |
| Opportunity Strength | 25% | Intent score >=70 → 90+; 50-69 → 70-89; ICP match → 50-69; no signal → 40-55 |

**Default weights (line 112):**

```typescript
const defaultWeights = { authority: 25, companyFit: 20, relevance: 15, accessibility: 15, opportunity_strength: 25 };
```

### Scoring Dimensions — Recruitment Mode

| Dimension | Weight |
|-----------|--------|
| Skills | 40% |
| Experience | 25% |
| Location | 15% |
| Education | 10% |
| Company Background | 10% |

### Thresholds & Rules

```
When data is sparse, lean toward a moderate score (45-60) rather than a low one.
Only reject with confidence — missing data should not be heavily penalized.

Confidence (0-100):
- High data completeness + rich profile data → 80-100
- Moderate data → 50-79
- Sparse data → 0-49
```

### skillLevels Code (lines 103–105)

```typescript
const skillLevelsStr = (data.contact.skillLevels ?? [])
  .map((s) => `${s.skill} (${s.level})`)
  .join(', ');
```

**Bug analysis:** The code assumes each skill object has `.skill` and `.level` properties. If `skillLevels` contains objects with different property names (e.g., `skillName` instead of `skill`, or `proficiency` instead of `level`), this would produce strings like `"undefined (undefined)"` — silently corrupting the prompt sent to the scoring LLM.

**This is used only in the recruitment prompt (line 180):**
```
- Skill Proficiency: ${skillLevelsStr || 'N/A'}
```

If skillLevels is populated with wrong property names, the LLM receives garbage like `"undefined (undefined), undefined (undefined)"` instead of actual skill data, causing it to score skills blindly.

### CURRENT BEHAVIOR
Two scoring modes (sales/recruitment) with weighted multi-dimensional scoring. Sparse data gets moderate scores (45-60) rather than penalties. Confidence reflects data quality.

### PROBLEMS FOUND

1. **HIGH: skillLevels property name assumption.** No validation that `.skill` and `.level` properties exist. Silent corruption produces `"undefined (undefined)"` in the LLM prompt. Need to verify what the actual data schema is for skillLevels objects.

2. **MEDIUM: "Lean toward moderate score" for sparse data.** This inflates scores for poorly-enriched contacts. Combined with the email fast-path (which bypasses completeness gate), contacts with just a name and email can get scores of 45-60 — high enough to be included in outreach.

3. **MEDIUM: Accessibility dimension rewards email existence.** Email found = 90 points (15% weight = 13.5 overall points). This creates incentive misalignment: contacts with emails (even catch-all) score significantly higher regardless of actual fit.

4. **LOW: No score normalization across runs.** Different batches may have different data quality, leading to incomparable scores.

### RECOMMENDED FIX
1. Add defensive check: validate skillLevels object shape before mapping. Log warning if unexpected properties found.
2. Consider penalizing sparse data more (35-45 range) to differentiate from moderately-matched contacts.
3. Reduce accessibility weight or add a catch-all email penalty.

### PRIORITY: High

---

## 9. Database Results — Recent Run

### Companies (Most Recent Master Agent — 20 rows shown)

```
name                                      | domain                    | industry                                       | location
------------------------------------------+---------------------------+------------------------------------------------+--------------------------------
Thomas Kurian                             |                           |                                                |
Johnson & Johnson                         | jnj.com                   | Healthcare / Pharmaceuticals / Medical Devices |
Magellan                                  |                           |                                                |
Schneider Electric                        | se.com                    | Energy Management & Automation                 |
Bois Energie France                       | boisenergie.fr            | Renewable Energy / Biomass                     |
EDF                                       | edf.fr                    |                                                |
Self‑employed                             | selfemployed.com          |                                                |
Angi Inc. (ANGI) (CIK 0001705110)         |                           |                                                |
SYMANTEC CORP (GEN) (CIK 0000849399)      |                           |                                                |
MICROSOFT CORP (MSFT) (CIK 0000789019)    |                           |                                                |
France Travail                            | france-travail.fr         | Public Administration / Employment Services    | France
Intelligence Academy                     | the-intelligence-academy. | AI training and coaching                       | France
Groupe Talents Handicap                   |                           | Human Resources / Employment Services          | Rhône, France
HRConseil                                 | hrconseil.com             | HR consulting / recruitment technology         | France
Michael Page                              | michaelpage.fr            | Recruitment / Staffing                         | France
Welcome to the Jungle                     | welcome-to-the-jungle.com | HR Tech / Recruitment / Employer Branding      | Paris, France
Web-atrio                                 | web-atrio.com             | Digital Agency / Web Development               | France
Coface                                    | coface.fr                 | Credit Insurance / Financial Services          | Paris, France
Free-Work                                 | free-work.com             | Freelance job platform / IT recruitment        | France
Licorne Society                           | licornesociety.com        | Recruitment / Staffing (DevOps, Cloud, SRE)    | France
```

### Companies with Wrong Domains (from extended query)

| Company | Assigned Domain | Actual Domain | Problem |
|---------|----------------|---------------|---------|
| Worldline | zoominfo.com | worldline.com | Extracted page domain, not company domain |
| Google | siliconangle.com | google.com | Extracted news site domain |
| Carrefour | majidalfuttaim.com | carrefour.com | Extracted partner/franchisee domain |
| Jooble | mail.google.com | jooble.org | Extracted Google domain from page |
| Jooble | education.com | jooble.org | Extracted wrong site domain |
| Jooble | avahr.com | jooble.org | Extracted wrong site domain |

### Company Data Quality Stats

```
total_companies | no_domain | no_location | no_industry
----------------+-----------+-------------+-------------
             93 |        10 |          20 |          10
```

- **10.8% missing domain** (10/93)
- **21.5% missing location** (20/93)
- **10.8% missing industry** (10/93)

### Junk Company Entries

| Name | Problem |
|------|---------|
| Thomas Kurian | Person name, not a company |
| Self-employed | Not a real company |
| Angi Inc. (ANGI) (CIK 0001705110) | SEC filing format — CIK number in name |
| SYMANTEC CORP (GEN) (CIK 0000849399) | SEC filing format — CIK number in name |
| MICROSOFT CORP (MSFT) (CIK 0000789019) | SEC filing format + mega-corp |
| Google Cloud Platform (GCP) | Product name, not company name |

### Contacts (Most Recent Master Agent — 20 rows shown)

```
first_name    | last_name | company_name   | email | score | status
--------------+-----------+----------------+-------+-------+----------
Stéphane      | Bichara   | Coface         |       |       | discovered
Stéphane      | Pirot     | Coface         |       |       | discovered
Shawn         | Klaff     | HashiCorp      |       |       | discovered
Katherine     | McGovern  | HashiCorp      |       |       | discovered
David         | McJannet  | HashiCorp      |       |       | discovered
Armon         | Dadgar    | HashiCorp      |       |       | discovered
Caroline      | Martin    | Equans         |       |       | discovered
Thierry       | Mallet    | Equans         |       |       | archived
Alain         | Bouchard  | Equans         |       |       | archived
Jean‑Marc     | Mazzoleni | Ville de Paris |       |       | discovered
Marie‑Christ. | Ouen      | Ville de Paris |       |       | discovered
Christophe    | Grondin   | Ville de Paris |       |       | discovered
Patrick       | Joly      | Ville de Paris |       |       | discovered
Anne          | Hidalgo   | Ville de Paris |       |    70 | scored
Lydia         | Baker     | HashiCorp      |       |       | discovered
Jillian       | Miller    | HashiCorp      |       |       | discovered
Colin         | McCabe    | HashiCorp      |       |       | discovered
Armon         | Dadgar    | HashiCorp      |       |       | discovered
Marie‑Christ. | Leclerc   | Ville de Paris |       |       | archived
Christophe    | Leclerc   | Ville de Paris |       |       | archived
```

**Key observations:**
- **0 emails in the top 20 contacts** — email discovery is failing at scale
- **Armon Dadgar appears 6 times** — no duplicate detection
- **Anne Hidalgo (Mayor of Paris)** scored 70 — she's a politician, not a business contact
- **Ville de Paris** contacts — government entity, likely irrelevant for sales

### Contact Status Distribution

```
status     | count
-----------+------
scored     |    82
rejected   |     4
archived   |    47
enriched   |    54
discovered |    85
```

**Total: 272 contacts**
- 85 stuck at "discovered" (31.3%) — never enriched
- 47 archived (17.3%) — failed enrichment
- 54 enriched but not scored (19.9%) — stuck in pipeline
- 82 scored (30.1%) — made it through
- 4 rejected (1.5%)
- **Only 34 of 272 have emails (12.5%)**

### Contact Funnel Analysis

```
Discovery → Enrichment:    272 → 187 (68.8% pass rate, 85 stuck)
Enrichment → Scored:       187 → 82  (43.9% pass rate)
Has Email:                 34/272    (12.5%)
Effective pipeline yield:  82/272    (30.1%)
```

---

## 10. Summary: Data Quality Degradation Map

### Pipeline Flow with Degradation Points

```
┌─────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Query Generation (strategist.prompt + discovery.prompt)    │
│                                                                     │
│ ⚠️  No validation that LLM follows location/role rules             │
│ ⚠️  Only 15 queries, top 5 results each = max 75 URLs             │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 2: SearXNG Search                                             │
│                                                                     │
│ ⚠️  Only 1 retry on zero results (strip operators only)            │
│ ⚠️  Only 4 search engines configured                               │
│ ⚠️  No per-query engine selection                                  │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 3: Crawl4AI Scraping                                          │
│                                                                     │
│ ⚠️  No retry on failure (content < 100 chars = permanent skip)     │
│ ⚠️  Circuit breaker opens after only 5 failures                    │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 4: LLM Classification & Extraction (120B model)               │
│                                                                     │
│ 🔴 Extracts PAGE domain instead of COMPANY domain                  │
│ 🔴 Person names saved as company names ("Thomas Kurian")           │
│ 🔴 SEC filing format names pass validation ("SYMANTEC CORP (GEN)") │
│ 🔴 "Self-employed" saved as a company                              │
│ ⚠️  "Unknown" string passes name validation (length >= 2)          │
│ ⚠️  Relevance threshold 40 is too lenient                          │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 5: Post-LLM Filters                                           │
│                                                                     │
│ 🔴 No duplicate detection (Armon Dadgar x6, Jooble x3)            │
│ 🔴 No domain validation (Worldline→zoominfo.com)                   │
│ ⚠️  Mega-corp filter only in sales mode                            │
│ ⚠️  21.5% of companies have no location                            │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 6: Enrichment                                                  │
│                                                                     │
│ ⚠️  deepMode flag passed but never implemented                     │
│ ⚠️  Email fast-path bypasses completeness gate entirely            │
│ ⚠️  31.3% of contacts stuck at "discovered" (never enriched)       │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 7: Email Discovery                                             │
│                                                                     │
│ 🔴 Only 1 layer (Generect) — no fallback at all                   │
│ 🔴 12.5% email discovery rate (34/272)                             │
│ 🔴 No retry on API failure                                         │
│ ⚠️  Catch-all emails treated same as verified                      │
│ ⚠️  30-day negative cache blocks re-attempts                       │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│ STAGE 8: Scoring                                                     │
│                                                                     │
│ ⚠️  skillLevels property assumption (potential undefined bug)       │
│ ⚠️  Sparse data inflated to 45-60 range                            │
│ ⚠️  Accessibility rewards email existence regardless of quality     │
└─────────────────────────────────────────────────────────────────────┘
```

### Critical Issues (Must Fix First)

| # | Issue | Stage | Impact |
|---|-------|-------|--------|
| 1 | **Only 1 email layer, 12.5% email rate** | Email Discovery | 87.5% of contacts have no email — cannot be contacted |
| 2 | **No duplicate detection** | Post-LLM Filters | Duplicate contacts waste enrichment budget and outreach slots |
| 3 | **Wrong domain extraction** | LLM Extraction | 6+ companies have wrong domains → wrong email lookups → wasted Generect calls |
| 4 | **Junk company names** | LLM Extraction | Person names, SEC formats, "Self-employed" pollute the company database |

### High Priority Issues

| # | Issue | Stage | Impact |
|---|-------|-------|--------|
| 5 | **deepMode never implemented** | Enrichment | Retries do identical work — retry is pointless |
| 6 | **Email fast-path bypasses quality** | Enrichment | Poorly-enriched contacts with emails go to scoring |
| 7 | **Only 1 retry on zero search results** | SearXNG | Missed companies from failed searches |
| 8 | **skillLevels property bug** | Scoring | Potential "undefined (undefined)" in scoring prompt |
| 9 | **21.5% companies missing location** | LLM Extraction | Location-based filtering ineffective |
| 10 | **31.3% contacts stuck at discovered** | Enrichment | Nearly 1/3 of contacts never progress |

### Medium Priority Issues

| # | Issue | Stage | Impact |
|---|-------|-------|--------|
| 11 | No query validation post-LLM generation | Query Gen | LLM may ignore location/role rules |
| 12 | Conflicting data sources in company-deep prompt | Team Extraction | LLM may use forbidden sources for people |
| 13 | Mega-corp filter only in sales mode | Post-LLM Filters | Mega-corps pollute results |
| 14 | Sparse data scored 45-60 | Scoring | Score inflation for low-quality contacts |
| 15 | Catch-all emails treated same as verified | Email Discovery | False confidence in email reachability |

### Low Priority Issues

| # | Issue | Stage | Impact |
|---|-------|-------|--------|
| 16 | Hardcoded HTTP timeout (15s) | SearXNG | May miss slow engine responses |
| 17 | Crawl4AI circuit breaker threshold too low (5) | Scraping | Temporary blips disable scraping |
| 18 | Proxy credentials in settings.yml | Config | Security concern |
| 19 | SearXNG secret key is placeholder | Config | Security concern |
| 20 | 30-day negative cache for emails | Email Discovery | Blocks re-discovery too long |

---

*End of Diagnostic Report*
