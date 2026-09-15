# ICP score as the single gate — verified-lead pipeline + LinkedIn/email automation

_Roadmap. **Phase 1 is DONE & live** (2026-08-09). Phase 2 is the pending spec —
begin only when the user says so._

## Context / business model

We sell **verified leads**. A lead is only worth spending money on (Reacher email
verification, email sends, LinkedIn touches) once it's proven to fit the ICP. So
the **contact ICP score is the single gate** in front of every expensive/outbound
action. Fix the score first (done), then automate everything behind it (Phase 2).

---

## ✅ Phase 1 — Contact ICP scoring + universal score gate (DONE, deployed)

**A. ICP contact scoring** — `agents/scoring.agent.ts` + `prompts/scoring.prompt.ts`
(sales branch). Contacts are scored against the strategy's structured ICP:
- `authority` = title/seniority match to `SalesStrategy.decisionMakerTargeting`
  (`titlePatterns`, `seniorityLevels`).
- `relevance` = function/department match to `idealCustomerShape.buyerFunctions`
  + `decisionMakerTargeting.departmentFocus`.
- `companyFit` = anchored to the parent company's
  `companies.rawData.fitScore.buyer_fit_score` (inherited down).
- Off-ICP people score low even at a good company. Sales scorer now uses
  `SMART_MODEL` (deepseek) for parity with buyer-fit. Writes `contacts.score` /
  `contacts.scoreDetails` as before; the `passed = score >= scoringThreshold`
  gate (`scoring.agent.ts:66,159`) is unchanged.

**B. Reacher behind the score** — email verification was moved out of enrichment
(where it ran for every contact) to the outreach stage (only reached when
`score >= threshold`).
- `agents/enrichment.agent.ts`: `DEFER_EMAIL_TO_OUTREACH = true` gates the
  per-contact email block (~`:782`) and the team probe (~`:1462`).
- `agents/outreach.agent.ts`: at the top of `execute`, if a passed contact has
  no email, run `findEmailByPattern` (Reacher), persist, then proceed (skip only
  if still none). → **A verified lead = passed contact + Reacher-verified email.**

**C. Email auto-send** — already gated: only passed contacts reach outreach;
`reviewMode !== 'manual'` auto-sends via SMTP; follow-ups auto-send on cadence.
Configured via `config.reviewMode` (surface in the dashboard in Phase 2).

**D. Threshold** — the single knob is `config.scoringThreshold` (default 50 sales).
It gates scoring → outreach → Reacher → email. Per-channel overrides
(`connectThreshold`) come with Phase 2.

**Status:** built clean, `agentcore-api`/`workers` restarted; user confirmed
"the score works." No DB migration was needed for Phase 1.

---

## ⏳ Phase 2 — Score-gated LinkedIn automation (PENDING — full spec)

Decisions already made by the user: **fully auto-send** and **all four
capabilities** (connect, follow-up, verify-accepted, verify-messages). Only
contacts with `score >= connectThreshold` enter this loop.

### E. Auto-send + note-exhaustion detection (extension)
`extension/content/linkedin/paste-outreach.js`: add `autoSend`. The adapter
already *locates* the Send button (`:108-112` connect, `:84` DM) but only listens;
when `autoSend`, wait a randomized human-like delay (1.5-4s jitter) then
`sendBtn.click()` → `{status:'sent'}` (keep `{status:'staged'}` when false).
**Note-invite exhaustion:** in the connect path detect when LinkedIn hides "Add a
note" or shows the "used all your personalized invites" message → return
`{noteLimitReached:true}`; executor sends note-less connects (or pauses), per config.

### F. Read-only scrapers — acceptance + reply detection (extension)
- `linkedin_check_connection` → `content/linkedin/check-connection.js`: open
  `/in/…`, return `{connectionDegree:'1st'|'2nd'|'3rd'|null, pending:bool}`
  (1st / "Message" = accepted; "Pending" = outstanding).
- `linkedin_check_messages` → `content/linkedin/check-messages.js`: open
  `/messaging/`, scrape recent threads for new inbound (reuse
  `content/linkedin/copilot-inline.js` DOM logic) → `{threads:[…]}`.
