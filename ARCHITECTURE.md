# TalentAI — Architecture Document

> Multi-tenant AI agent orchestration platform for automated B2B sales / recruitment lead generation.
> Generates personalized outbound campaigns powered by autonomous agents, served via a Next.js dashboard with a companion Chrome extension that scrapes LinkedIn **and Google Maps** on the user's behalf.
>
> Beyond the autonomous discovery loop, the platform now ships a **human-in-the-loop Sales Operations layer**: a company-centric Daily Queue (triage), a CRM-pipeline-driven Follow-up engine, a multi-channel Message Studio, and a LinkedIn Inbox Copilot — all review-and-send, never auto-fire.

> _Last substantial update: 2026-06-14. Extension `manifest.json` v1.0.54._

---

## 1. Top-level layout

```
autonomous_agency/
├── agentcore/         ← Fastify 5 backend, BullMQ workers, Postgres + Redis
├── dashboard/         ← Next.js 15 (App Router) UI
├── extension/         ← Chrome MV3 extension (LinkedIn + Google Maps scraping + manual add)
├── extension-releases/← Built ZIP / CRX bundles + latest.json served by /extension/* endpoints
├── DEPLOYMENT.md      ← Server deploy notes
├── ARCHITECTURE.md    ← This document
└── ecosystem.config.cjs ← pm2 process map for the three Node services
```

Three tiers, deployed independently:

1. **agentcore** — REST API (`api`) + WebSocket (`/ws`) + queue workers (`workers`). Holds **all state** in Postgres; Redis is queues + ephemeral cache + pub/sub.
2. **dashboard** — server-rendered/client-hydrated Next.js app, talks to agentcore via REST + WS. No own DB.
3. **extension** — sandboxed scraper that runs on the user's signed-in LinkedIn / Google Maps tab. Communicates with agentcore via WebSocket (server-issued tasks) and HTTPS (manual actions: capture, copilot, studio).

```
   ┌─────────────────────────────────────────────────────────┐
   │ User's browser (signed in to LinkedIn / Google Maps)    │
   │                                                          │
   │  Dashboard tab ◄───HTTPS REST + WS──► agentcore (api)   │
   │                                                          │
   │  Chrome extension ◄───WSS──────────► agentcore (ws)     │
   │   • popup                                                │
   │   • LinkedIn content scripts (sidebar, copilot, studio)  │
   │   • Google Maps content scripts (capture panel, scraper) │
   └─────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                  ┌──────────────────────────────────┐
                  │ agentcore (Node + Fastify)       │
                  │  src/index.ts            ← API   │
                  │  src/queues/workers.ts   ← Jobs  │
                  └──────────────────────────────────┘
                                        │
                ┌───────────────────────┼───────────────────────┐
                ▼                       ▼                       ▼
            Postgres               Redis (BullMQ +         External services
        (Drizzle ORM, RLS)         pub/sub + cache)        (Bedrock LLM + vision, Reacher,
                                                            SearXNG, Crawl4AI, SMTP,
                                                            IMAP, POP3)
```

---

## 2. Tech stack

### agentcore (`agentcore/package.json`)

- **Runtime**: Node 20+, ESM, TypeScript 5.7
- **HTTP**: Fastify 5 (`fastify`, `@fastify/cors`, `@fastify/cookie`, `@fastify/multipart`, `@fastify/rate-limit`, `@fastify/websocket`)
- **Auth**: `@fastify/jwt` (HS256), `bcryptjs` (pure JS — no node-gyp), refresh tokens hashed in Redis with 7d TTL
- **DB**: Postgres 16, **Drizzle ORM** (`drizzle-orm`, `drizzle-kit`), `pg` driver, **Row-Level Security** via `withTenant(tenantId, fn)` helper in `src/config/database.ts`
- **Queues**: BullMQ 5 + ioredis 5, per-tenant queue names + dead letter; plus **global cross-tenant queues** (gmaps-menu) where each job carries its own `tenantId`
- **LLM**: AWS Bedrock OpenAI-compatible endpoint (`together-ai.tool.ts` despite its name) + Anthropic SDK fallback (`claude.tool.ts`). Default model `openai.gpt-oss-120b-1:0`, smart model `deepseek.v3.2`, fast model `openai.gpt-oss-20b-1:0`. Cold-email drafting uses **Kimi K2.5** at temp 0.8. **Vision** (Maps menu OCR) goes through the Bedrock Converse API (OpenAI-compat endpoint is text-only — see §19).
- **Scraping**: Crawl4AI (server-side, public pages — incl. business websites for menu text), SearXNG (web search)
- **Email**: nodemailer (SMTP), imapflow (IMAP append to Sent), node-pop3 (POP3 polling), Reacher (SMTP verification, 300/day server-wide cap)
- **Documents**: pdf-parse v2, mammoth (DOCX)
- **Validation**: Zod
- **Logging**: pino + pino-pretty
- **Tests**: Vitest

### dashboard (`dashboard/package.json`)

- **Runtime**: Next.js 15, React 19, App Router
- **State**: TanStack Query 5 (server state), Zustand 5 (UI state, incl. queue-refresh polling flags)
- **HTTP**: Axios (with interceptors)
- **UI**: Tailwind 3, Radix UI primitives, lucide-react icons, recharts (analytics)
- **DnD**: @dnd-kit/core + @dnd-kit/sortable (CRM kanban)
- **OCR**: Tesseract.js (Copilot FAB image-to-activity)
- **Dates**: date-fns

### extension (`extension/manifest.json` v1.0.54)

- **Manifest V3** Chrome extension, ESM service worker
- Background service worker (`background/service-worker.js`) + content scripts (`content/linkedin/*`, `content/gmaps/*`, `content/crunchbase/*`)
- Auto-injected content scripts: `content/linkedin/profile-sidebar.js` (Snov.io-style "Add to CRM" widget), `content/linkedin/copilot-inline.js` (✨ inbox reply drafting), `content/linkedin/studio-button.js`+`studio-popup.js` (profile → generate message), `content/gmaps/capture-panel.js` (Maps lead-capture panel)
- On-demand injection via `chrome.scripting.executeScript` for fetch-company / search-companies / gmaps fetch+search adapters
- Auth: JWT in `chrome.storage.local`, talks to agentcore via `wss://` for task pickup and `https://` for manual actions
- Distribution: signed CRX served from `https://agents.api.talentailabs.com/extension/updates.xml` (self-hosted Chrome auto-update). `extension-private.pem` is the signing key — **never committed** (gitignored)

---

## 3. agentcore — folder-by-folder

