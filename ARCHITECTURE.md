# TalentAI — Architecture Document

> Multi-tenant AI agent orchestration platform for automated B2B sales / recruitment lead generation.
> Generates personalized outbound campaigns powered by autonomous agents, served via a Next.js dashboard with a companion Chrome extension that scrapes LinkedIn on the user's behalf.

---

## 1. Top-level layout

```
c:\Users\hatem\agents\
├── agentcore/         ← Fastify 5 backend, BullMQ workers, Postgres + Redis
├── dashboard/         ← Next.js 15 (App Router) UI
├── extension/         ← Chrome MV3 extension (LinkedIn scraping + manual contact add)
├── extension-releases/← Built ZIP / CRX bundles served by /extension/* endpoints
├── DEPLOYMENT.md      ← Server deploy notes
└── ecosystem.config.cjs ← pm2 process map for the three Node services
```

Three tiers, deployed independently:

1. **agentcore** — REST API (`api`) + WebSocket (`/ws`) + queue workers (`workers`). Holds **all state** in Postgres; Redis is queues + ephemeral cache.
2. **dashboard** — server-rendered/client-hydrated Next.js app, talks to agentcore via REST + WS. No own DB.
3. **extension** — sandboxed scraper that runs on the user's signed-in LinkedIn / Crunchbase / Google Maps tab. Communicates with agentcore via WebSocket (server-issued tasks) and HTTPS (manual actions).

