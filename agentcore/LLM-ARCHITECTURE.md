# AgentCore LLM Architecture

All LLM calls in AgentCore go through **AWS Bedrock** via an OpenAI-compatible endpoint.

---

## Provider

| Setting | Value |
|---------|-------|
| Provider | AWS Bedrock |
| Endpoint | `https://bedrock-runtime.{region}.amazonaws.com/openai/v1/chat/completions` |
| Auth | `AWS_BEARER_TOKEN_BEDROCK` (Bearer token) |
| Region | `AWS_BEDROCK_REGION` (default: `us-east-1`) |
| Protocol | OpenAI-compatible `/v1/chat/completions` |

## 3 Model Tiers

| Tier | Model ID | Use |
|------|----------|-----|
| **DEFAULT** (120B) | `openai.gpt-oss-120b-1:0` | General extraction, scoring, enrichment synthesis |
| **SMART** (DeepSeek) | `deepseek.v3.2` | Complex reasoning: emails, strategy, replies |
| **FAST** (20B) | `openai.gpt-oss-20b-1:0` | Lightweight: discovery page classification only |

## Call Architecture

```
Any Agent
  └─► base-agent.ts
        ├─► callTogether(messages)       → together-ai.tool.ts → complete(model=DEFAULT)  → callAPI() → Bedrock
        ├─► callClaude(system, user)     → claude.tool.ts       → complete(model=SMART)    → callAPI() → Bedrock
        └─► extractJSON<T>(messages)     → together-ai.tool.ts → extractJSON(model=...)    → callAPI() → Bedrock
```

**All roads lead to a single `callAPI()` function** in `src/tools/together-ai.tool.ts` that calls Bedrock.

The file is named `together-ai.tool.ts` because it was originally Together AI — it was migrated to Bedrock but kept the filename.

## Which Agent Uses Which Model

| Agent | File | Method | Model | Temp | Purpose |
|-------|------|--------|-------|------|---------|
| Master | `master-agent.ts` | `extractJSON()` | DEFAULT | 0.7 | Parse mission requirements |
| Master | `master-agent.ts` | `extractJSON()` | DEFAULT | 0.7 | Generate search queries |
| Discovery | `discovery.agent.ts` | `extractJSON()` | **FAST** | **0** | Classify page types (7 categories) |
| Document | `document.agent.ts` | `extractJSON()` | DEFAULT | 0.7 | Extract CV / job spec data |
| Enrichment | `enrichment.agent.ts` | `extractJSON()` ×4 | DEFAULT | 0.7 | Smart queries, company profiles, candidate profiles, email synthesis |
| Scoring | `scoring.agent.ts` | `extractJSON()` | DEFAULT | 0.7 | Score contact fit 0-100 |
| Outreach | `outreach.agent.ts` | `callClaude()` | **SMART** | 0.7 | Generate personalized outreach emails |
| Reply | `reply.agent.ts` | `callClaude()` | **SMART** | 0.7 | Generate auto-responses to inbound |
| Reply | `reply.agent.ts` | `extractJSON()` | DEFAULT | 0.7 | Classify reply intent |
| Action | `action.agent.ts` | `callTogether()` | DEFAULT | 0.7 | Generate candidate reports |
| Strategist | `strategist.agent.ts` | `extractJSON()` | **SMART** | **0.4** | Generate sales strategy |
| Strategy | `strategy.agent.ts` | `extractJSON()` | DEFAULT | 0.7 | Strategy evaluation |
| Mailbox | `mailbox.agent.ts` | `extractJSON()` ×2 | DEFAULT | 0.7 | Thread summarization, email analysis |

### Discovery Tools (also use LLM)

| Tool | File | Model | Purpose |
|------|------|-------|---------|
| Page Scraper | `discovery-sources/page-scraper.ts` | DEFAULT | Intelligent page content extraction |
| Reddit Intelligence | `discovery-sources/reddit-intelligence.ts` | DEFAULT | Reddit thread analysis, company extraction |

## Retry & Error Handling

| Setting | Value |
|---------|-------|
| Max retries | 4 (initial + 3 retries) |
| Backoff | 1s → 2s → 4s |
| Retry on | HTTP 429 (rate limit), HTTP 5xx (server error) |
| JSON extraction retries | 3 attempts, appends "Output must be valid JSON only" |
| `<think>` tags | Stripped from DeepSeek-R1 responses |

## Token Tracking

Every LLM call tracks token usage in Redis:

```
Key:   tenant:{tenantId}:usage:bedrock:tokens
Value: cumulative total (prompt_tokens + completion_tokens)
```

Both streaming and non-streaming responses are tracked.

## Legacy / Unused

| Item | Status |
|------|--------|
| `TOGETHER_API_KEY` env var | Optional, not used (migrated to Bedrock) |
| `CLAUDE_API_KEY` env var | Optional, not used (migrated to Bedrock) |
| `@anthropic-ai/sdk` npm package | Installed but never imported |
| `TOGETHER_API_URL` env var | Default `https://api.together.xyz/v1`, not used |

## Key Files

| File | Purpose |
|------|---------|
| `src/tools/together-ai.tool.ts` | Core LLM dispatch — `callAPI()`, `complete()`, `completeStream()`, `extractJSON()` |
| `src/tools/claude.tool.ts` | Wrapper that calls `complete()` with `SMART_MODEL` |
| `src/agents/base-agent.ts` | Agent base class — `callTogether()`, `callClaude()`, `extractJSON()` methods |
| `src/config/env.ts` | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_BEDROCK_REGION` |
| `src/utils/json-extract.ts` | `extractJSONFromText()` — parses LLM output to JSON |