```
agentcore/src/
├── index.ts                ← Fastify server entry
├── config/
│   ├── database.ts         ← Drizzle client + withTenant() RLS helper
│   ├── env.ts              ← Zod-validated env
│   └── site-configs.ts     ← Per-source scraper configs (WTTJ, Free-Work, etc.)
├── db/
│   ├── schema/             ← Drizzle tables (see §4)
│   ├── migrations/         ← drizzle-kit-generated SQL (up to 0036)
│   └── seed.ts             ← Local seed (admin@acme.com / password123)
├── routes/                 ← Fastify route modules (see §5)
├── agents/                 ← Autonomous AI agents (see §6)
├── workers/                ← BullMQ workers (one per agent type + global gmaps-menu/triage)
├── queues/                 ← Queue setup, registration, scheduled jobs
├── services/               ← Cross-cutting business logic (see §7)
├── tools/                  ← Stateless integrations (LLM, vision, scrapers, email)
├── prompts/                ← Per-agent/operation system + user prompts (incl. copilot/, studio/)
├── templates/              ← Email HTML wrapper, plain-text sanitizer
├── types/                  ← Shared TS types (PipelineContext, SalesStrategy)
├── middleware/             ← auth, rate-limit, tenant
├── utils/                  ← errors, logger, json-extract, mission-intent
├── websocket/              ← Realtime relay + extension WS handlers
└── scripts/                ← One-shot DB / debug scripts (see §18)
```

### How the layers fit

