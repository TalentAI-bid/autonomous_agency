# AgentCore Pipeline Diagnosis

Full analysis of how data flows through the agent pipeline, where it breaks, and why enrichment produces shallow or no results.

---

## 1. Pipeline Overview

```
User creates agent → POST /master-agents/:id/start
                          │
                          ▼
              ┌──────────────────────┐
              │   MASTER AGENT       │  Parse mission via LLM (Together AI / DeepSeek-R1)
              │   master-agent.ts    │  Generate 10-15 search queries
              │                      │  Auto-create campaign
              │                      │  Dispatch discovery jobs (staggered 2s apart)
              └──────────┬───────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌─────────────┐ ┌──────────┐ ┌──────────────┐
   │  DISCOVERY   │ │ DISCOVERY│ │ DEEP         │
   │  (query 1)   │ │ (query N)│ │ DISCOVERY    │
   │              │ │          │ │ (structured) │
   └──────┬───────┘ └────┬─────┘ └──────┬───────┘
          │               │              │
          └───────┬───────┘              │
                  ▼                      ▼
         Classify results          discoveryEngine
         via LLM (7 types)         (6 parallel sources)
                  │                      │
                  ├──► candidate_profile ─┼──► DOCUMENT agent (scrape LinkedIn)
                  ├──► company_page ──────┼──► ENRICHMENT agent
                  ├──► team_page ─────────┼──► Scrape → extract members → ENRICHMENT
                  ├──► directory_page ─────┼──► Scrape → extract companies → ENRICHMENT
                  ├──► job_listing ────────┼──► Create opportunity → ENRICHMENT
                  └──► content_with_cos ──┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │   ENRICHMENT AGENT    │
                              │   enrichment.agent.ts │
                              │                       │
                              │  Phase 0: Smart query │
                              │  Phase 1: Source scrape│
                              │  Phase 2: Deep company│
                              │  Phase 3: Email find  │
                              │  Phase 4: LLM synth.  │
                              │  Phase 5: Quality gate│
                              └──────────┬────────────┘
                                         │
                              ┌──────────┼──────────┐
                              ▼          ▼          ▼
                          >= 50%     30-50%      < 30%
                          PASS       RETRY(2x)   ARCHIVE
                              │          │
                              ▼          ▼
                              ┌──────────────────┐
                              │  SCORING AGENT    │  Score 0-100 via LLM
                              │  scoring.agent.ts │  Compare vs requirements
                              └────────┬─────────┘
                                       │
                              ┌────────┼────────┐
                              ▼                 ▼
                         >= threshold      < threshold
                              │                 │
                              ▼                 ▼
                      ┌──────────────┐    REJECTED
                      │  OUTREACH    │
                      │  (Claude AI) │  Generate personalized email
                      └──────┬───────┘
                             │
                             ▼
                      ┌──────────────┐
                      │  REPLY       │  Classify response via LLM
                      └──────┬───────┘
                             │
                             ▼
                      ┌──────────────┐
                      │  ACTION      │  Schedule interview / send report
                      └──────────────┘
```

**Orchestration Loop:** Every 60 seconds, `master-orchestrate` repeatable job runs `MasterAgent.orchestrate()` which checks pipeline metrics and dispatches corrective enrichment jobs if bottlenecks are detected.

---

## 2. How Discovery Works

### 2.1 Standard Discovery (per search query)

Each search query goes through:
1. `searchWeb(query)` → calls SearXNG (`searxng.tool.ts`)
2. Results classified by LLM into 7 types
3. Each type handled differently (scrape, extract, dispatch)

### 2.2 Deep Discovery (structured params)

Uses `discoveryEngine.discoverCompanies()` which fires **6 sources in parallel** with a 120-second timeout:

| # | Source | File | Depends On | What It Does |
|---|--------|------|------------|--------------|
| 1 | Enterprise Registries | `enterprise-registries.ts` | **Direct APIs** (OpenCorporates, Companies House, SEC EDGAR) | Searches government business registries. **Only source that works without SearXNG.** |
| 2 | Business Databases | `business-databases.ts` | **SearXNG** | Site-specific searches: Crunchbase, Wellfound, G2, Glassdoor, ProductHunt, Clutch, Capterra, Trustpilot |
| 3 | Tech Industry | `tech-industry.ts` | **GitHub API** + **SearXNG** | GitHub org search (direct API), StackShare/BuiltWith/Dev.to (SearXNG), HackerNews (Algolia API) |
| 4 | Professional Networks | `professional-networks.ts` | **SearXNG** | LinkedIn company + people search, Twitter/X search |
| 5 | Web Search | `web-search-engine.ts` | **SearXNG** + **Crawl4AI** | Generate diverse queries → search → scrape top 10 URLs → LLM extraction |
| 6 | Reddit Intelligence | `reddit-intelligence.ts` | **Reddit JSON API** + **SearXNG** | Subreddit search, intent scoring via LLM, author profiling |

**Key insight:** 5 out of 6 sources depend on SearXNG. If SearXNG is down, only Enterprise Registries (OpenCorporates/Companies House/SEC) produce results — and these only return basic company names and registration data.

### 2.3 Domain Resolution

After discovering a company name, the pipeline must resolve its website domain before enrichment can scrape pages:

```
1. Check Redis cache: `domain-resolve:{companyName}` (30-day TTL)
2. If cached → return domain (or "NOT_FOUND")
3. If not cached:
   a. Search: "{companyName} official website" via SearXNG
   b. Filter out job boards, social media, directories
   c. If found → cache domain (30 days)
   d. If not found → cache "NOT_FOUND" (7 days)
4. Fallback: search LinkedIn company page, scrape for website URL
```

**Problem:** If domain resolution fails (SearXNG down, or company too obscure), it caches `NOT_FOUND` for 7 days. During those 7 days, every enrichment attempt for that company skips domain-dependent scraping.

---

## 3. How Scraping Works

### 3.1 SearXNG — Web Search Engine (`searxng.tool.ts`)

```
Request: GET {SEARXNG_URL}/search?q={query}&format=json&engines=google,bing,duckduckgo
Timeout: 15 seconds (AbortController)
Cache: 24 hours (Redis key: tenant:{id}:cache:search:{MD5(query)})
Rate Limit: 500 requests/hour per tenant
On Error: returns [] (empty array)
```

**Configured engines:** Google, Bing, DuckDuckGo (hardcoded in query string)

**Two rate limit buckets:**
- `tenant:{id}:ratelimit:search` — general search (500/hr)
- `tenant:{id}:ratelimit:discovery` — discovery-specific (500/hr)

Both buckets are independent, so discovery can do 500 searches AND general search can do 500 more.

### 3.2 Crawl4AI — Page Scraper (`crawl4ai.tool.ts`)

```
Request: POST {CRAWL4AI_URL}/crawl
  Body: { urls: [url], word_count_threshold: 10, extraction_strategy: "NoExtractionStrategy", chunking_strategy: "RegexChunking" }
Timeout: 30 seconds (request) + 30 seconds (async polling: 15 attempts × 2s)
Cache: 7 days (Redis key: tenant:{id}:cache:page:{SHA256(url)})
On Error: returns '' (empty string)
```

**Async mode:** If Crawl4AI returns a `task_id` instead of immediate results, the tool polls every 2 seconds up to 15 times (30 seconds total).

**Critical:** If a page fails to scrape, the **empty result is NOT cached**. But if Crawl4AI returns a completed task with empty content, that empty content IS cached for 7 days.

### 3.3 Together AI — LLM (`together-ai.tool.ts`)

```
Model: deepseek-ai/DeepSeek-R1
Max tokens: 16384
Retry: 3 attempts with exponential backoff (1s, 2s, 4s) on HTTP 429 or 5xx
On Error: THROWS (unlike search/scrape which return empty)
```

`extractJSON<T>()` tries to parse LLM response as JSON, retries up to 3 times with "Output must be valid JSON only" appended.

---

## 4. How Enrichment Works (5 Phases)

### Phase 0: Smart Query Generation
- LLM generates targeted search queries based on company name, contact info, skills
- Fallback: hardcoded templates like `"{companyName} company official website"`