- Register: DB enum migration `0042` (`extension_task_type` += both);
  `extension-dispatcher.ts` `ExtensionTaskType` + `EXTENSION_SITE_LIMITS`
  (~60/day each); `service-worker.js` `ADAPTER_FILES` + `buildUrl`;
  `lib/rate-limiter.js`. LinkedIn host already permitted — no manifest change.

### G. Daily executor (agentcore)
New global `linkedin-automation` queue + worker + repeatable, mirroring
`workers/followup-scheduler.worker.ts` (`repeat:{every:~20min}`), registered in
`queues/workers.ts:340-345` + `queues/queues.ts` (`AgentType`). Per tick, per
agent with `config.linkedinAutomation.enabled`, within working hours + Redis
daily sub-caps (like `runtime-budget.service.ts`) + the per-user extension cap:
- **Connect:** contacts with `linkedinUrl`, `score >= connectThreshold`, no prior
  `linkedin_connection_sent` → draft note → enqueue `linkedin_connect` `autoSend`
  (1-2/tick) → `recordTouch('linkedin_connect')` + `linkedin_connection_sent`.
- **Acceptance:** outstanding connects (>~1d, unchecked today) → enqueue
  `linkedin_check_connection`; 1st-degree → `linkedin_connection_accepted`
  activity → triage **Rule F** (`triage.service.ts:334-367`) fires.
- **First DM + follow-ups:** due follow-up-engine matches (`scanDueSequences`) →
  draft → enqueue `linkedin_message` `autoSend` → `recordTouch('linkedin_dm')` +
  `onSequenceTouchCompleted` + `linkedin_message_sent`/`linkedin_followup_sent`.
- **Reply check:** once/day `linkedin_check_messages` → new inbound →
  `linkedin_message_received` + `recordResponse` → `engaged` + `onReplyDetected`
  halts the sequence (all existing).

### H. Content drafting
Reuse `services/followup-content.service.ts` for follow-ups; add
`services/linkedin-outreach-content.service.ts` for connect notes + first DMs
(Kimi `BEDROCK_EMAIL_MODEL`, contact+company+ICP context; note <300 chars).

### Config (Phase 2)
Extend `config.linkedinAutomation`: `{ enabled, autoSend, connectThreshold (≥
scoringThreshold), dailyConnectCap (default 15), dailyMessageCap (default 20),
sendConnectNote (default false), workingHours:{startHour,endHour,tz} }`. Surface
in a dashboard agent-settings panel (threshold + caps + auto-send/kill switches).

### Safety rails (mandatory — auto-send is the deliberately-avoided path)
Conservative sub-caps well under the 50/user/day hard cap
(`extension-dispatcher.ts:63-64`); randomized jitter + working-hours spread;
`enabled=false` kill switch; extension-offline single gate halts all sends;
dedupe via `crm_activities`; score threshold so only ICP-fit contacts are touched.

### Reuse (don't rebuild)
- Follow-up state machine: `followup-engine.service.ts`, `followup-cadence.service.ts`, triage Rules E/F/G; email follow-up auto-send `followup-send.worker.ts`.
- Stage machine: `recordTouch`/`recordResponse`/`onReplyDetected` (`prospect-stage.service.ts`); the human path already does touch+engine-advance (`routes/queue.routes.ts:195-224`).
- Event log: `crm_activities` types (`linkedin_connection_sent|accepted`, `linkedin_message_sent|received`, `linkedin_followup_sent` — all exist).
- Reply storage + classifier: `linkedin_conversations` / `linkedin_messages` + `inbox-copilot.service.ts`.
- Scheduler pattern: `followup-scheduler.worker.ts`.

### Verification (Phase 2)
Enable automation with the extension connected → auto-connects only
score≥threshold contacts (Send actually clicked, notes sent, note-limit detected);
accept → first DM; reply → sequence halts; caps + working-hours honored;
`enabled=false` stops all.

### Risks
- **LinkedIn ban risk** with auto-send — rails above are mandatory; start caps low.
- **Note-invite limit** on free accounts (~5/mo) → note-exhaustion detection → note-less fallback.
- **Reorder correctness (Phase 1, watch):** email is null between enrichment and
  outreach — any new caller reading `contact.email` in that window must tolerate it.
- **Two company scores** (`companies.score` int vs `rawData.fitScore.buyer_fit_score`) — contact scoring reads the JSONB fit score.