- **routes/** call **services/** which call **tools/** and read/write **db/schema/**
- **agents/** are long-running orchestrators triggered by **queues/** (BullMQ jobs)
- **workers/** are thin BullMQ listener wrappers around each agent class (plus global workers for gmaps-menu enrichment and daily triage)
- **websocket/** pushes events to the dashboard (Redis pub/sub fan-out, incl. `queue:ready`) and dispatches tasks to the extension

---

## 4. Database schema (`src/db/schema/`)

Multi-tenant. Every domain table has `tenant_id` and is gated by Postgres RLS through `withTenant`.

### Tenant + auth
- `tenants` — workspaces (`name`, `slug`, `settings.companyProfile`, **`settings.messagingConfig`**, **`settings.followupCadence`**)
- `users` — accounts (`email`, `passwordHash`, `tenantId`, `role`, `name` — `name` is the source of truth for outreach sender first-name)
- `user_tenants` — many-to-many for users with multiple workspaces; **`is_default`** flag (one per user) added in 0029
- `invitations` — invite-by-email pending acceptances
- `agent_activity_log` — audit trail of every agent action

### Agents + orchestration
- `master_agents` — top-level agent (`mission`, `useCase`, `config` JSONB, `status`, `actionPlan`, `reviewMode`, `dailyRuntimeBudgetMs`, `createdBy`)
- `agent_configs`, `agent_tasks`, `agent_messages`, `agent_memory`, `agent_daily_strategy`

### Discovery → CRM funnel
- `companies` — discovered orgs (`domain`, `industry`, `size`, `linkedinUrl`, `rawData`). **Company-centric triage columns (0035):** `do_not_contact`, `current_stage`, `stage_entered_at`, `last_touch_at`, `last_inbound_at`, `total_outbound_touches`, `total_inbound_responses`.
- `contacts` — people **and Google Maps businesses** (`firstName`, `lastName`, `email`, `linkedinUrl`, `companyId`, `masterAgentId`, `score`, `status`, `rawData`). **Sales-ops columns (0034):** `source_type` (`gmaps_business` | `ai_discovery` | `manual_linkedin` | `extension_capture` | `referral` | `imported_csv`), `source_metadata` (JSONB — Maps place detail, reviews/about HTML, photos, menu, `aiRecommendation`), `created_by_user_id`, `do_not_contact`, `custom_tags`, `headline`, `about`, `phone`, `whatsapp`, `twitter_url`, `intent_score`.
- `opportunities`, `documents`, `interviews`, `reddit_opportunities`, `pipeline_errors`
- `crm_stages` — pipeline columns (Lead, Contacted, Replied, Meeting, Qualified, Won, Lost). **Follow-up flags (0036):** `follow_up_eligible` (bool), `follow_up_classified_by` (`null` | `'ai'` | `'user'`).
- `deals` — kanban cards (one per `(contact, masterAgent)` pair, joined to a stage)
- `crm_activities` — timeline events. **(0034)** extended with `event_category` + `actor_type` + six new enum values; written through `timeline.service.ts`.

### Sales Operations (NEW — Stage 1–4)
- `prospect_stages` — **contact-scoped** pipeline state (1:1 with `contacts`). `current_stage` ∈ `new | first_touch_sent | awaiting_response | engaged | qualified | meeting_scheduled | in_evaluation | closed_won | closed_lost | cold | dnc`; `total_touches`, `last_touch_at`, `last_response_at`, `next_action_due`. Always exists at capture. Distinct from legacy `contacts.status`.
- `prospect_actions` — **the Daily Queue.** Company-grained as of 0035 (`company_id` NOT NULL; `contact_id` nullable for company-only rules). `action_type`, `priority` (P0–P3), `priority_reason`, `why_now`, `strategy_note`, `draft_subject`/`draft_body`/`draft_confidence`, `channel_target`, `context_summary`, `target_alternatives` (JSONB — up to 4 retarget candidates), `status`, `scheduled_for`, `expires_at`, lifecycle timestamps, `skip_reason`, `triggered_by_event_id`. **Partial unique index** `prospect_actions_one_pending_per_company` enforces one pending action per `(tenant, company)`.
- `followup_sequences` — per-deal follow-up cadence state (PK `deal_id`). `status` (`active|halted|completed`), `touch_number`, `last_touch_at`, `next_due_at`, `cadence_override`, `halt_reason`. Created when a deal enters a follow-up-eligible stage; advanced by daily triage; halted on inbound reply or stage change.

### Messaging surfaces (NEW — audit-only, no pipeline coupling)
- `message_compositions` — audit log of every **Message Studio** generation (`channel`, `track`, `message_type`, recipient fields, `subject`, `body`, `classification`, `character_count`). Copy-paste only; not linked to contacts.
- `linkedin_conversations` — one row per LinkedIn DM thread viewed via **Inbox Copilot** (`recipient_linkedin_url` unique per tenant, `contact_id` nullable, message counts, `current_stage`).
- `linkedin_messages` — individual messages in a thread (`direction`, `body`, `classified_intent`, `is_copilot_draft`, `draft_strategy`, `draft_used`). Drafts persisted even when unused, for analytics.

### Email + outreach
- `email_accounts`, `email_listener_configs`, `email_intelligence`, `email_queue`, `emails_sent`, `email_threads`, `replies`
- `outreach_emails` — per-step campaign emails. **(0030)** v4 classification: `track`, `classification`, `partnership_angle`, `collaboration_angle`, `proposed_exchange`, `skip_reason`.

### Campaigns / Conversations / extension / intel
- `campaigns`, `campaign_steps`, `campaign_contacts`
- `conversations`, `conversation_messages`
- `extension_sessions` — **(0029)** now bound to a **user** (not tenant), so the dispatcher drains tasks across every workspace the session user belongs to
- `extension_tasks` — server-issued scrape tasks (site, type, params, status, dispatch_after, priority, result)
- `domain_patterns`, `products`

RLS: `scripts/setup-rls.sql` creates one policy per tenant-owned table. Every query inside `withTenant(tenantId, fn)` runs with `set_config('app.current_tenant', $1, true)` so RLS filters apply automatically.

---

## 5. agentcore — REST routes (`src/routes/`)

Each file is a Fastify plugin registered in `src/index.ts`.

| Route file | Surface | Notes |
|---|---|---|
| `auth.routes.ts` | `/api/auth/*` | login, register, refresh, me — JWT issuance |
| `tenant.routes.ts` | `/api/tenants/*` | workspace CRUD, member mgmt |
| `team.routes.ts` | `/api/team/*` | invitations, role mgmt |
| `master-agent.routes.ts` | `/api/master-agents/*` | CRUD + run/pause/resume + analyze-pipeline |
| `agent.routes.ts` | `/api/agents/*` | sub-agent activity, tasks |
| `agent-room.routes.ts` | `/api/agent-rooms/*` | live agent activity feed |
| `chat.routes.ts` | `/api/chat/*` | conversation create/append, streaming reply |
| `strategy.routes.ts` | `/api/strategy/*` | manual strategy trigger / regenerate |
| `contact.routes.ts` | `/api/contacts/*` | contact/**prospect** CRUD, manual email (Reacher-verified), find-email, draft-email, send-email. **NEW:** `POST /capture` (manual prospect add, rate-limited), `GET /lookup` (linkedin-url dedup), `GET /:id/timeline`, `POST /:id/notes`, `POST /:id/dnc`, `POST /:id/tags`, `POST /:id/reassign`, **`POST /:id/ai-recommendation`** (Google Maps business recommendation). List endpoint strips heavy `reviewsHtml`/`aboutHtml` blobs. |
| `company.routes.ts` | `/api/companies/*` | company CRUD + enrichment trigger |
| `crm.routes.ts` | `/api/crm/*` | stages, deals, activities; `/copilot/parse-activity`. **NEW:** `GET`/`PUT /api/crm/followup-cadence` (tenant cadence strategy + intervals) |
| `activity.routes.ts` | `/api/activities/*` | activity timeline |
| `opportunity.routes.ts` | `/api/opportunities/*` | qualified leads |
| `campaign.routes.ts` | `/api/campaigns/*` | multi-step campaign mgmt |
| `document.routes.ts` | `/api/documents/*` | upload + parse PDF/DOCX |
| `email-account.routes.ts` | `/api/email-accounts/*` | SMTP/IMAP/POP creds (per-user) |
| `email-listener.routes.ts` | `/api/email-listeners/*` | inbound polling configs |
| `mailbox.routes.ts` | `/api/mailbox/*` | unified inbox view |
| `linkedin.routes.ts` | `/api/linkedin/*` | LinkedIn scrape orchestration |
| `extension.routes.ts` | `/api/extension/*` | extension auth, session mgmt, manual contact add. **NEW:** `POST /gmaps/capture` (Maps panel bulk capture → `ingestGmapsBusiness` → company + business-contact + Lead deal, fans out detail scrapes) |
| `extension-distribution.routes.ts` | `/extension/*` | serves CRX/ZIP + updates.xml |
| `analytics.routes.ts` | `/api/analytics/*` | dashboard stats + outreach-activity grid |
| `tracking.routes.ts` | `/track/*` | open-pixel + unsubscribe |
| `schedule.routes.ts` | `/api/schedule/*` | scheduled jobs |
| `product.routes.ts` | `/api/products/*` | tenant product catalogue (used by email prompts) |
| `copilot.routes.ts` | `/api/copilot/*` | Copilot FAB endpoints. **NEW:** `POST /draft-reply` (LinkedIn Inbox Copilot, extension entrypoint) |
| `workspace.routes.ts` | `/api/workspaces/*` | multi-workspace switching |
| **`queue.routes.ts`** | `/api/queue/*`, `/api/prospect-actions/*` | **NEW.** Daily Queue: `GET /api/queue` (pending actions grouped P0–P3 + company/contact joins + refresh quota), `POST /api/queue/refresh` (on-demand triage, hard cap 3/day), and per-action `complete` / `skip` / `edit-draft` / `execute` / `retarget` |
| **`studio.routes.ts`** | `/api/studio/*` | **NEW.** `POST /generate` (one-shot multi-channel message), `POST /record-action` (log a sent LinkedIn DM / connection note → resolve-or-create contact + CRM activity + touch), `GET`/`PUT /config` (messaging config) |

WebSocket endpoints (`src/websocket/`):
- `realtime.ts` — `/ws/realtime` Redis-backed pub/sub fan-out to dashboard (timeline events, `queue:ready`, etc.)
- `extension.ts` — `/ws/extension` server-issued task dispatch + result ingestion

---

## 6. agentcore — agents (`src/agents/`)

Each agent class extends `BaseAgent` (`base-agent.ts`) which provides LLM helpers, Redis memory, event emit, and `dispatchNext` chain.

### Top-level orchestrator
- **`master-agent.ts`** — drives the whole pipeline. Loads `pipelineContext` + `salesStrategy`, runs the **strategist**, then **dispatches `pipelineSteps[]` data-driven** (each step's `tool` ∈ `LINKEDIN_EXTENSION | CRAWL4AI | LLM_ANALYSIS | REACHER | EMAIL_PATTERN | SCORING` → matching dispatch action). Persists strategy to `master_agents.config.salesStrategy`.

### Strategy
- **`strategist.agent.ts`** — generates the `SalesStrategy` (bdStrategy + targetIndustries + hiringKeywords + pipelineSteps). Honors `userExplicitBdStrategy` lock from chat. Deterministic fallback when LLM fails. **Idempotent**: short-circuits when a saved strategy with pipelineSteps exists, unless `force: true`.
- **`strategy.agent.ts`** — older variant (legacy)

### Discovery
- **`discovery.agent.ts`**, **`company-finder.agent.ts`**, **`candidate-finder.agent.ts`**, **`linkedin.agent.ts`**

### Per-contact pipeline
- **`document.agent.ts`**, **`enrichment.agent.ts`**, **`scoring.agent.ts`**, **`outreach.agent.ts`**, **`reply.agent.ts`**, **`action.agent.ts`**

### Inbox + monitors
- **`mailbox.agent.ts`**, **`email-listener.agent.ts`**, **`reddit-monitor.agent.ts`**

### Pipeline flow
```
discovery → document → enrichment → scoring → outreach → reply → action
```

> Note: the **Sales Operations layer (§13)** — Daily Queue, triage, follow-up engine, Studio, Inbox Copilot — runs *alongside* this autonomous loop and is implemented as **services + workers**, not `BaseAgent` agents. It is review-and-send: it surfaces recommendations and drafts; the human sends.

---

## 7. agentcore — services (`src/services/`)

| File | Responsibility |
|---|---|
| `auth.service.ts` | password hashing (bcryptjs), JWT issuance, refresh-token rotation in Redis |
| `tenant.service.ts` | workspace creation, RLS bootstrap |
| `chat.service.ts` | conversation lifecycle, explicit-strategy reply parser (chip A/B/C → `userExplicitBdStrategy`), classifyMissionIntent, quick-reply chip synthesis |
| `crm-activity.service.ts` | logActivity, ensureDeal (idempotent deal creation at Lead stage) |
| `timeline.service.ts` | **NEW.** Single source of truth for contact timeline events (`crm_activities`). `logEvent(input)` with explicit `eventCategory` + `actorType`; emits real-time Redis event so the dashboard timeline updates without polling |
| `contact-match.service.ts` | word-boundary matcher used by Copilot to reconcile a typed name to a contact |
| `copilot.service.ts` | Copilot FAB orchestration (text + OCR → LLM parse → activity) |
| `inbox-copilot.service.ts` | **NEW.** LinkedIn DM reply drafting (standalone, no pipeline). Builds `ExtractedContext`, classifies inbound intent, generates context-aware reply; persists thread + messages to `linkedin_conversations`/`linkedin_messages`; daily rate-limited. `generateReplyDraft(input)` |
| `message-studio.service.ts` | **NEW.** One-shot message generator for any channel (email, LinkedIn DM/connection, Twitter, WhatsApp, Telegram). Delegates email to cold-email-drafter; routes others to channel prompts; audit-logs to `message_compositions`. `generateStudioMessage(input)` |
| `messaging-config.service.ts` | **NEW.** Resolves/derives `tenant.messagingConfig` (value_prop, differentiator, pricing) from Company Profile + Products; truthy `value_prop` is the "configured" sentinel. `ensureMessagingConfig`, `isMessagingConfigSufficient`, `buildColdEmailSender` |
| `cold-email-drafter.service.ts` | **NEW.** First-touch cold email via Bedrock **Kimi K2.5** (temp 0.8). STEP-0 classification (`POTENTIAL_BUYER` / `DIRECT_COMPETITOR` / `ADJACENT_PARTNER` / `WRONG_FIT`) → tracks (`NORMAL` / `PARTNERSHIP` / `COLLABORATION` / `SKIP`). Forbidden-phrase guard with one retry. `draftColdEmail(...)` |
| `sender.service.ts` | **NEW.** Resolves the account holder's first name from `users.name`; throws `MISSING_SENDER_NAME` if unset (fail loud, never invent) |
| `triage.service.ts` | **NEW.** Company-centric Daily Queue generator (13 rules over the `companies` table). Per-rule target-contact selection + up to 4 alternatives. One pending action per `(tenant, company)`. `runTriageForTenant`, `microTriage` (inbound events), `runTriageForContact`, `retargetAction` |
| `prospect-stage.service.ts` | **NEW.** Contact-scoped stage tracking (`prospect_stages`); emits `stage_change` timeline events; never demotes; idempotent; mirrors to company aggregates. `transitionStage`, `recordTouch`, `recordResponse` |
| `company-stage.service.ts` | **NEW.** Company-level aggregates (`current_stage`, `total_outbound_touches`, `last_touch_at`, `last_inbound_at`, `total_inbound_responses`) — triage reads from here. `recordCompanyTouch`, `recordCompanyResponse` |
| `stage-classifier.service.ts` | **NEW.** One LLM call classifies all tenant CRM stages for follow-up eligibility; user edits are permanent (`follow_up_classified_by='user'`); terminal/replied stages forced ineligible. `classifyStagesForTenant` |
| `followup-cadence.service.ts` | **NEW.** Cadence config (fast/mid/slow day-arrays) in `tenants.settings.followupCadence` + per-lead override. `getTenantCadence`, `resolveIntervals`, `computeNextDue` |
| `followup-engine.service.ts` | **NEW.** Per-deal follow-up sequences (`followup_sequences`). Touch 1 = first_followup, 2 = second_followup, final = breakup. Surfaces due follows as Queue cards; halts on reply / stage change. `ensureSequenceForDeal`, `haltSequenceForDeal`, `onDealStageChanged`, `onReplyDetected`, `scanDueSequences` |
| `gmaps-lead.service.ts` | **NEW.** Shared CRM-push for Google Maps businesses (extension capture + server dispatch). Dedup by mapsUrl → company + business-contact at Lead. Enqueues detail scrapes + menu jobs for food businesses. `ingestGmapsBusiness` |
| `gmaps-menu.service.ts` | **NEW.** Vision-OCR menu extraction from Maps food-business photos (Bedrock vision) → persists structured menu. Fail-soft. `extractAndStoreGmapsMenu` |
| `gmaps-website-menu.service.ts` | **NEW.** Text menu extraction from the business's own website (menu link / homepage) via Crawl4AI + LLM; same storage shape. Tried before photo-vision. `extractAndStoreGmapsWebsiteMenu` |
| `gmaps-recommendation.service.ts` | **NEW.** On-demand grounded AI recommendation for a Maps business (priority/fit + outreach angle + opener + gaps + service). Persists to `sourceMetadata.aiRecommendation`. **Responds in the listing's language (Arabic for Arabic listings).** `generateGmapsRecommendation` |
| `capture-rate-limit.service.ts` | **NEW.** Per-user daily cap on `POST /contacts/capture` (Redis INCR/EXPIRE, default 100/day, fails open) |
| `queue-refresh-rate-limit.service.ts` | **NEW.** Per-user daily cap on `POST /queue/refresh` (hard 3/day, fails open) |
| `extension-dispatcher.ts` | enqueueExtensionTask, tryDispatch, drainPending, manual contact add → multi-agent fan-out, sanitizePersonName, rankPeopleByTitle, gmaps detail-field whitelist |
| `queue.service.ts` | dispatchJob, drainAllPipelineQueues, removeAllEmail*Jobs |
| `email-poll-scheduler.service.ts` | per-tenant email polling cadence |
| `email-sender.service.ts` | gather steps + send via nodemailer + IMAP-append to Sent |
| `invitation.service.ts` + `invitation-email.template.ts` | team invites |
| `transactional-email.service.ts` | system emails (welcome, password reset) |
| `runtime-budget.service.ts` | per-master-agent daily runtime cap enforcement |
| `search-negotiation.service.ts` | broaden-search prompt flow when discovery returns thin results |
| `smtp-rate-limiter.service.ts` | per-account SMTP throttle |

---

## 8. agentcore — tools (`src/tools/`)

| Tool | What it wraps |
|---|---|
| `together-ai.tool.ts` | **AWS Bedrock OpenAI-compatible endpoint** (legacy name); `complete`, `completeStream`, `extractJSON`, `SMART_MODEL`, `FAST_MODEL`. Also exposes **vision** via the Bedrock **Converse** API (base64 image bytes) used by Maps menu OCR |
| `claude.tool.ts` | Anthropic SDK wrapper, also routes through Bedrock |
| `searxng.tool.ts` | SearXNG meta-search (global rate limits) |
| `crawl4ai.tool.ts` | Crawl4AI HTTP client for server-side scrapes (public pages, business websites for menu text) |
| `discovery-engine.ts` + `discovery-sources/` | unified discovery wrapper (LinkedIn, WTTJ, Free-Work, etc.) |
| `linkedin-jobs.tool.ts` | Public LinkedIn Jobs scrape via Crawl4AI; auto-chains `fetch_company` extension tasks |
| `linkedin-voyager.tool.ts` | LinkedIn Voyager (private API) helpers |
| `email-finder.tool.ts` | **9-pattern email guesser** + Reacher SMTP verify, server-wide 300/day cap, per-domain pattern cache, catch-all detection |
| `email-intelligence.ts` | Domain-level email intel (MX, accept-all) |
| `email-queue.tool.ts` | per-account quota selection + queue delivery |
| `imap-sent-append.tool.ts` | IMAP APPEND so sent mail shows in Sent folder |
| `smtp.tool.ts` | nodemailer wrapper with List-Unsubscribe headers + IMAP append |
| `pdf-parser.tool.ts` | pdf-parse v2 |
| `docx-parser.tool.ts` | mammoth |
| `smart-crawler.ts` | sitewide-aware crawl wrapper |

### Email-finder pattern set (9 templates + first-token variants)
```
first.last  flast    first    f.last
firstlast   last.first  first_last  last
f1l1                                          ← initials
+ _firsttoken variants for hyphenated first names (Vlad-George Iacob → vlad.iacob)
```
Reacher: 1s gap between probes, 300/day across all tenants, per-domain pattern cached in memory + `domain_patterns`.

---

## 9. agentcore — prompts (`src/prompts/`)

Each prompt file exports `buildSystemPrompt` / `buildUserPrompt` for one agent or operation. Notable files:

- `master-agent.prompt.ts`, `strategist.prompt.ts` (with `forcedBdStrategy` constraint), `pipeline-builder.prompt.ts`
- `discovery.prompt.ts` / `company-finder.prompt.ts` / `candidate-finder.prompt.ts`
- `document.prompt.ts` / `candidate-profile.prompt.ts`, `enrichment.prompt.ts` / `company-deep.prompt.ts`, `scoring.prompt.ts`
- `sales-email-generation.ts` / `recruitment-email-generation.ts`, `outreach.prompt.ts`
- `reply.prompt.ts` / `inbound-email.prompt.ts`, `action.prompt.ts` / `action-plan.prompt.ts`
- `chat-agent.prompt.ts`, `mailbox.prompt.ts`, `copilot.prompt.ts` / `copilot-activity.prompt.ts`, `classification.prompt.ts`, `agent-selector.prompt.ts`

### NEW prompts
- `cold-email-drafting.prompt.ts` — founder-voice cold email for Kimi K2.5; STEP-0 classification + track; forbidden-phrase / anti-pattern guards
- `gmaps-menu.prompt.ts` — vision menu extraction from 1–3 Maps photos (fail-soft: empty fields if unreadable, never invent)
- `gmaps-website-menu.prompt.ts` — text menu extraction from the business website (same output shape for unified storage)
- `gmaps-recommendation.prompt.ts` — grounded business recommendation (priorityScore, fit, reasoning, outreachAngle, suggestedOpener, gaps[], recommendedService); **answers in the listing's language**
- **`prompts/copilot/`** — `intent-classifier.prompt.ts` (inbound DM intent + signals), `intent-reply-strategies.ts` (intent → strategy), `reply-generation.prompt.ts` (LAYER 1/2; rewrite modes: generate_from_scratch, make_warmer, make_more_direct, shorten, expand), `extracted-context.ts` (context shape)
- **`prompts/studio/`** — `_message-type-instructions.ts` (per message-type fragment), `types.ts`, and one file per channel: `linkedin-dm.prompt.ts`, `linkedin-connection-request.prompt.ts` (300-char hard limit), `twitter-dm.prompt.ts`, `whatsapp.prompt.ts`, `telegram.prompt.ts`

---

## 10. agentcore — queues + workers (`src/queues/`, `src/workers/`)

- BullMQ 5, ioredis 5. **Per-tenant queue prefix** for the autonomous pipeline; **global cross-tenant queues** for enrichment that carries its own `tenantId`.
- `setup.ts` — Redis connection factory
- `queues.ts` — registered per-agent queues + dead-letter
- **`queues/gmaps-menu-queues.ts`** — **NEW** global `gmaps-menu` queue (deduped by `contactId`, attempts=2, exp backoff 15s). `getGmapsMenuQueue()`, `enqueueGmapsMenu(data)`
- `workers.ts` — registers all workers; schedules repeatable jobs (email-polling, runtime-budget reset, **daily triage cron `0 6 * * *`**)
- `dead-letter.ts` — failed-job sink

Each pipeline agent has a 1:1 worker (`workers/<agent>.worker.ts`): pull job → `agent_tasks` row → agent `execute()` → complete/fail → optional `dispatchNext`.

### NEW workers
- **`workers/gmaps-menu.worker.ts`** — global worker for the `gmaps-menu` queue. Per job: try website-menu (clean text) first, fall back to photo-vision OCR; both fail-soft + idempotent. No `agent_tasks` row.
- **`workers/triage.worker.ts`** — runs `runTriageForTenant`. Repeatable cron `0 6 * * *` (06:00 UTC) + on-demand via `POST /api/queue/refresh`.

---

## 11. dashboard — folder layout (`dashboard/src/`)

```
src/
├── app/
│   ├── (auth)/           ← login, register
│   ├── (dashboard)/      ← all post-login pages
│   │   ├── agents/       ← agent list + [id] detail (tabs incl. queue, businesses, settings)
│   │   ├── companies/    ← NEW: all discovered companies (search, fit-score sort)
│   │   ├── prospects/    ← NEW: all prospects list + [id] detail (timeline, notes, gmaps card)
│   │   ├── queue/        ← NEW: Daily Queue (priority buckets, refresh quota)
│   │   ├── studio/       ← NEW: one-shot multi-channel message generator
│   │   ├── crm/          ← kanban pipeline (deal-board.tsx); settings/ stage editor
│   │   ├── analytics/    ← recharts dashboards + outreach activity grid
│   │   ├── campaigns/    ← multi-step campaign editor
│   │   ├── dashboard/    ← home
│   │   ├── documents/    ← upload + parse
│   │   ├── linkedin-extension/ ← extension install + status
│   │   ├── mailbox/      ← unified inbox
│   │   ├── schedule/     ← scheduled jobs
│   │   └── settings/     ← profile, products, email, extension, team, company, NEW: messaging/
│   ├── invite/, layout.tsx, providers.tsx, page.tsx
├── components/
│   ├── agents/           ← wizard, pipeline-builder, room, strategy-panel … NEW: agent-queue-tab, agent-settings-tab
│   ├── prospects/        ← NEW: gmaps-business-card, capture-form, contact-summary-card, timeline-feed, note-composer
│   ├── queue/            ← NEW: queue-view, action-card, draft-editor-dialog, execute-confirm-dialog, skip-dialog
│   ├── crm/, chat/, companies/, contacts/, copilot/
│   ├── analytics/        ← stat cards + NEW: outreach-activity-grid
│   ├── documents/, mailbox/, schedule/, shared/, layout/, ui/
├── hooks/                ← TanStack Query hooks
├── stores/               ← Zustand stores (incl. realtime queue-refresh flags)
├── lib/                  ← api.ts (Axios), utils.ts; NEW: lib/api/ (prospects.ts, queue.ts)
└── types/                ← shared TS types
```

### NEW pages
- **`companies/`** — all discovered companies; search + sort by buyer-fit score; `useCompanies()`
- **`prospects/`** + **`prospects/[id]`** — prospect list (filter by stage / source type / tag / search) and detail (ContactSummaryCard + GmapsBusinessCard + NoteComposer + TimelineFeed); `useProspects` / `useProspect` / `useProspectTimeline`
- **`queue/`** — mounts `<QueueView showGreeting />`; priority buckets P0–P3, manual refresh w/ quota; `useQueue` (WS `queue:ready` + safety-net polling) / `useRefreshQueue`
- **`studio/`** — channel × track × message-type form + recipient fields → `useGenerateStudioMessage` (`POST /api/studio/generate`)
- **`settings/messaging/`** — sender identity + messaging context form; `useMessagingConfig` / `useSaveMessagingConfig` (`/api/studio/config`)

### CHANGED pages
- **`agents/[id]/page.tsx`** — tab union now `queue | overview | contacts | businesses | opportunities | companies | documents | emails | activity | strategy | room | settings`. **`businesses`** tab appears only when `contacts.filter(c => c.sourceType === 'gmaps_business')` is non-empty (the local-business view). `queue` tab scopes the Daily Queue to that agent; `settings` tab selects the outbound email account. URL-synced via `?tab=`.
- **`agents/[id]/contacts/[contactId]/page.tsx`** — mounts `<GmapsBusinessCard>` (full Maps detail + AI recommendation) plus `<SequencePanel>` (follow-up status) and `<EmailComposeModal>`.

### NEW components (highlights)
- **`prospects/gmaps-business-card.tsx`** — renders all Maps `sourceMetadata`: category/rating, phone/website/menu/maps/directions links, address/plusCode, price/pricePerPerson, hours, service options, photos, menu dishes, rating distribution, and collapsible **reviews/about raw HTML** (sanitized at capture, `dir="auto"` for RTL). Hosts the **AI Recommendation** card (fit badge, priority, reasoning, angle, opener, gaps) with a Generate/Regenerate button (`useGenerateGmapsRecommendation`).
- **`queue/`** — `queue-view` (priority accordion + refresh), `action-card` (draft, why-now, channel, execute/complete/skip + retarget alternatives), and the three action dialogs.
- **`agents/agent-queue-tab.tsx`** (wraps `<QueueView masterAgentId=…>`), **`agent-settings-tab.tsx`** (email-account picker), **`analytics/outreach-activity-grid.tsx`** (Emails/LinkedIn/Persons Added/Connections/Responses KPIs).

### NEW hooks & lib
- `use-prospect.ts` (list/detail/timeline + notes/dnc/tags/reassign), `use-queue.ts` (queue/refresh + execute/complete/skip/edit-draft/retarget), `use-studio.ts` (generate + messaging config), `use-gmaps-recommendation.ts`
- `lib/api/prospects.ts` (capture, lookup, list, get, timeline) and `lib/api/queue.ts` (queue + action mutations) — typed wrappers over the new endpoints
- `types/index.ts`: `Contact` gained `sourceType`, `sourceMetadata`, `phone`. `types/crm.ts`: `CrmStage` gained `followUpEligible`, `followUpClassifiedBy`.

### Key UX flows
- **Agent creation wizard** → mission → strategy chip → strategist pipeline → review → Run
- **CRM Pipeline** (`/crm`) → DnD-kit kanban → optimistic move + rollback
- **Daily Queue** (`/queue` or agent `queue` tab) → triage-generated action cards grouped P0–P3 → edit draft → execute/complete/skip → retarget to alternative contact
- **Message Studio** (`/studio` or extension profile button) → channel/track/type → generate → copy or paste into LinkedIn
- **Copilot FAB** (Sparkles) → text/image → OCR → parse-activity → save
- **Per-agent contact/company pages** at `/agents/[id]/contacts/[contactId]` (single-owner architecture)

---

## 12. extension — folder layout (`extension/`)

```
extension/
├── manifest.json         ← MV3 v1.0.54, host_permissions for linkedin/gmaps/crunchbase
├── background/
│   └── service-worker.js ← WS to agentcore, task pickup, message router
├── content/
│   ├── bootstrap.js
│   ├── linkedin/
│   │   ├── search-companies.js   ← industry-target scrape (popup/rate-limit aware)
│   │   ├── fetch-company.js      ← /about scrape
│   │   ├── fetch-company-info.js / fetch-company-team.js ← split, hostname-guarded
│   │   ├── profile-sidebar.js    ← "Add to CRM" widget (bottom-right)
│   │   ├── copilot-inline.js/.css ← NEW: ✨ inbox reply drafting in compose box
│   │   └── studio-button.js / studio-popup.js/.css ← NEW: profile → generate message (bottom-left)
│   ├── gmaps/
│   │   ├── maps-core.js          ← NEW: zero-dep scraper core (search + place detail)
│   │   ├── capture-panel.js      ← NEW: floating bulk-capture panel on search pages
│   │   ├── fetch-business.js     ← thin wrapper over maps-core.scrapePlace()
│   │   └── search-businesses.js  ← thin wrapper over maps-core.scrapeSearch()
│   └── crunchbase/               ← legacy
├── lib/
│   ├── auth-client.js, ws-client.js, rate-limiter.js, scraper-utils.js
├── popup/  (popup.html, popup.js)
├── config.js             ← BACKEND_URL
└── scripts/release.sh    ← Builds ZIP + signed CRX, writes latest.json
```

### Google Maps scraping (`content/gmaps/maps-core.js`)
Self-contained, **locale-independent** scraper — critical because the client runs **Chrome in Arabic**, so all section titles/labels render in Arabic. Selectors use **class / `data-item-id` / `jsname` / `jsaction` / `role` only — never localized text**, and locale-bearing prose (reviews, about) is captured as **raw HTML** for the backend to translate/re-render.

Extracts from a place page: `name`, `category`, `address`, `phone`, `website`, `rating`, `reviewCount`, `mapsUrl`, `coordinates`, `plusCode`, `priceLevel`, `pricePerPerson`, `directionsUrl` (built from coords), weekly `hours`, `serviceOptions[]`, `photoUrls[]` (≤4 googleusercontent URLs), `menuLink`, editorial `description`, `reviewsHtml` + `ratingDistribution[]`, and `aboutHtml`. Helpers: `waitForSelector` (bounded MutationObserver — fixes the info-row render race), `sanitizeAndCap`/`capTotal` (strip script/style/`on*`/`javascript:`, cap length), `extractReviewsHtml` (scrolls the review container, ~12 reviews raw), `extractAboutHtml` (expands attributes via `jsaction`), `extractHours` (async; expands lazy dropdown), `extractPricePerPerson`, `parseRating` (locale decimals "4,5"→4.5), `parseCoordinates`. Exposes `window.__mapsCore` (`scrapeSearch`, `scrapePlace`, `loadMore`, …).

### Extension flows
1. **Auto-dispatched tasks** — agentcore enqueues `extension_tasks`; SW receives via WS, opens/focuses tab, injects adapter, posts `task_result`. `fetch_company_info` and `fetch_company_team` are now **independent** rows (team fetch no longer blocks info). Hostname guards abort if injected onto a non-LinkedIn tab.
2. **Snov.io-style manual add** — `profile-sidebar.js` mounts on `/in/*`; "+ Add to CRM" → `POST /api/extension/contacts/manual` → backend fans out to the user's agents that own the company.
3. **Google Maps capture** — `capture-panel.js` on Maps search pages → select/load-more businesses → `gmaps_capture` message → `POST /api/extension/gmaps/capture` → `ingestGmapsBusiness` (company + business-contact + Lead deal) → detail scrapes + menu jobs fan out.
4. **LinkedIn Inbox Copilot** — `copilot-inline.js` injects a ✨ button into DM compose boxes; scrapes ≤10 thread turns (direction-detection cascade) → `copilot_draft_reply` → `POST /api/copilot/draft-reply` → pastes draft into the box (modes: generate / polish / shorter / more-direct / different-angle).
5. **LinkedIn Studio** — `studio-button.js` (bottom-left ✨ on `/in/*`) opens `studio-popup.js`; scrapes the profile, picks channel/type/track → `studio_generate` → `POST /api/studio/generate` → copy or paste into DM/connection; sent actions reported via `studio_record_action` → `POST /api/studio/record-action`.

### Service-worker message routes (new)
`studio_generate`, `studio_record_action`, `gmaps_capture`, `copilot_draft_reply` — each POSTs to its backend endpoint and returns `{ok, …}`. On WS open the SW runs `reconcileRateLimitsFromServer()` to sync authoritative daily counts; 5+ consecutive 429s trip a midnight-UTC block; batch cooldowns persist via `chrome.alarms`.

---

## 13. Sales Operations layer (Daily Queue, triage, follow-ups)

Human-in-the-loop layer that runs alongside the autonomous pipeline. **Review-and-send only** — it never auto-sends.

### Company-centric triage → Daily Queue
`triage.service.ts` runs **13 rules** over the `companies` table (not contacts), producing at most **one pending `prospect_actions` row per company** (enforced by partial unique index). Each rule picks a recommended target contact (last-touched for follow-ups, title-ranked for fresh outreach, inbound sender for hot replies) and surfaces up to **4 alternative contacts** so the operator can **retarget** within one card. Actions are bucketed **P0–P3** with `why_now` + `strategy_note` + an optional draft. Triage runs on the **`0 6 * * *` cron**, on inbound events (`microTriage`), and on demand via `POST /api/queue/refresh` (hard cap 3/day per user). The dashboard `/queue` page (and per-agent `queue` tab) reads `GET /api/queue` and stays live via the `queue:ready` WS event + safety-net polling.

### Stage tracking (dual)
- `prospect_stages` (contact-scoped, 1:1) holds the per-contact pipeline stage vocabulary; written via `prospect-stage.service.ts` (never demotes, emits `stage_change` timeline events).
- `companies.*` aggregates (touches, last inbound/outbound, current_stage) are maintained by `company-stage.service.ts` and are the **only** source triage reads. Every contact-level `recordTouch`/`recordResponse` mirrors up to the company.

### Follow-up engine (CRM-pipeline driven)
`stage-classifier.service.ts` marks which `crm_stages` are `follow_up_eligible` (one LLM call; user overrides permanent). For deals in eligible stages, `followup-engine.service.ts` maintains `followup_sequences` (touch 1 → first_followup, 2 → second_followup, final → breakup) with intervals from `followup-cadence.service.ts` (`tenants.settings.followupCadence`, fast/mid/slow, per-lead override). The daily triage scan turns due sequences into Queue cards; sequences **halt** on inbound reply or stage change.

---

## 14. Strategy + dispatch model (autonomous pipeline)

### `userExplicitBdStrategy` lock (source of truth)
When the user picks "industry" / "hiring" / "hybrid" in chat, `chat.service.ts::parseExplicitStrategyReply` saves it to `master_agents.config.userExplicitBdStrategy`. Strategist passes it as `forcedBdStrategy`; the LLM cannot override it; the master-agent dispatcher re-validates at runtime; persistence never overwrites it.

### `pipelineSteps[]` — data-driven dispatch
```ts
pipelineSteps: Array<{
  id: string;
  tool: 'LINKEDIN_EXTENSION' | 'CRAWL4AI' | 'LLM_ANALYSIS' | 'REACHER' | 'EMAIL_PATTERN' | 'SCORING';
  action: string;          // e.g. 'search_companies', 'search_linkedin_jobs'
  dependsOn: string[];
  params: Record<string, unknown>;
}>
```
Master-agent dispatches each step by `tool` + `action`. Adding a strategy = strategist generates new steps; **no dispatcher code change**.

### Strategy idempotency
`strategist.agent.ts::executeInitialStrategy` short-circuits when a saved strategy with `pipelineSteps` exists, unless `force: true`.

---

## 15. Email finding + verification

`email-finder.tool.ts`:
1. Generate ≤12 candidates (9 templates × optional `_firsttoken` variant)
2. Check in-memory + DB cache for the domain's pattern → 0 SMTP cost
3. On miss: probe sequentially via Reacher, 1s gap, 300/day server-wide cap
4. On `safe`: persist pattern to `domain_patterns`, return the email
5. On `catch_all`: flag domain + skip
6. Manual override (`/contacts/:id/email/manual`): user types an email → 1 Reacher slot → atomic save

---

## 16. Multi-agent contact fan-out (extension manual-add)

"+ Add to CRM" on a LinkedIn profile → scrape name/title/company → `POST /api/extension/contacts/manual` (no `masterAgentId`) → backend matches companies **owned by the current extension user** → for EACH match: insert a `contacts` row (dedup by `linkedinUrl + masterAgentId`) + Lead-stage `deals` row + per-contact enrichment job → response lists every agent the contact landed under. No match → route to the user's most-active (fallback oldest) agent.

---

## 17. CRM model

`crm_stages` (per-tenant, default 7): Lead, Contacted, Replied, Meeting, Qualified, Won, Lost — now carrying `follow_up_eligible` / `follow_up_classified_by`.

`deals` = kanban cards. One per `(contact, masterAgentId)`. Auto-created via `ensureDeal()` from many touchpoints (manual send, new contact, qualifying activity, extension add, Copilot save, gmaps capture).

`crm_activities` enum: `email_sent`, `email_received`, `linkedin_message`, `linkedin_connection`, `manual_email_sent`, `call_made`, `meeting_held`, `note_added`, `system_event` (+ the 0034 sales-ops additions, written via `timeline.service.ts`).

---

## 18. Build + deploy

### agentcore
```
npm run dev / dev:workers     # tsx watch (api / workers in separate processes)
npm run build                 # tsc → dist/
npm run start / start:workers # node dist/*
npm run db:generate           # drizzle-kit generate (requires build first)
npm run db:migrate            # apply migrations
npm run db:seed / db:studio
npm test
```
> Migrations are frequently applied directly via `psql` against the server DB (the drizzle journal can be stale). Build **before** restarting pm2.

### dashboard
```
npm run dev / build / start / lint
```

### extension release
```
bash extension/scripts/release.sh
```
Reads `manifest.json` version → `talentai-v<version>.zip` + signed `.crx` + `latest.json` (consumed by `/extension/updates.xml`). Signing key `extension-private.pem` is **gitignored** — keep it safe; losing it breaks auto-update continuity. Chrome auto-updates within ~5h.

### pm2 (production)
- `ecosystem.config.cjs` → `agentcore` (api), `agentcore-workers`, `dashboard`
- Build first, then `pm2 reload <name>`; `pm2 logs <name>`

### Docker (alt)
- `agentcore/docker-compose.yml`: postgres:16, redis:7, pgbouncer, api, workers; plus the two Dockerfiles

---

## 19. Key invariants + gotchas

1. **All DB queries through `withTenant`** — RLS depends on it.
2. **bcryptjs not bcrypt** — avoids node-gyp/Python on Windows dev boxes.
3. **drizzle.config.ts points at `./dist/db/schema/*.js`** — run `npm run build` before `db:generate`.
4. **BullMQ + ioredis version mismatch** — cast connection as `any` at the BullMQ boundary.
5. **Bedrock OpenAI-compat endpoint is text-only** — vision (Maps menu OCR) must use the native **Converse** API with base64 bytes (Nova Lite works).
6. **Email creds live in DB**, not `.env`.
7. **Reacher 300/day** is server-wide across all tenants; per-domain pattern caching keeps it sustainable.
8. **Contacts have a single owner** (`masterAgentId`) and live under `/agents/[id]/contacts/*`. The global `/prospects` list is a read/triage view, not a second owner.
9. **Extension manual-add fans out** when a company exists under multiple of the user's agents.
10. **Strategy is generated ONCE** during agent setup; strategist short-circuits unless `force: true`.
11. **Pipeline dispatch is data-driven** via `pipelineSteps[]`.
12. **`userExplicitBdStrategy` lock** is the single source of truth for strategy choice.
13. **Google Maps selectors must be locale-independent** — the client runs Chrome in Arabic. Match on class/`data-item-id`/`jsname`/`jsaction` only; capture reviews + about as raw HTML.
14. **Triage is company-grained** — one pending `prospect_actions` per `(tenant, company)`; it reads from `companies.*` aggregates, not `prospect_stages`.
15. **No auto email replies** — inbound replies surface as Queue/copilot drafts only; nothing is sent without the human.
16. **Sender name never invented** — `sender.service.ts` throws `MISSING_SENDER_NAME` if `users.name` is unset (fail loud over fabricate).
17. **Studio + Inbox Copilot are audit-only** — `message_compositions` / `linkedin_*` rows record drafts; the user copies/pastes and sends manually.
18. **gmaps detail-field whitelist** — `extension-dispatcher.ts` only persists whitelisted Maps fields; new fields must be added there *and* in the capture Zod schema or they're silently dropped.

---

## 20. Where to look for…

| Question | File |
|---|---|
| Why isn't my industry agent dispatching extension tasks? | `master-agent.ts` (pipeline dispatch loop) + `strategist.agent.ts` (idempotency short-circuit) |
| How is a chat strategy choice saved? | `chat.service.ts::parseExplicitStrategyReply` |
| How does the manual email widget verify? | `contact.routes.ts::POST /:id/email/manual` + `email-finder.tool.ts` |
| Where does the Daily Queue come from? | `triage.service.ts` (rules) → `prospect_actions` → `queue.routes.ts` → dashboard `components/queue/` |
| How do follow-ups get scheduled? | `stage-classifier.service.ts` (eligibility) + `followup-engine.service.ts` + `followup-cadence.service.ts` |
| Where is a Maps business scraped? | `extension/content/gmaps/maps-core.js` → `gmaps-lead.service.ts::ingestGmapsBusiness` |
| Where is the Maps menu / AI recommendation generated? | `gmaps-website-menu.service.ts` / `gmaps-menu.service.ts` (worker) ; `gmaps-recommendation.service.ts` (`POST /contacts/:id/ai-recommendation`) |
| Where does the Maps business card render? | `dashboard/src/components/prospects/gmaps-business-card.tsx` |
| Where is a LinkedIn reply drafted? | `extension/content/linkedin/copilot-inline.js` → `copilot.routes.ts::POST /draft-reply` → `inbox-copilot.service.ts` |
| Where is a Studio message generated? | `studio.routes.ts::POST /generate` → `message-studio.service.ts` (+ `cold-email-drafter.service.ts` for email) |
| Where is the LLM model configured? | `tools/together-ai.tool.ts` (`SMART_MODEL`, `FAST_MODEL`) ; Kimi K2.5 in `cold-email-drafter.service.ts` |
| How does the dashboard know triage finished? | WS `queue:ready` via `websocket/realtime.ts` (+ safety-net polling in `use-queue.ts`) |

---

## 21. Glossary

- **Master agent / Sub-agent** — top-level user-configured agent (one `master_agents` row) vs. internal pipeline-stage worker triggered by BullMQ.
- **bdStrategy / userExplicitBdStrategy** — `hiring_signal` | `industry_target` | `hybrid`; the user's locked choice overrides any LLM inference.
- **pipelineSteps** — data-driven discovery/enrichment plan dispatched by tool/action.
- **Pipeline context** — `master_agents.config.pipelineContext` (locations/industries/services derived from mission).
- **Tenant** — workspace; isolation enforced by Postgres RLS.
- **Daily Queue / triage** — company-centric `prospect_actions` recommendations (P0–P3) generated by `triage.service.ts`; review-and-send.
- **prospect_stages vs company stages** — contact-scoped pipeline stage vs. company-level aggregates (the latter is what triage reads).
- **Follow-up sequence** — per-deal cadence state (`followup_sequences`) advanced by the follow-up engine; halts on reply / stage change.
- **Message Studio** — one-shot multi-channel message generator (email/LinkedIn/Twitter/WhatsApp/Telegram); audit-only.
- **Inbox Copilot** — LinkedIn DM reply drafter (✨ in compose box); audit-only.
- **gmaps_business** — a Google Maps business captured as a `contacts` row (`source_type='gmaps_business'`) with full place detail in `source_metadata`.
- **Reacher / Crawl4AI / SearXNG** — SMTP verifier (300/day) / server-side scraper / meta-search.
- **Extension session** — Chrome extension's authenticated link, now bound to a **user** (drains tasks across all their workspaces).