### Phase 1: Multi-Source Data Collection (parallel)

**For recruitment use case (8 sources):**
LinkedIn profile, GitHub repos, Twitter/X, Stack Overflow, blog/portfolio, dev community, company research, additional sources

**For sales use case (6 sources):**
Company homepage, team page, news articles, LinkedIn company, Twitter, industry reports

Each source: `searchWeb()` → get URLs → `scrapeUrl()` → get page content

### Phase 2: Deep Company Enrichment (7+ sub-sources)

Scraped in parallel from company domain:

| Source | URL Pattern | Fallback |
|--------|-------------|----------|
| Homepage | `{domain}` | None |
| About page | `{domain}/about` | Empty |
| Careers page | `{domain}/careers` | Empty |
| Team/Leadership | Try 5 paths: `/team`, `/about/team`, `/people`, `/about-us/team`, `/leadership` | Empty |
| LinkedIn company | Search + scrape | Empty |
| Crunchbase/Funding | Search + scrape, or use search snippet text | Snippet fallback |
| Company news | Search only (5 results), use snippets | Snippets |
| Glassdoor | Search + scrape | Empty |

All scraped content is combined and sent to LLM for synthesis into a `DeepCompanyProfile`:
```typescript
{
  name, domain, industry, size, description, funding,
  linkedinUrl, foundedYear, headquarters, techStack,
  products, keyPeople, competitors, cultureValues,
  openPositions, recentNews
}
```

### Phase 3: Email Discovery
- Search for contact email patterns via DNS MX lookup + SMTP verification
- If company domain unknown → attempt to find it first
- Non-blocking: failure doesn't stop enrichment

### Phase 4: LLM Synthesis
- Merge all collected source content into final profile
- If LLM fails → continues with whatever partial data exists

### Phase 5: Quality Gate

**Data completeness calculation:**
```
Fields checked (9 total):
  name, domain, industry, size, description,
  funding, linkedinUrl, foundedYear, headquarters

dataCompleteness = (filledFields / 9) × 100
```

| Completeness | Decision | Action |
|-------------|----------|--------|
| >= 50% | **PASS** | Dispatch to scoring agent |
| 30-50% | **RETRY** | Re-run enrichment with `deepMode: true` (up to 2 retries), then pass anyway |
| < 30% | **ARCHIVE** | Set status = 'archived', skipReason = 'insufficient_data' |

**Critical flaw:** After 2 retry attempts, contacts at 30-50% are dispatched to scoring regardless. Once marked `'enriched'`, they are **never revisited**.

---

## 5. All Rate Limits

| Component | Redis Key | Max | Window | What Happens When Hit |
|-----------|----------|-----|--------|-----------------------|
| SearXNG search | `tenant:{tid}:ratelimit:search` | 500 | 1 hour | Returns `[]` silently |
| SearXNG discovery | `tenant:{tid}:ratelimit:discovery` | 500 | 1 hour | Returns `[]` silently |
| Reddit API | `tenant:{tid}:ratelimit:reddit` | 200 | 1 hour | Returns `[]` silently |
| GitHub API | (checked inline via API headers) | Skip if < 10 remaining | N/A | Skips GitHub source |
| Email sending | `tenant:{tid}:ratelimit:email:{from}` | 50/day | 24 hours | Email not sent |

**Impact of hitting SearXNG 500/hr limit:**
- Each discovery query → 1 SearXNG call
- Each classification might trigger follow-up searches
- Deep discovery fires 6 sources, each making 5-20 SearXNG calls
- **A single deep discovery run can use 100+ SearXNG calls**
- With 15 initial queries + deep discovery: ~300-500 calls in first batch
- **Rate limit likely hit within first 30-60 minutes of agent run**

---

## 6. All Cache TTLs

