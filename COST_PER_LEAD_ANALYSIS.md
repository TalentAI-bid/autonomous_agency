# Cost per verified lead — current stack (DeepSeek/Bedrock) vs Claude

_Generated 2026-08-04. Numbers are a model, not a bill — the code tracks tokens but has **no** pricing logic, so all `$` figures below are computed from external per-token rates and stated token assumptions. See "How to make this exact" at the end._

---

## TL;DR

A **verified lead** = one contact that gets enriched, buyer‑fit scored, email‑verified (Reacher), and drafted a first cold email. That's ~5 LLM completions plus 1–12 SMTP probes.

| Cost component (per verified lead) | Current stack (Bedrock) | If Claude Sonnet 5 | If Claude Opus 5 |
|---|--:|--:|--:|
| **LLM** (enrich + score + draft + amortized run overhead) | **~$0.024** | **~$0.17** | **~$0.28** |
| Email verification (Reacher) — marginal | ~$0.00 (fixed server) | ~$0.00 | ~$0.00 |
| **LLM only, per lead** | **~2.4¢** | **~17¢** | **~28¢** |

Switching the LLM layer to Claude is roughly **7× (Sonnet)** to **12× (Opus)** more expensive per lead — but even the Opus case is <30¢/lead. The LLM is **not** the dominant cost at low volume; fixed infrastructure is.

**Fully‑loaded** (LLM + fixed infra amortized), see the volume table below — realistically **4¢–11¢/lead** on the current stack depending on volume.

---

## 1. What one verified lead actually consumes

All LLM traffic goes through **AWS Bedrock's OpenAI‑compatible endpoint** (`bedrock-runtime.us-west-2/openai/v1/...`) via `agentcore/src/tools/together-ai.tool.ts` — the file name is misleading; Together/OpenAI/Anthropic direct APIs are **not** used (`CLAUDE_API_KEY`, `TOGETHER_API_KEY` are dead env vars).

**Models in play (all billed via Bedrock):**

| Role | Model constant | Where |
|---|---|---|
| Default / "fast" | `openai.gpt-oss-120b-1:0` | together-ai.tool.ts:18 |
| SMART (reasoning) | `deepseek.v3.2` | together-ai.tool.ts:19 |
| Cold email + inbox copilot | `moonshotai.kimi-k2.5` | env.ts:20 |
| Vision (GMaps menu OCR only — not core lead path) | `us.amazon.nova-lite-v1:0` | env.ts:24 |

**LLM calls to take one contact to a sent‑ready first touch (~5 completions):**

| # | Step | Cardinality | Model | File |
|---|---|---|---|---|
| A | Enrichment — company deep‑profile | per contact | deepseek.v3.2 | enrichment.agent.ts:411 |
| B | Enrichment — profile synthesis | per contact | gpt-oss-120b | enrichment.agent.ts:833 |
| C | Buyer‑fit scoring | per company (amortized) | deepseek.v3.2 | buyer-fit-score.service.ts:337 |
| D | Cold email draft (+1 retry) | per contact | kimi-k2.5 | cold-email-drafter.service.ts:164 |
| — | Run overhead (strategy + company/candidate finders + discovery extraction), amortized across all leads in the run | per run ÷ leads | mostly deepseek.v3.2 | strategist.agent.ts:839, company-finder.agent.ts, discovery.agent.ts:704 |

**Not counted in "verified lead"** (these are ongoing‑outreach costs, not lead creation): follow‑up content, inbound‑reply analysis, inbox copilot (2–3 calls/reply). If you take a lead through a full reply+follow‑up cycle, add roughly another 2–4 completions of similar size — see §5.

**Email verification (Reacher):** self‑hosted, `POST /v0/check_email` at `http://173.212.232.243:8070` (a bare VPS IP, env.ts:42). **No per‑call billing** — it's a flat server cost. Throughput is capped at **600 checks/day** (`MAX_DAILY_EMAIL_CHECKS`, email-finder.tool.ts:23). Per lead: 1 check on a known‑pattern domain, up to ~12 SMTP probes on a new domain, 0 on catch‑all domains.

---

## 2. Token assumptions (the soft part — adjust these)