```
   ┌─────────────────────────────────────────────────────────┐
   │ User's browser (signed in to LinkedIn)                  │
   │                                                          │
   │  Dashboard tab ◄───HTTPS REST + WS──► agentcore (api)   │
   │                                                          │
   │  Chrome extension ◄───WSS──────────► agentcore (ws)     │
   │   • popup                                                │
   │   • content scripts on linkedin.com                      │
   │   • profile-sidebar widget                               │
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
        (Drizzle ORM, RLS)         pub/sub + cache)        (Bedrock LLM, Reacher,
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
- **Queues**: BullMQ 5 + ioredis 5, per-tenant queue names + dead letter
- **LLM**: AWS Bedrock OpenAI-compatible endpoint (`together-ai.tool.ts` despite its name) + Anthropic SDK fallback (`claude.tool.ts`). Default model `openai.gpt-oss-120b-1:0`, smart model `deepseek.v3.2`, fast model `openai.gpt-oss-20b-1:0`
- **Scraping**: Crawl4AI (server-side, public pages), SearXNG (web search)
- **Email**: nodemailer (SMTP), imapflow (IMAP append to Sent), node-pop3 (POP3 polling), Reacher (SMTP verification, 300/day server-wide cap)
- **Documents**: pdf-parse v2, mammoth (DOCX)
- **Validation**: Zod
- **Logging**: pino + pino-pretty
- **Tests**: Vitest

### dashboard (`dashboard/package.json`)

- **Runtime**: Next.js 15, React 19, App Router
- **State**: TanStack Query 5 (server state), Zustand 5 (UI state)
- **HTTP**: Axios (with interceptors)
- **UI**: Tailwind 3, Radix UI primitives, lucide-react icons, recharts (analytics)
- **DnD**: @dnd-kit/core + @dnd-kit/sortable (CRM kanban)
- **OCR**: Tesseract.js (Copilot FAB image-to-activity)
- **Dates**: date-fns

### extension (`extension/manifest.json` v1.0.14)

- **Manifest V3** Chrome extension, ESM service worker
- Background service worker (`background/service-worker.js`) + content scripts (`content/linkedin/*`, `content/gmaps/*`, `content/crunchbase/*`)
- Auto-injected content script: `content/linkedin/profile-sidebar.js` (Snov.io-style widget on `/in/*` pages)
- On-demand injection via `chrome.scripting.executeScript` for fetch-company / search-companies adapters
- Auth: JWT in `chrome.storage.local`, talks to agentcore via `wss://` for task pickup and `https://` for manual actions
- Distribution: signed CRX served from `https://agents.api.talentailabs.com/extension/updates.xml` (self-hosted Chrome auto-update)

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
│   ├── schema/             ← 38 Drizzle tables (see §4)
│   ├── migrations/         ← drizzle-kit-generated SQL
│   └── seed.ts             ← Local seed (admin@acme.com / password123)
├── routes/                 ← Fastify route modules (see §5)
├── agents/                 ← Autonomous AI agents (see §6)
├── workers/                ← BullMQ workers (one per agent type)
├── queues/                 ← Queue setup, registration, scheduled jobs
├── services/               ← Cross-cutting business logic (see §7)
├── tools/                  ← Stateless integrations (LLM, scrapers, email)
├── prompts/                ← Per-agent system + user prompts
├── templates/              ← Email HTML wrapper, plain-text sanitizer
├── types/                  ← Shared TS types (PipelineContext, SalesStrategy)
├── middleware/             ← auth, rate-limit, tenant
├── utils/                  ← errors, logger, json-extract, mission-intent
├── websocket/              ← Realtime relay + extension WS handlers
└── scripts/                ← One-shot DB / debug scripts (see §8)
```

### How the layers fit

- **routes/** call **services/** which call **tools/** and read/write **db/schema/**
- **agents/** are long-running orchestrators triggered by **queues/** (BullMQ jobs)
- **workers/** are thin BullMQ listener wrappers around each agent class
- **websocket/** pushes events to the dashboard and dispatches tasks to the extension

---

## 4. Database schema (`src/db/schema/`)

Multi-tenant. Every domain table has `tenant_id` and is gated by Postgres RLS through `withTenant`.

### Tenant + auth (5 tables)
- `tenants` — workspaces (`name`, `slug`, `settings.companyProfile`)
- `users` — accounts (`email`, `passwordHash`, `tenantId`, `role`)
- `user_tenants` — many-to-many for users with multiple workspaces
- `invitations` — invite-by-email pending acceptances
- `agent_activity_log` — audit trail of every agent action

### Agents + orchestration (6 tables)
- `master_agents` — top-level agent (`mission`, `useCase: 'recruitment'|'sales'|'custom'`, `config` JSONB, `status`, `actionPlan`, `reviewMode`, `dailyRuntimeBudgetMs`, `createdBy`)
- `agent_configs` — per-step configs for sub-agents
- `agent_tasks` — generic task ledger
- `agent_messages` — inter-agent message queue (now mostly Redis pubsub)
- `agent_memory` — Redis-backed memory snapshots
- `agent_daily_strategy` — strategist outputs by day

### Discovery → CRM funnel (10 tables)
- `companies` — discovered orgs (`domain`, `industry`, `size`, `linkedinUrl`, `rawData`)
- `contacts` — people (`firstName`, `lastName`, `email`, `linkedinUrl`, `companyId`, `masterAgentId`, `score`, `status`, `rawData`)
- `opportunities` — qualified leads (joins contact + company + master agent + buying-intent score)
- `crm_stages` — pipeline columns (Lead, Contacted, Replied, Meeting, Qualified, Won, Lost)
- `deals` — kanban cards (one per `(contact, masterAgent)` pair, joined to a stage)
- `crm_activities` — timeline events (call, meeting, email, linkedin_*, manual_*, system)
- `documents` — uploaded CVs, job specs, briefs (PDF / DOCX / TXT)
- `interviews` — scheduled interview events
- `reddit_opportunities` — Reddit-monitor findings
- `pipeline_errors` — sub-agent failure log

### Email + outreach (8 tables)
- `email_accounts` — per-user mailbox creds (SMTP/IMAP/POP3)
- `email_listener_configs` — IMAP/POP3 polling configs
- `email_intelligence` — domain SMTP / catch-all data
- `email_queue` — outbound queue (BullMQ-shadowed)
- `emails_sent` — sent-mail ledger
- `outreach_emails` — per-step campaign emails
- `email_threads` — thread tracking
- `replies` — inbound email replies (classified)

### Campaigns (3 tables)
- `campaigns` — multi-step campaign definitions
- `campaign_steps` — ordered email/wait steps
- `campaign_contacts` — enrollment + status per contact

### Conversations + extension (4 tables)
- `conversations` — chat sessions (per master agent)
- `conversation_messages` — chat turns
- `extension_sessions` — per-tenant Chrome extension sessions (api key hashed)
- `extension_tasks` — server-issued scrape tasks (site, type, params, status, dispatch_after, priority, result)

### Pattern + intel (2 tables)
- `domain_patterns` — known email patterns per domain (for skipping Reacher SMTP probes)
- `products` — tenant's products / services (powers prompt context)

RLS: `scripts/setup-rls.sql` creates one policy per tenant-owned table. Every query inside a transaction wrapped in `withTenant(tenantId, fn)` runs with `set_config('app.current_tenant', $1, true)` so RLS filters apply automatically.

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
| `contact.routes.ts` | `/api/contacts/*` | contact CRUD, **manual email** (Reacher-verified), find-email, draft-email, send-email |
| `company.routes.ts` | `/api/companies/*` | company CRUD + enrichment trigger |
| `crm.routes.ts` | `/api/crm/*` | stages, deals, activities; `/copilot/parse-activity` LLM endpoint |
| `activity.routes.ts` | `/api/activities/*` | activity timeline |
| `opportunity.routes.ts` | `/api/opportunities/*` | qualified leads |
| `campaign.routes.ts` | `/api/campaigns/*` | multi-step campaign mgmt |
| `document.routes.ts` | `/api/documents/*` | upload + parse PDF/DOCX |
| `email-account.routes.ts` | `/api/email-accounts/*` | SMTP/IMAP/POP creds (per-user) |
| `email-listener.routes.ts` | `/api/email-listeners/*` | inbound polling configs |
| `mailbox.routes.ts` | `/api/mailbox/*` | unified inbox view |
| `linkedin.routes.ts` | `/api/linkedin/*` | LinkedIn scrape orchestration |
| `extension.routes.ts` | `/api/extension/*` | extension auth, session mgmt, **manual contact add** (the Snov.io-style widget endpoint) |
| `extension-distribution.routes.ts` | `/extension/*` | serves CRX/ZIP + updates.xml |
| `analytics.routes.ts` | `/api/analytics/*` | dashboard stats |
| `tracking.routes.ts` | `/track/*` | open-pixel + unsubscribe |
| `schedule.routes.ts` | `/api/schedule/*` | scheduled jobs |
| `product.routes.ts` | `/api/products/*` | tenant product catalogue (used by email prompts) |
| `copilot.routes.ts` | `/api/copilot/*` | AI Copilot FAB endpoints |
| `workspace.routes.ts` | `/api/workspaces/*` | multi-workspace switching |

WebSocket endpoints (`src/websocket/`):
- `realtime.ts` — `/ws/realtime` Redis-backed pubsub fan-out to dashboard
- `extension.ts` — `/ws/extension` server-issued task dispatch + result ingestion

---

## 6. agentcore — agents (`src/agents/`)

Each agent class extends `BaseAgent` (`base-agent.ts`) which provides LLM helpers, Redis memory, event emit, and `dispatchNext` chain.

### Top-level orchestrator
- **`master-agent.ts`** — drives the whole pipeline. Loads `pipelineContext` + `salesStrategy`, runs the **strategist**, then **dispatches `pipelineSteps[]` data-driven** (each step's `tool` ∈ `LINKEDIN_EXTENSION | CRAWL4AI | LLM_ANALYSIS | REACHER | EMAIL_PATTERN | SCORING` → matching dispatch action). Persists strategy to `master_agents.config.salesStrategy`.

### Strategy
- **`strategist.agent.ts`** — generates the `SalesStrategy` (bdStrategy + targetIndustries + hiringKeywords + pipelineSteps). Honors `userExplicitBdStrategy` lock from chat. Has deterministic fallback when LLM fails. **Idempotent**: short-circuits when a saved strategy with pipelineSteps already exists, unless `force: true` is passed.
- **`strategy.agent.ts`** — older variant (legacy)

### Discovery (find candidates / leads)
- **`discovery.agent.ts`** — generic web search via SearxNG, classifies LinkedIn vs other URLs
- **`company-finder.agent.ts`** — company-search variant (used in industry strategy)
- **`candidate-finder.agent.ts`** — candidate-search variant (used in recruitment)
- **`linkedin.agent.ts`** — LinkedIn-specific orchestration

### Per-contact pipeline (after discovery)
- **`document.agent.ts`** — parses LinkedIn profiles, CVs, JDs into structured contact records
- **`enrichment.agent.ts`** — finds emails (`findEmailByPattern`), domain enrichment
- **`scoring.agent.ts`** — LLM-scores contacts vs job requirements (0-100)
- **`outreach.agent.ts`** — generates personalized emails via LLM, sends via SMTP, schedules follow-ups
- **`reply.agent.ts`** — classifies inbound replies (interested / objection / not_now / OOO / unsubscribe / bounce) and triggers next action
- **`action.agent.ts`** — executes side effects on classified replies (book meeting, archive, etc.)

### Inbox + monitors
- **`mailbox.agent.ts`** — unified inbox classification + LLM helpers
- **`email-listener.agent.ts`** — IMAP/POP3 polling + reply ingestion
- **`reddit-monitor.agent.ts`** — Reddit DM-opportunity scout

### Pipeline flow
```
discovery → document (LinkedIn profiles) → enrichment → scoring → outreach → reply → action
```

---

## 7. agentcore — services (`src/services/`)

Cross-cutting business logic that doesn't fit one agent.

| File | Responsibility |
|---|---|
| `auth.service.ts` | password hashing (bcryptjs), JWT issuance, refresh-token rotation in Redis |
| `tenant.service.ts` | workspace creation, RLS bootstrap |
| `chat.service.ts` | conversation lifecycle, **explicit-strategy reply parser** (chip A/B/C → `userExplicitBdStrategy`), classifyMissionIntent, quick-reply chip synthesis |
| `crm-activity.service.ts` | logActivity, ensureDeal (idempotent deal creation at Lead stage) |
| `contact-match.service.ts` | word-boundary matcher used by Copilot to reconcile a typed name to a contact |
| `copilot.service.ts` | Copilot FAB orchestration (text + OCR → LLM parse → activity) |
| `extension-dispatcher.ts` | enqueueExtensionTask, tryDispatch, drainPending, **manual contact add → multi-agent fan-out**, sanitizePersonName, rankPeopleByTitle |
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

Stateless wrappers around external services.

| Tool | What it wraps |
|---|---|
| `together-ai.tool.ts` | **AWS Bedrock OpenAI-compatible endpoint** (despite the legacy name); functions: `complete`, `completeStream`, `extractJSON`, `SMART_MODEL`, `FAST_MODEL` |
| `claude.tool.ts` | Anthropic SDK wrapper, also routes through Bedrock |
| `searxng.tool.ts` | SearXNG meta-search (with global rate limits) |
| `crawl4ai.tool.ts` | Crawl4AI HTTP client for server-side scrapes |
| `discovery-engine.ts` + `discovery-sources/` | unified discovery wrapper (LinkedIn, Welcome to the Jungle, Free-Work, etc.) |
| `linkedin-jobs.tool.ts` | Public LinkedIn Jobs scrape via Crawl4AI; auto-chains `fetch_company` extension tasks |
| `linkedin-voyager.tool.ts` | LinkedIn Voyager (private API) helpers |
| `email-finder.tool.ts` | **9-pattern email guesser** + Reacher SMTP verify, server-wide 300/day cap, per-domain pattern cache, catch-all detection |
| `email-intelligence.ts` | Domain-level email intel (MX records, accept-all status) |
| `email-queue.tool.ts` | per-account quota selection + queue delivery |
| `imap-sent-append.tool.ts` | IMAP APPEND so sent mail shows up in Privateemail/Outlook Sent folder |
| `smtp.tool.ts` | nodemailer wrapper with List-Unsubscribe headers + IMAP append |
| `pdf-parser.tool.ts` | pdf-parse v2 (`new PDFParse({data: buf}).getText()`) |
| `docx-parser.tool.ts` | mammoth |
| `smart-crawler.ts` | sitewide-aware crawl wrapper |

### Email-finder pattern set (9 templates + first-token variants)

```
first.last  flast    first    f.last
firstlast   last.first  first_last  last
f1l1                                          ← initials
+ _firsttoken variants for hyphenated first names (Vlad-George Iacob → vlad.iacob)
```

Reacher: 1s gap between probes, 300/day across all tenants, per-domain pattern cached in memory + `domain_patterns` table.

---

## 9. agentcore — prompts (`src/prompts/`)

Each prompt file exports `buildSystemPrompt` / `buildUserPrompt` for one agent or operation. Notable files:

- `master-agent.prompt.ts` — orchestrator's reasoning prompt
- `strategist.prompt.ts` — generates `SalesStrategy` with bdStrategy + pipelineSteps. Has `forcedBdStrategy` constraint mode that's prepended when `userExplicitBdStrategy` is set
- `pipeline-builder.prompt.ts` — separate pipeline-builder used by `/api/master-agents/analyze-pipeline`
- `discovery.prompt.ts` / `company-finder.prompt.ts` / `candidate-finder.prompt.ts` — query expansion + page classification
- `document.prompt.ts` / `candidate-profile.prompt.ts` — extracts structured contact data from LinkedIn/CV text
- `enrichment.prompt.ts` / `company-deep.prompt.ts` — domain enrichment + deep profile build
- `scoring.prompt.ts` — contact scoring with rubric
- `sales-email-generation.ts` / `recruitment-email-generation.ts` — generate plain-text personalized emails (used by both auto outreach AND manual `/draft-email`)
- `outreach.prompt.ts` — campaign-step orchestration
- `reply.prompt.ts` / `inbound-email.prompt.ts` — classify inbound emails
- `action.prompt.ts` / `action-plan.prompt.ts` — action selection + multi-step planning
- `chat-agent.prompt.ts` — chat assistant inside an agent's room
- `mailbox.prompt.ts` — unified inbox triage
- `copilot.prompt.ts` / `copilot-activity.prompt.ts` — Copilot FAB OCR-to-activity parser
- `classification.prompt.ts` — generic classifier
- `agent-selector.prompt.ts` — multi-agent routing

---

## 10. agentcore — queues + workers (`src/queues/`, `src/workers/`)

- BullMQ 5, ioredis 5, **per-tenant queue prefix** so isolation survives multi-tenancy
- `setup.ts` — Redis connection factory
- `queues.ts` — registered queues (one per agent type + dead-letter)
- `workers.ts` — registers all workers, schedules repeatable jobs (email-polling, runtime-budget reset)
- `dead-letter.ts` — failed-job sink

Each agent has a 1:1 worker file (`workers/<agent>.worker.ts`) that:
1. Pulls a job
2. Records a row in `agent_tasks` (createTaskRecord)
3. Calls the corresponding agent's `execute()`
4. Records completion / failure (completeTaskRecord / failTaskRecord)
5. Optionally chains the next agent via `dispatchNext`

---

## 11. dashboard — folder layout (`dashboard/src/`)

```
src/
├── app/
│   ├── (auth)/           ← login, register
│   ├── (dashboard)/      ← all post-login pages
│   │   ├── agents/       ← agent list + [id] detail with chat & rooms
│   │   ├── crm/          ← kanban pipeline (deal-board.tsx)
│   │   ├── analytics/    ← recharts dashboards
│   │   ├── campaigns/    ← multi-step campaign editor
│   │   ├── dashboard/    ← home
│   │   ├── documents/    ← upload + parse
│   │   ├── linkedin-extension/ ← extension install + status
│   │   ├── mailbox/      ← unified inbox
│   │   ├── schedule/     ← scheduled jobs
│   │   └── settings/     ← profile, products, email, extension, team, company
│   ├── invite/           ← invite-acceptance landing
│   ├── layout.tsx        ← root layout (Providers)
│   ├── providers.tsx     ← TanStack Query, Toaster, theme
│   └── page.tsx          ← marketing landing redirect
├── components/
│   ├── agents/           ← create-agent-wizard, pipeline-builder, agent-room, action-plan-panel, strategy-panel, system-alert-card, etc.
│   ├── crm/              ← deal-board, deal-card, stage-badge, activity-timeline, add-activity-dialog, contact-picker, new-deal-dialog
│   ├── chat/             ← agent-chat with streaming + quick-reply chips
│   ├── companies/        ← company list + detail panels
│   ├── contacts/         ← contact-table, email-compose-modal, **email-editor** (manual-email + Reacher verify)
│   ├── copilot/          ← activity-fab (Sparkles button, Tesseract OCR, LLM parse → save)
│   ├── analytics/        ← stat cards
│   ├── documents/        ← upload + list
│   ├── mailbox/          ← inbox UI
│   ├── schedule/         ← scheduled jobs UI
│   ├── shared/           ← shared widgets
│   ├── layout/           ← sidebar, breadcrumb, header
│   └── ui/               ← Radix-derived primitives (Button, Input, Card, Dialog, ...)
├── hooks/                ← TanStack Query hooks (use-contacts, use-companies, use-crm, ...)
├── stores/               ← Zustand stores (UI state)
├── lib/                  ← api.ts (Axios client), utils.ts (cn, formatDate)
└── types/                ← shared TS types
```

### Key UX flows

- **Agent creation wizard** → mission text → quick-reply chip pick → strategist generates pipeline → user reviews 8-step Execution Pipeline → click Run
- **CRM Pipeline** (`/crm`) → DnD-kit kanban (Lead/Contacted/Replied/Meeting/Qualified/Won/Lost) → optimistic move + rollback
- **Copilot FAB** (Sparkles button bottom-right) → text or image input → Tesseract OCR (lazy-loaded ~3MB WASM) → `/api/copilot/parse-activity` → contact picker → save
- **Per-agent contact / company pages** at `/agents/[id]/contacts/[contactId]` and `/agents/[id]/companies/[companyId]` — single-owner architecture (no global `/contacts` route)
- **Inline email editor** with Reacher-verified atomic save on contact + company-team rows

---

## 12. extension — folder layout (`extension/`)

```
extension/
├── manifest.json         ← MV3, host_permissions for linkedin/gmaps/crunchbase
├── background/
│   └── service-worker.js ← WS to agentcore, task pickup, message router
├── content/
│   ├── bootstrap.js
│   ├── linkedin/
│   │   ├── search-companies.js  ← industry-target scrape (auth-gated)
│   │   ├── fetch-company.js     ← /people/ tab + /about/ scrape, top-3 ranked persons
│   │   └── profile-sidebar.js   ← Snov.io-style floating widget on /in/* pages (auto-injected via content_scripts)
│   ├── gmaps/                   ← Google Maps business search/fetch
│   └── crunchbase/              ← Crunchbase company search/fetch
├── lib/
│   ├── auth-client.js    ← JWT login/refresh, authedFetch
│   ├── ws-client.js      ← Reconnecting WebSocket to /ws/extension
│   ├── rate-limiter.js   ← Per-task minDelayMs + per-day caps mirror of server
│   └── scraper-utils.js  ← shared cleanLinkedInA11yText, isValidName, decodeSlugToName
├── popup/
│   ├── popup.html        ← Sign-in, current task status, pause/resume, usage
│   └── popup.js
├── config.js             ← BACKEND_URL constant
└── scripts/
    └── release.sh        ← Builds ZIP + signed CRX, writes latest.json
```

### Extension flows

1. **Auto-dispatched tasks** — agentcore enqueues `extension_tasks` rows; service worker receives via WS, opens/focuses tab, injects adapter via `chrome.scripting.executeScript`, posts result back as `task_result`
2. **Snov.io-style manual add** — `profile-sidebar.js` mounts on every `linkedin.com/in/<handle>/` page; user picks no agent (auto-routed) and clicks "+ Add to CRM"; service worker POSTs to `/api/extension/contacts/manual`; backend fans out to all the user's agents that own the company

### Adapter scrape result schema

`{ name, title, companyName, linkedinUrl }` for profiles; `{ name, domain, industry, size, linkedinUrl, people[] }` for companies. The `people[]` array is ranked by title (CEO/CTO/Founder/HR/Recruiter > engineers) and capped at 3.

---

## 13. Strategy + dispatch model

### `userExplicitBdStrategy` lock (the source of truth)

When the user picks "industry" / "hiring" / "hybrid" in chat, `chat.service.ts::parseExplicitStrategyReply` saves the choice to `master_agents.config.userExplicitBdStrategy`. Strategist + master-agent both honor this lock:

1. Strategist passes it as `forcedBdStrategy` into the system prompt
2. After LLM returns, strategist filters out any `pipelineSteps[]` that contradict the lock and replaces with deterministic steps if validation fails
3. Master-agent dispatcher re-validates at runtime (defense-in-depth)
4. Persistence never overwrites `userExplicitBdStrategy`

### `pipelineSteps[]` — data-driven dispatch

The strategist outputs:

```ts
pipelineSteps: Array<{
  id: string;
  tool: 'LINKEDIN_EXTENSION' | 'CRAWL4AI' | 'LLM_ANALYSIS' | 'REACHER' | 'EMAIL_PATTERN' | 'SCORING';
  action: string;       // e.g. 'search_companies', 'search_linkedin_jobs'
  dependsOn: string[];
  params: Record<string, unknown>;
}>
```

Master-agent iterates and dispatches each step by `tool` + `action`. Adding a new strategy = strategist generates new steps; **no dispatcher code change**.

### Strategy idempotency

`strategist.agent.ts::executeInitialStrategy` short-circuits when `master_agents.config.salesStrategy.pipelineSteps` already exists, unless `force: true` is passed. The pipeline is generated **once** during chat setup and reused on every run.

---

## 14. Email finding + verification

**`email-finder.tool.ts`**:

1. Generate up to 12 candidates: 9 base templates × optional `_firsttoken` variant for hyphenated names
2. Check in-memory + DB cache for the domain's known pattern → 0 SMTP cost
3. If cache miss: probe each candidate sequentially via Reacher, 1s gap, 300/day server-wide cap
4. On `safe`: persist pattern to `domain_patterns`, return the email
5. On `catch_all`: flag domain and skip — catch-all responses prove nothing
6. Manual override path (`/api/contacts/:id/email/manual`): user types an email → 1 Reacher slot → atomic save with `emailVerified` derived from result

---

## 15. Multi-agent contact fan-out (extension manual-add)

When the user clicks "+ Add to CRM" on a LinkedIn profile:

1. Extension scrapes name/title/company via 5-priority chain (H1/H2 → aria-label → title-tag → URL slug)
2. POST `/api/extension/contacts/manual` (no `masterAgentId` in payload)
3. Backend looks up companies by name **owned by the current extension user** (`master_agents.created_by = userId`)
4. For EACH match: insert a separate `contacts` row (dedup by `linkedinUrl + masterAgentId`) + create a Lead-stage `deals` row + dispatch per-contact enrichment job
5. If no company match: route to the user's most-active agent (fallback: oldest agent)
6. Response lists every agent the contact landed under — widget displays the fan-out

Contact appears simultaneously in: agent's contacts list, company team page, CRM Pipeline (Lead column).

---

## 16. CRM model

`crm_stages` (per-tenant, default 7): Lead, Contacted, Replied, Meeting, Qualified, Won, Lost.

`deals` table = kanban cards. One per `(contact, masterAgentId)` pair. Auto-created via `ensureDeal()` from many touchpoint paths:
- Manual `/send-email`
- POST `/contacts` (new contact)
- POST `/crm/activities` for qualifying types (call, meeting, email, linkedin_*)
- Extension manual contact add
- AI Copilot activity save

`crm_activities` enum types include: `email_sent`, `email_received`, `linkedin_message`, `linkedin_connection`, `manual_email_sent`, `call_made`, `meeting_held`, `note_added`, `system_event`.

---

## 17. Build + deploy

### agentcore commands
```
npm run dev           # tsx watch src/index.ts
npm run dev:workers   # tsx watch src/queues/workers.ts (separate process)
npm run build         # tsc → dist/
npm run start         # node dist/index.js
npm run start:workers # node dist/queues/workers.js
npm run db:generate   # drizzle-kit generate (requires build first)
npm run db:migrate    # apply migrations
npm run db:seed       # seed admin@acme.com / password123
npm run db:studio     # drizzle-kit studio
npm test
```

### dashboard commands
```
npm run dev    # next dev (port 3000)
npm run build  # next build
npm start      # next start
npm run lint
```

### extension release
```
bash extension/scripts/release.sh
```
Reads version from `manifest.json`, produces `talentai-v<version>.zip` + signed `.crx`, writes `latest.json` consumed by `/extension/updates.xml`. Chrome auto-updates within ~5h; users can force via `chrome://extensions` → Update.

### pm2 (production)
- `ecosystem.config.cjs` defines: `agentcore` (api), `agentcore-workers`, `dashboard`
- Restart: `pm2 reload <name>`
- Logs: `pm2 logs <name>`

### Docker (alt)
- `agentcore/docker-compose.yml`: postgres:16, redis:7, pgbouncer, api, workers
- `agentcore/Dockerfile`, `dashboard/Dockerfile`

---

## 18. Diagnostic + maintenance scripts (`agentcore/scripts/`)

| Script | Purpose |
|---|---|
| `setup-rls.sql` | Create RLS policies on every tenant-owned table |
| `backfill-user-tenants.mjs` | Migrate users → user_tenants join |
| `fix-people-names.mjs` | Repair URL-encoded / single-name entries in `companies.raw_data->people` |
| `fix-contacts-junk-names.mjs` | One-shot cleanup for "Verified Shepherd"-style scraper-residue contacts (slug recovery + null fallback) |
| `test-mailbox-agent.ts` | Mailbox agent smoke test |
| `test-scraping-pipeline.ts` | Discovery pipeline smoke test |
| `test-send-account.mjs` | SMTP send + IMAP append validation |
| `SYSTEM-ARCHITECTURE.md` | (older notes — superseded by this doc) |

---

## 19. Key invariants + gotchas

1. **All DB queries through `withTenant`** — RLS depends on it. Bypassing leaks data across tenants.
2. **bcryptjs not bcrypt** — bcrypt requires node-gyp/Python which fails on Windows dev boxes.
3. **drizzle.config.ts points at `./dist/db/schema/*.js`** — not src/. Run `npm run build` before `db:generate`.
4. **BullMQ + ioredis version mismatch** — cast connection as `any` at the BullMQ boundary.
5. **Bedrock OpenAI-compatible endpoint** does NOT support Nova models — those need the Converse API.
6. **Email creds live in DB**, not `.env` — per-account SMTP/IMAP/POP3 in `email_accounts` + `email_listener_configs`.
7. **Reacher 300/day** is server-wide across ALL tenants. Per-domain pattern caching keeps it sustainable.
8. **Contacts post-refactor have a single owner** (`masterAgentId`) and live under `/agents/[id]/contacts/*`. No global `/contacts` page.
9. **Extension manual-add fans out** when a company exists under multiple of the user's agents — one contact row + one deal per matching agent.
10. **Strategy is generated ONCE** during agent setup. The strategist short-circuits on subsequent runs unless explicitly forced via `force: true`.
11. **Pipeline dispatch is data-driven** via `pipelineSteps[]`. Adding strategies does NOT require dispatcher changes.
12. **The `userExplicitBdStrategy` lock** is the single source of truth for strategy choice. LLM cannot override it; runtime filter strips wrong-strategy steps as defense-in-depth.

---

## 20. Where to look for…

| Question | File |
|---|---|
| Why isn't my industry agent dispatching extension tasks? | `master-agent.ts:~470` (Pipeline-driven dispatch loop) + `strategist.agent.ts:~69` (idempotency short-circuit) |
| How is a chat strategy choice saved? | `chat.service.ts::parseExplicitStrategyReply` |
| How does the manual email widget verify? | `contact.routes.ts::POST /:id/email/manual` + `email-finder.tool.ts::verifyEmailManual` |
| Why are contacts not linked to companies? | `extension.routes.ts::POST /contacts/manual` (dedup-branch backfill) |
| Where do email patterns get cached? | `email-finder.tool.ts` + `domain_patterns` table |
| Where does the Snov.io widget mount? | `extension/content/linkedin/profile-sidebar.js` |
| How do I run the queue workers locally? | `npm run dev:workers` (separate terminal from `npm run dev`) |
| How do I add a new email pattern? | Append a template to `PATTERN_TEMPLATES` in `email-finder.tool.ts` (never reorder existing ones) |
| How do I add a new BD strategy? | Update strategist prompt's STRATEGY-TO-PIPELINE MAPPING + add a new tool/action handler in `master-agent.ts` dispatcher loop |
| Where is the LLM model configured? | `tools/together-ai.tool.ts` constants `SMART_MODEL`, `FAST_MODEL`, default model |
| How does the dashboard know an extension task completed? | WS event `task_result` flows through `websocket/extension.ts` → `extension-dispatcher.ts::onExtensionTaskComplete` → emits dashboard event via Redis pubsub |

---

## 21. Glossary

- **Master agent** — top-level user-configured agent with a mission, strategy, and pipeline. One row in `master_agents`.
- **Sub-agent** — internal worker that does one stage (discovery, document, enrichment, …). Triggered by BullMQ jobs.
- **bdStrategy** — Business Development strategy: `hiring_signal` (find companies hiring X), `industry_target` (find companies in industry Y), `hybrid` (both).
- **userExplicitBdStrategy** — the user's locked choice, set in chat. Overrides any LLM inference.
- **pipelineSteps** — data-driven discovery + enrichment plan. Dispatched by tool/action.
- **Pipeline context** — `master_agents.config.pipelineContext`, holds locations/industries/services/etc derived from the mission.
- **Tenant** — workspace. Multi-tenant isolation enforced by Postgres RLS.
- **Master agent run** — one execution of the master-agent's pipeline, triggered by user "Run" or scheduled job.
- **Extension session** — Chrome extension's authenticated link to a tenant. One row in `extension_sessions` keyed by hashed API key.
- **Reacher** — third-party SMTP email-verifier service. 300/day server-wide cap.
- **Crawl4AI** — server-side scraper with anti-detection. Public pages only (LinkedIn Jobs, company websites).
- **PendingSearchChoice** — UI prompt fired when a discovery batch returned thin/empty results, asking the user to broaden or continue.