| Redis Key Pattern | TTL | What's Cached | Risk |
|-------------------|-----|---------------|------|
| `tenant:{tid}:cache:search:{MD5(query)}` | **24 hours** | SearXNG search results | Stale results for a day |
| `tenant:{tid}:cache:page:{SHA256(url)}` | **7 days** | Crawl4AI scraped page content | Empty pages cached for a week |
| `discovery:plan:{MD5(params)}` | **12 hours** | Full discovery engine results | Same results on re-run within 12h |
| `discovery:company:{domain}` | **30 days** | Individual company from discovery | Company data frozen for a month |
| `discovery:registry:global:opencorp:{MD5(q)}` | **90 days** | OpenCorporates API results | New companies invisible for 3 months |
| `discovery:registry:global:companieshouse:{MD5(q)}` | **90 days** | Companies House API results | Same |
| `discovery:registry:global:edgar:{MD5(q)}` | **90 days** | SEC EDGAR results | Same |
| `discovery:github:org:{MD5(query)}` | **7 days** | GitHub org search results | Stale for a week |
| `tenant:{tid}:cache:reddit:{MD5(q:sub:sort)}` | **6 hours** | Reddit JSON API results | Refreshes fastest |
| `tenant:{tid}:cache:reddit-author:{username}` | **24 hours** | Reddit author profile | Stale for a day |
| `domain-resolve:{companyName.toLowerCase()}` | **30 days** (found) / **7 days** (NOT_FOUND) | Company domain resolution | Failed lookups block enrichment for 7 days |
| `agent-status:{masterAgentId}:{agentType}` | **5 minutes** | Current agent action display | Short-lived, OK |
| `tenant:{tid}:memory:{key}` | **24 hours** | Arbitrary agent state | Resets daily |

### Cache Poisoning Scenarios

**Scenario A: Empty page cached**
1. Crawl4AI scrapes `https://acme.com/about` → returns empty (site temporarily down)
2. Empty result cached for 7 days
3. Next enrichment attempt reads empty cache → no about page data
4. Company stays incomplete for a week

**Scenario B: NOT_FOUND domain cached**
1. Discovery finds "TechStartup Inc" from a directory page
2. Domain resolution search returns no results (company is new, no website indexed yet)
3. `NOT_FOUND` cached for 7 days
4. All enrichment for this company skips website-based sources for 7 days

**Scenario C: Discovery plan cached**
1. Run agent with mission "Find AI startups in London"
2. Discovery engine returns 50 companies, plan cached for 12 hours
3. User re-runs agent 2 hours later → gets same 50 companies from cache
4. No new companies discovered until cache expires

---

## 7. Silent Failure Points

Every place where an error is caught and returns empty instead of propagating:

### searxng.tool.ts
| Line | Function | On Error | Returns |
|------|----------|----------|---------|
| 72-84 | `search()` | Connection failed, timeout, HTTP error | `[]` (empty array) |
| 134-146 | `searchDiscovery()` | Same | `[]` (empty array) |

After the fix (one-time warning pattern), the **first** failure logs at ERROR level. All subsequent failures log at DEBUG level only.

### crawl4ai.tool.ts
| Line | Function | On Error | Returns |
|------|----------|----------|---------|
| 52-54 | `scrape()` | HTTP error from initial POST | `''` (empty string) |
| 69 | `scrape()` | No task_id in response | `''` |
| 83-85 | `scrape()` | Polling error (per attempt) | Continues polling |
| 88 | `scrape()` | All poll attempts exhausted | `''` |
| 89-101 | `scrape()` | Connection failed, timeout | `''` |

### discovery-sources/*.ts
| File | On Error | Returns |
|------|----------|---------|
| `web-search-engine.ts:119-123` | Search query fails | `[]` for that query |
| `web-search-engine.ts:154-156` | URL scraping fails | Partial results (search-only) |
| `business-databases.ts:122-124` | Per-site search fails | `[]` for that site |
| `enterprise-registries.ts:80-83` | OpenCorporates API fails | `[]` |
| `enterprise-registries.ts:133-136` | Companies House fails | `[]` |
| `enterprise-registries.ts:181-184` | SEC EDGAR fails | `[]` |
| `tech-industry.ts:95-97` | GitHub member fetch fails | Skip member |
| `professional-networks.ts:44-47` | LinkedIn search fails | `[]` |
| `reddit-intelligence.ts:293-295` | Intent scoring LLM fails | Batch of posts dropped |