These drive every `$` below. They're reasonable mid‑range estimates for prompts that carry scraped LinkedIn/company context; **the platform already counts real tokens** (see §7) so you can replace them with actuals.

| Call | Model role | Input tok | Output tok | Notes |
|---|---|--:|--:|---|
| A deep‑profile | SMART | 8,000 | 2,000 | **raw scraped homepage/team/LinkedIn pages injected** — the heavy call; output cap is 16,384 |
| B synthesis | default | 6,000 | 1,500 | multi‑source scraped snippets |
| C fit score | SMART | 4,000 | 1,000 | per company; counted full (conservative) |
| D email draft | email | 3,000 | 500 | output capped at 600; ×1.3 for the retry path |
| Overhead | SMART | 3,000 | 1,000 | company‑finder injects raw scraped pages; run cost ÷ ~40 leads/run |

⚠️ **Sensitivity — inputs, not outputs, are the driver.** The enrichment and company‑finder DeepSeek calls pass **full scraped web pages** into the prompt (confirmed in `extractJSON`, default 16,384 output cap). If a page is fat (10–20k input tokens), call A alone can double. Because DeepSeek input is $0.62/1M vs Sonnet's $3/1M, big inputs hurt the Claude scenario ~5× more than the current one. These are mid‑range estimates; use §7 to replace with actuals.

---

## 3. Per‑token prices used

**Current stack — AWS Bedrock (per 1M tokens, input / output):**

| Model | Input | Output | Source |
|---|--:|--:|---|
| gpt-oss-120b | $0.15 | $0.60 | Bedrock pricing (Aug 2026) |
| deepseek.v3.2 | $0.62 | $1.85 | Bedrock pricing (Aug 2026) |
| kimi-k2.5 | $0.72 | $3.60 | Bedrock pricing (Aug 2026) |
| nova-lite | $0.06 | $0.24 | Bedrock pricing |

**Claude (first‑party Anthropic rates; Bedrock Claude is partner‑priced and close):**

| Model | Input | Output |
|---|--:|--:|
| Claude Opus 5 | $5.00 | $25.00 |
| Claude Sonnet 5 | $3.00 | $15.00 (intro $2/$10 through 2026‑08‑31) |
| Claude Haiku 4.5 | $1.00 | $5.00 |

---

## 4. LLM cost per verified lead — worked

### Current stack (DeepSeek + gpt-oss + Kimi via Bedrock)

| Call | Model | Cost |
|---|---|--:|
| A deep‑profile | deepseek.v3.2 | $0.00866 |
| B synthesis | gpt-oss-120b | $0.00180 |
| C fit score | deepseek.v3.2 | $0.00433 |
| D email draft ×1.3 | kimi-k2.5 | $0.00515 |
| Overhead | deepseek.v3.2 | $0.00371 |
| **Total** | | **≈ $0.024 / lead (~2.4¢)** |

### If the same pipeline ran on Claude Sonnet 5

| Call | Cost |
|---|--:|
| A deep‑profile | $0.0540 |
| B synthesis | $0.0405 |
| C fit score | $0.0270 |
| D email draft ×1.3 | $0.0215 |
| Overhead | $0.0240 |
| **Total** | **≈ $0.167 / lead (~17¢)** |

### If the same pipeline ran on Claude Opus 5

Opus scales uniformly at ~1.67× Sonnet (both input and output): **≈ $0.28 / lead (~28¢)**.

> **Realistic mixed Claude setup** (Haiku 4.5 for scoring, Sonnet 5 for enrichment/email) lands ~35–40% below the all‑Sonnet number, i.e. **~10¢/lead**. Anthropic's own guidance is Opus for hard reasoning, Sonnet/Haiku for high‑volume — a lead pipeline is high‑volume, so Haiku/Sonnet is the right comparison, not Opus.

**Bottom line, LLM only:** current ≈ **2.4¢**, Claude Sonnet ≈ **17¢** (~7×), Claude Opus ≈ **28¢** (~12×).

---

## 5. Full outreach lifecycle (optional add‑on)

If you cost a lead through a reply + follow‑up cycle, add per lead:

| Step | Model (current) | ~Calls |
|---|---|--:|
| Follow‑up content | deepseek.v3.2 | 1–2 |
| Inbound reply analysis | gpt-oss-120b | 1 per reply |
| Inbox copilot (classify + draft + retry) | kimi-k2.5 | 2–3 per reply draft |