### enrichment.agent.ts
| Phase | On Error | Impact |
|-------|----------|--------|
| Phase 0 (query gen) | LLM fails → use hardcoded fallback templates | Generic queries, may find wrong companies |
| Phase 1 (source scrape) | Promise.allSettled → log, continue | Source content stays `''` |
| Phase 2 (deep company) | LLM synthesis fails → `null` profile | Company saved with name only |
| Phase 3 (email) | Domain lookup fails → skip email | No email discovered |
| Phase 4 (contact LLM) | LLM fails → `null` profile | Contact has no synthesized data |
| Phase 5 (quality gate) | N/A | Determines pass/retry/archive |

### base-agent.ts
| Method | On Error | Returns |
|--------|----------|---------|
| `searchWeb()` | Delegates to searxng → `[]` | Empty array |
| `scrapeUrl()` | Delegates to crawl4ai → `''` | Empty string |
| `extractJSON()` | 3 retries → throws | **Actually throws** (caught by caller) |
| `saveOrUpdateCompany()` | Validates name only | Saves with all other fields empty |

---

## 8. Why Data is Not Deep — Root Causes

### Cause 1: External Services Not Running
SearXNG (`:8888`) and Crawl4AI (`:11235`) must be running as Docker containers. If they're not:
- **All web searches return `[]`** — 5 of 6 discovery sources fail
- **All page scraping returns `''`** — enrichment gets zero page content
- **Only Enterprise Registries work** — just basic company names from government databases
- **Result:** Companies discovered with name only, no enrichment data at all

**How to check:**
```bash
curl http://localhost:8888/search?q=test&format=json  # SearXNG
curl http://localhost:11235/health                      # Crawl4AI
curl http://localhost:4000/api/health/services          # All services
```

### Cause 2: Rate Limits Exhausted Silently
After 500 SearXNG calls per hour (shared across all agents for a tenant):
- Every `searchWeb()` call returns `[]` immediately
- No alert, no dashboard notification
- Agents continue "working" but find nothing
- Rate limit counter resets after 1 hour

**How to check:**
```bash
redis-cli GET "tenant:{TENANT_ID}:ratelimit:search"
redis-cli GET "tenant:{TENANT_ID}:ratelimit:discovery"
redis-cli TTL "tenant:{TENANT_ID}:ratelimit:search"
```

### Cause 3: Shallow Quality Gate
Only 9 fields are checked for data completeness:
```
name, domain, industry, size, description,
funding, linkedinUrl, foundedYear, headquarters
```

Missing from the check: `techStack`, `products`, `keyPeople`, `competitors`, `cultureValues`, `openPositions`, `recentNews`

A company with just `name + industry + size` = 33% → passes as "enriched" (above 30% threshold). Dashboard shows it as "partial" but it has almost no useful data.

### Cause 4: LLM Receives Empty Content
When SearXNG/Crawl4AI fail, the LLM synthesis receives empty strings for all 7+ sources:
```
Homepage content: ""
About page content: ""
Careers page content: ""
Team page content: ""
LinkedIn content: ""
Crunchbase content: ""
News content: ""
Glassdoor content: ""
```

The LLM tries its best but can only return `{ name: "CompanyX" }` with empty fields. This gets saved to the database as-is.

### Cause 5: Once Enriched, Never Revisited
The enrichment pipeline marks contacts/companies as `'enriched'` after the quality gate, even with poor data. There is **no mechanism to re-enrich** a contact unless:
- The master-orchestrate loop detects `dataCompleteness < 70%` AND `discovered > 50 AND enriched < 10` (very specific conditions)
- Manual re-trigger via API

Once the pipeline moves past enrichment, companies stay with whatever data they had.

### Cause 6: Domain Resolution Failures Cascade
If a company's website domain can't be resolved:
1. `NOT_FOUND` cached for 7 days
2. Enrichment Phase 2 skips ALL website-based sources (homepage, about, careers, team, Glassdoor)
3. Only LinkedIn and Crunchbase search-based sources attempted
4. Data completeness drops to ~20-30%
5. Company archived or barely passes quality gate

### Cause 7: Stale Caches Serve Old/Empty Data
- **7-day page cache:** If Crawl4AI was down when a URL was first scraped, subsequent attempts return the same empty cache for a week
- **30-day company cache:** Company data from discovery engine frozen for a month
- **90-day registry cache:** OpenCorporates/Companies House results stale for 3 months
- **No cache invalidation mechanism** exists

---

## 9. Why Data Stops Flowing After Initial Success

### Scenario A: Rate Limit Wall (Most Likely)

```
Timeline:
  T+0min:   Agent starts, generates 15 search queries
  T+1min:   Discovery fires queries → ~15 SearXNG calls
  T+2min:   Results classified, team pages scraped → ~30 SearXNG calls
  T+3min:   Deep discovery starts → 6 sources × 10-20 calls each → ~100 SearXNG calls
  T+5min:   Domain resolution for 30 companies → ~30 SearXNG calls
  T+8min:   Enrichment starts for first 10 companies → ~50 SearXNG calls each
  T+15min:  ~500+ SearXNG calls made → RATE LIMIT HIT
  T+15min+: All subsequent searches return [] silently
  T+60min:  Rate limit resets, but discovery queries are already dispatched and completed
  T+61min:  Orchestrate loop runs, sees all companies enriched (poorly), no new discoveries

  Result: 30-50 companies discovered with partial data, pipeline stalls
```

### Scenario B: Service Goes Down Mid-Run

```
Timeline:
  T+0min:   Agent starts, SearXNG + Crawl4AI running
  T+10min:  First batch of companies discovered and enriched (good data)
  T+20min:  Crawl4AI container crashes (OOM, Docker restart, etc.)
  T+21min:  Enrichment agent scrapes return '' for all pages
  T+22min:  LLM synthesis gets empty content → returns name-only profiles
  T+25min:  Quality gate: 11% completeness → ARCHIVE
  T+30min:  All new contacts archived, pipeline appears stuck
  T+35min:  Crawl4AI recovers, but contacts already marked as archived
  T+60min:  Orchestrate loop finds no unenriched contacts, takes no action

  Result: First 10 companies have rich data, next 40 have nothing
```

### Scenario C: Cache Poisoning

```
Timeline:
  Day 1:    Agent runs, discovers 50 companies, enriches successfully
  Day 1+2h: User re-runs agent with same mission
  Day 1+2h: Discovery plan cached (12h) → returns same 50 companies
  Day 1+2h: All 50 companies already in DB → deduplication skips them
  Day 1+2h: No new enrichment dispatched
  Day 2:    Plan cache expires, but enterprise registry cache (90d) still active
  Day 2:    Same registry results → same companies → no new discoveries
  Day 30+:  Company domain cache (30d) expires
  Day 90:   Enterprise registry cache expires → first truly fresh results

  Result: Same 50 companies for months, no new discoveries
```

### Scenario D: Redis Connection Pool Exhaustion

```
Timeline:
  T+0:      Worker process starts, creates 13 workers (13 Redis connections)
  T+0:      Each worker handler calls createRedisConnection() in tools (searxng, crawl4ai)
  T+0:      Additional connections from discovery-engine, redis pub/sub
  T+10min:  ~50 active Redis connections per tenant
  T+1h:     Multiple tenants active → 200+ connections
  T+2h:     Redis maxclients hit (default 10000, but may be lower)
  T+2h:     New connections refused → workers can't process jobs
  T+2h:     BullMQ jobs timeout → retried → more connection attempts → cascading failure

  Result: All workers stop processing, entire pipeline halts
```

### Scenario E: Master-Orchestrate Job Stops Running

```
Timeline:
  T+0:      Agent started, repeatable job scheduled every 60s
  T+5min:   Orchestrate job fails (DB connection error, LLM timeout)
  T+5min:   BullMQ retries with backoff (5s, 10s, 20s) — 3 attempts
  T+6min:   All retries exhausted → job sent to dead letter queue
  T+6min:   Repeatable job removed by BullMQ (no more 60s triggers)
  T+7min+:  No orchestration running → no bottleneck detection
  T+forever: Pipeline never self-corrects, stalls permanently

  Result: Pipeline produces initial batch then stops forever
```