Roughly **doubles** the LLM cost of an *engaged* lead: current ≈ 5¢, Sonnet ≈ 34¢, Opus ≈ 56¢. Most leads never reply, so the blended lifecycle number is much closer to the first‑touch figure.

---

## 6. Non‑LLM & fully‑loaded cost

The LLM is small. Real fixed costs:

| Item | Cost | Notes |
|---|--:|---|
| Reacher server | **~$4/mo** | flat VPS; capped 600 checks/day ⇒ up to ~18k checks/mo |
| App infra (agentcore API + workers + Redis + Postgres + dashboard) | **~$30–60/mo** _(placeholder — insert your real bill)_ | fixed regardless of lead volume |
| LinkedIn/Google‑Maps scraping | **~$0 marginal** | runs **client‑side in the user's Chrome extension** (no LinkedIn API, no Voyager) — the browser does the work, so there's no per‑scrape cloud or API fee. The real limit is the extension's own daily rate caps, not cost. |

**Blended cost per lead** (LLM + ~$44/mo fixed infra assumed):

| Leads / month | Current stack | Claude Sonnet 5 | Claude Opus 5 |
|--:|--:|--:|--:|
| 500 | ~$0.11 | ~$0.26 | ~$0.37 |
| 1,500 | ~$0.053 | ~$0.20 | ~$0.31 |
| 3,000 | ~$0.039 | ~$0.18 | ~$0.30 |

At low volume, **fixed infra dominates and the LLM choice barely matters**. At scale, the LLM choice is the swing factor — but current stack stays ~4¢ and even Opus stays ~30¢.

> **Throughput reality:** a "verified lead" needs LinkedIn data, which the **Chrome extension** scrapes client‑side (no LinkedIn API). The ceiling is the extension's own per‑account daily rate caps — server‑authoritative `EXTENSION_SITE_LIMITS`, mirrored in `extension/lib/rate-limiter.js`:
>
> | Action | Cap/day | Pacing |
> |---|--:|--:|
> | LinkedIn `fetch_profile` | 100 | 8s |
> | LinkedIn `fetch_company` | 100 | 8s |
> | LinkedIn `search_people` | 80 | 4s |
> | LinkedIn `search_companies` | 30 | 4s |
> | GMaps `fetch_business` | 200 | 2s |
> | GMaps `search_businesses` | 20 | 2s |
>
> These per‑account caps — not LLM cost and not the 600/day Reacher cap — are the true ceiling: at ~100 profile fetches/day, one connected extension caps out around **~2,000–3,000 verified leads/month**. The stand‑alone self‑hosted Voyager service (`173.212.232.243:8072`, 80/day) exists in the repo but is wired only to the manual `linkedin.agent`/`/linkedin` routes — it is **not** in the enrichment/finder lead pipeline.

---

## 7. How to make this exact (no more estimates)

The code **already tracks tokens** — it just never prices them:

- `together-ai.tool.ts:87 / :169 / :283` does `redis.incrby('tenant:{id}:usage:bedrock:tokens', prompt+completion)`.

To get real dollars:
1. Split that counter **per model** (currently input+output are summed into one key with no model tag).
2. Add a price map keyed by the four model IDs (§3 rates) and multiply.
3. Divide by leads produced (count of contacts reaching each stage) for a true per‑lead figure.

That converts the existing telemetry into an exact cost dashboard — and lets you A/B the current stack vs a Claude tier on live traffic instead of the modeled numbers here.

---

## Sources

- [AWS Bedrock — DeepSeek V3.2 pricing ($0.62/$1.85)](https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/bedrock/model/deepseek.v3.2)
- [AWS Bedrock — gpt-oss-120b pricing ($0.15/$0.60)](https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/bedrock/model/openai.gpt-oss-120b-1-0)
- [AWS Bedrock — Kimi K2.5 pricing ($0.72/$3.60)](https://www.getmaxim.ai/bifrost/llm-cost-calculator/provider/bedrock/model/moonshotai.kimi-k2.5)
- [Amazon Bedrock pricing (official)](https://aws.amazon.com/bedrock/pricing/)
- Claude rates: Anthropic first‑party pricing (Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5).