---

## 10. Diagnostic Commands

### Check Service Health
```bash
# All services at once (unauthenticated endpoint)
curl http://localhost:4000/api/health/services | jq .

# Individual services
curl http://localhost:8888/search?q=test&format=json  # SearXNG
curl http://localhost:11235/health                      # Crawl4AI
redis-cli ping                                          # Redis
psql $DATABASE_URL -c "SELECT 1"                       # PostgreSQL
```

### Check Rate Limits
```bash
# Current SearXNG usage (resets hourly)
redis-cli GET "tenant:{TENANT_ID}:ratelimit:search"
redis-cli GET "tenant:{TENANT_ID}:ratelimit:discovery"
redis-cli TTL "tenant:{TENANT_ID}:ratelimit:search"

# Reddit usage
redis-cli GET "tenant:{TENANT_ID}:ratelimit:reddit"
```

### Check Queue Status
```bash
# Via API (requires auth token)
curl -H "Authorization: Bearer {TOKEN}" http://localhost:4000/api/agents/status | jq .

# Direct Redis — count jobs per queue
redis-cli KEYS "bull:tenant-{TENANT_ID}-discovery:*" | wc -l
redis-cli KEYS "bull:tenant-{TENANT_ID}-enrichment:*" | wc -l
```

### Check Pipeline Metrics
```bash
# Contact status distribution
psql $DATABASE_URL -c "
  SET app.current_tenant_id = '{TENANT_ID}';
  SELECT status, COUNT(*) FROM contacts GROUP BY status ORDER BY COUNT(*) DESC;
"

# Company enrichment status
psql $DATABASE_URL -c "
  SET app.current_tenant_id = '{TENANT_ID}';
  SELECT
    CASE
      WHEN COALESCE(data_completeness, 0) >= 70 THEN 'complete'
      WHEN COALESCE(data_completeness, 0) >= 30 THEN 'partial'
      ELSE 'minimal'
    END as enrichment_status,
    COUNT(*)
  FROM companies
  GROUP BY 1;
"

# Agent task success/failure rates
psql $DATABASE_URL -c "
  SET app.current_tenant_id = '{TENANT_ID}';
  SELECT agent_type, status, COUNT(*)
  FROM agent_tasks
  WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY agent_type, status
  ORDER BY agent_type, status;
"

# Recent errors
psql $DATABASE_URL -c "
  SET app.current_tenant_id = '{TENANT_ID}';
  SELECT agent_type, error, created_at
  FROM agent_tasks
  WHERE status = 'failed'
  ORDER BY created_at DESC
  LIMIT 20;
"
```

### Check Caches
```bash
# Count cached search results
redis-cli KEYS "tenant:{TENANT_ID}:cache:search:*" | wc -l

# Count cached pages
redis-cli KEYS "tenant:{TENANT_ID}:cache:page:*" | wc -l

# Check specific domain resolution
redis-cli GET "domain-resolve:acme inc"

# Count discovery plan caches
redis-cli KEYS "discovery:plan:*" | wc -l

# Flush specific cache (careful!)
redis-cli DEL "discovery:plan:{HASH}"
```

### Check Worker Logs (PM2)
```bash
# Live logs
pm2 logs agentcore-workers --lines 100

# Filter for errors
pm2 logs agentcore-workers --lines 500 | grep -i "error\|warn\|unreachable\|failed"

# Check if orchestration is running
pm2 logs agentcore-workers --lines 200 | grep "orchestrat"
```

---

## 11. Fix Recommendations (Prioritized)

### P0 — Critical (Must Fix)

| # | Fix | Impact |
|---|-----|--------|
| 1 | **Ensure SearXNG + Crawl4AI are running** via `pm2 start ecosystem.config.cjs` | Unblocks entire pipeline |
| 2 | **Check `/api/health/services` after restart** to verify all services reachable | Confirms fix |
| 3 | **Flush stale caches** if services were down: `redis-cli KEYS "tenant:*:cache:*" \| xargs redis-cli DEL` | Removes empty cached results |

### P1 — High Priority

| # | Fix | Why |
|---|-----|-----|
| 4 | **Lower cache TTLs**: domain resolution 7d→3d, discovery plan 12h→4h, enterprise registries 90d→14d | Fresh data more often |
| 5 | **Don't cache empty scrape results**: In `crawl4ai.tool.ts`, only cache if content.length > 100 | Prevents empty-page cache poisoning |
| 6 | **Raise rate limit or add per-source buckets**: 500/hr shared across ALL sources is too low for deep discovery | Prevents silent rate limit wall |
| 7 | **Add rate limit approaching alerts**: At 80% of limit, emit WARNING event visible in dashboard | Early warning before pipeline stalls |

### P2 — Medium Priority

| # | Fix | Why |
|---|-----|-----|
| 8 | **Add more fields to completeness check**: Include techStack, products, keyPeople, competitors (16 fields instead of 9) | More accurate quality assessment |
| 9 | **Raise quality gate to 40% minimum** (from 30%) | Fewer empty-enriched companies |
| 10 | **Add re-enrichment mechanism**: If `dataCompleteness < 50%` after 24h, re-dispatch to enrichment | Companies don't stay incomplete forever |
| 11 | **Circuit breaker for SearXNG/Crawl4AI**: After 5 consecutive failures, pause discovery for 5 min, alert user | Prevents wasting rate limit on dead service |
| 12 | **Dead letter handler should update task status**: Currently only logs, should set `agent_tasks.status = 'dead_letter'` | User can see failed jobs in dashboard |

### P3 — Nice to Have

| # | Fix | Why |
|---|-----|-----|
| 13 | **Pool Redis connections**: Use shared connection pool instead of per-worker connections | Prevents connection exhaustion |
| 14 | **Add cache-bust endpoint**: `DELETE /api/cache/flush?type=discovery&tenantId=X` | Manual cache invalidation |
| 15 | **Orchestrator should detect service outages**: If last 10 enrichments all < 20% completeness, pause and alert | Prevents mass-archiving during outage |
| 16 | **Add per-agent-run rate limit tracking**: Show in dashboard "Used 450/500 SearXNG calls this hour" | User visibility into rate limits |

---

## 12. Quick Reference — File Locations

| Component | File | Key Lines |
|-----------|------|-----------|
| Master agent orchestrator | `src/agents/master-agent.ts` | `execute()` :16, `orchestrate()` :384 |
| Discovery agent | `src/agents/discovery.agent.ts` | `execute()` :32, `executeDeepDiscovery()` :196 |
| Enrichment agent | `src/agents/enrichment.agent.ts` | 5 phases :77-640, quality gate :529 |
| Scoring agent | `src/agents/scoring.agent.ts` | Score calc :65, threshold :139 |
| Base agent (shared) | `src/agents/base-agent.ts` | `searchWeb()` :46, `scrapeUrl()` :50, `saveOrUpdateCompany()` :145 |
| SearXNG tool | `src/tools/searxng.tool.ts` | Rate limit :44, cache :60, error :72 |
| Crawl4AI tool | `src/tools/crawl4ai.tool.ts` | Cache :48, polling :71, error :89 |
| Together AI tool | `src/tools/together-ai.tool.ts` | Retry :25, model :18 |
| Discovery engine | `src/tools/discovery-engine.ts` | 6 sources :39-54, timeout :23, cache :68 |
| Queue config | `src/queues/queues.ts` | Concurrency, retries, cleanup |
| Worker scheduling | `src/queues/workers.ts` | Orchestrate job :95, startup check :162 |
| Health endpoint | `src/index.ts` | `/api/health/services` :88 |
| Company schema | `src/db/schema/companies.ts` | All columns |
| Company routes | `src/routes/company.routes.ts` | Filter `dataCompleteness >= 30` :33 |
| Activity routes | `src/routes/activity.routes.ts` | Feed/stats/dashboard endpoints |
