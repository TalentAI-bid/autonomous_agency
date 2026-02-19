# AgentCore — Database Reference

Complete reference for the PostgreSQL 16 database schema, connection setup, and Row-Level Security.

---

## Architecture

```
Application Code
       │
       ├─→ DATABASE_URL  (:5432)  ─→ PostgreSQL 16 (direct)
       │     Used by: Drizzle migrations, db:seed, drizzle-kit
       │
       └─→ PGBOUNCER_URL (:6432)  ─→ PgBouncer (pooled)
             Used by: API runtime, BullMQ workers
                  │
                  └─→ PostgreSQL 16 (transaction pool, 20 connections)
```

**Rule:** Always use `PGBOUNCER_URL` in production runtime code. Use `DATABASE_URL` (direct) only for migrations, seeding, and DDL.

```env
DATABASE_URL=postgresql://agentcore:password@localhost:5432/agentcore
PGBOUNCER_URL=postgresql://agentcore:password@localhost:6432/agentcore
```

---

## Row-Level Security (RLS)

All tables enforce tenant isolation via PostgreSQL RLS policies.

### How it works

```typescript
// Every query in the application goes through withTenant():
await withTenant(tenantId, async (tx) => {
  // Sets: SET LOCAL app.current_tenant_id = 'tenant-uuid'
  // RLS policies then auto-filter all queries to this tenant
  return tx.select().from(contacts);
});
```

The PostgreSQL function `current_tenant_id()` reads this session variable:
```sql
CREATE FUNCTION current_tenant_id() RETURNS UUID AS $$
  SELECT current_setting('app.current_tenant_id', true)::UUID
$$ LANGUAGE sql STABLE;
```

Each table has a policy:
```sql
-- Example: contacts table
CREATE POLICY contacts_tenant_isolation ON contacts
  USING (tenant_id = current_tenant_id());
```

### Setup
```bash
# Run once after migrations
psql $DATABASE_URL -f scripts/setup-rls.sql

# Verify policies are active
psql $DATABASE_URL -c "
  SELECT tablename, policyname, cmd
  FROM pg_policies
  WHERE schemaname = 'public'
  ORDER BY tablename;
"
```

### Tables with RLS
All 15 tables have RLS enabled. Indirect tables (campaign_steps, campaign_contacts, emails_sent, replies) use JOINs to verify tenant access through their parent records.

---

## PostgreSQL Enums

```sql
-- Tenant & user
plan:              'free' | 'starter' | 'pro' | 'enterprise'
product_type:      'recruitment' | 'sales' | 'both'
user_role:         'owner' | 'admin' | 'member' | 'viewer'

-- Agent system
use_case:          'recruitment' | 'sales' | 'custom'
master_agent_status: 'idle' | 'running' | 'paused' | 'error'
agent_type:        'discovery' | 'enrichment' | 'document' | 'scoring' | 'outreach' | 'reply' | 'action'
task_status:       'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
memory_type:       'short_term' | 'medium_term' | 'long_term'

-- Contacts & documents
contact_source:    'linkedin_search' | 'linkedin_profile' | 'cv_upload' | 'manual' | 'web_search'
contact_status:    'discovered' | 'enriched' | 'scored' | 'contacted' | 'replied' | 'qualified' | 'interview_scheduled' | 'rejected' | 'archived'
doc_type:          'job_spec' | 'cv' | 'whitepaper' | 'spec' | 'linkedin_profile' | 'other'
doc_status:        'uploaded' | 'processing' | 'processed' | 'error'

-- Campaigns & comms
campaign_type:     'email' | 'linkedin' | 'multi_channel'
campaign_status:   'draft' | 'active' | 'paused' | 'completed'
campaign_contact_status: 'pending' | 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'completed'
step_channel:      'email' | 'linkedin'
reply_classification: 'interested' | 'objection' | 'not_now' | 'out_of_office' | 'unsubscribe' | 'bounce' | 'other'
interview_status:  'scheduled' | 'completed' | 'cancelled' | 'no_show'
```

---

## Tables

### `tenants` — Organization accounts (multi-tenancy root)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK, default gen_random_uuid() |
| name | VARCHAR(255) | NOT NULL |
| slug | VARCHAR(100) | UNIQUE NOT NULL |
| plan | ENUM(plan) | DEFAULT 'free' NOT NULL |
| product_type | ENUM(product_type) | DEFAULT 'recruitment' NOT NULL |
| settings | JSONB | DEFAULT '{}' |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### `users` — Tenant members

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| email | VARCHAR(255) | UNIQUE NOT NULL |
| password_hash | VARCHAR(255) | NOT NULL |
| name | VARCHAR(255) | |
| role | ENUM(user_role) | DEFAULT 'member' NOT NULL |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id)`, `UNIQUE(email)`

---

### `master_agents` — Top-level AI agent configurations

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| name | VARCHAR(255) | NOT NULL |
| description | TEXT | |
| mission | TEXT | |
| use_case | ENUM(use_case) | NOT NULL |
| status | ENUM(master_agent_status) | DEFAULT 'idle' NOT NULL |
| config | JSONB | Parsed requirements + scoring weights |
| created_by | UUID | FK → users(id) |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:**
- `(tenant_id)`
- `(tenant_id, status)`
- `(id) WHERE status = 'running'` (partial — active agents)

**`config` JSONB shape:**
```json
{
  "requiredSkills": ["TypeScript", "React"],
  "targetRoles": ["Senior Engineer"],
  "scoringWeights": { "skills": 40, "experience": 30, "location": 20, "education": 10 },
  "scoringThreshold": 70,
  "emailTone": "professional",
  "valueProposition": "Join a funded fintech startup...",
  "searchCriteria": { "locations": ["London", "Remote"] }
}
```

---

### `agent_configs` — Per-agent-type configuration

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE CASCADE |
| agent_type | ENUM(agent_type) | NOT NULL |
| system_prompt | TEXT | |
| tools | JSONB | string[] |
| parameters | JSONB | |
| output_schema | JSONB | |
| is_enabled | BOOLEAN | DEFAULT true NOT NULL |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `UNIQUE(master_agent_id, agent_type)`, `(tenant_id, master_agent_id)`

---

### `agent_tasks` — Async job tracking

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE SET NULL |
| agent_type | ENUM(agent_type) | NOT NULL |
| status | ENUM(task_status) | DEFAULT 'pending' NOT NULL |
| priority | INTEGER | DEFAULT 0 NOT NULL |
| input | JSONB | NOT NULL |
| output | JSONB | |
| error | TEXT | |
| retry_count | INTEGER | DEFAULT 0 NOT NULL |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id, status)`, `(tenant_id, created_at)`, `(tenant_id, master_agent_id)`

---

### `agent_memory` — Redis-backed agent memory (DB overflow)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE CASCADE |
| agent_type | ENUM(agent_type) | NOT NULL |
| memory_type | ENUM(memory_type) | NOT NULL |
| key | VARCHAR(255) | NOT NULL |
| value | JSONB | NOT NULL |
| expires_at | TIMESTAMPTZ | (optional TTL) |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id, master_agent_id, agent_type)`, `(tenant_id, key)`

---

### `companies` — Company/organization data

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| name | VARCHAR(255) | NOT NULL |
| domain | VARCHAR(255) | |
| industry | VARCHAR(255) | |
| size | VARCHAR(100) | e.g. "50-200" |
| tech_stack | JSONB | string[] |
| funding | VARCHAR(255) | |
| linkedin_url | VARCHAR(500) | |
| description | TEXT | |
| raw_data | JSONB | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id)`, GIN index on `tech_stack` (jsonb_path_ops)

---

### `contacts` — Individual candidates/leads

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE SET NULL |
| first_name | VARCHAR(255) | |
| last_name | VARCHAR(255) | |
| email | VARCHAR(255) | UNIQUE |
| email_verified | BOOLEAN | DEFAULT false |
| linkedin_url | VARCHAR(500) | |
| title | VARCHAR(255) | |
| company_id | UUID | FK → companies(id) ON DELETE SET NULL |
| company_name | VARCHAR(255) | |
| location | VARCHAR(255) | |
| skills | JSONB | string[] |
| experience | JSONB | object[] |
| education | JSONB | object[] |
| score | INTEGER | 0-100 |
| score_details | JSONB | `{ breakdown, reasoning }` |
| source | ENUM(contact_source) | |
| status | ENUM(contact_status) | DEFAULT 'discovered' NOT NULL |
| raw_data | JSONB | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:**
- `(tenant_id, status)`
- `(tenant_id, created_at)`
- `(tenant_id, master_agent_id)`
- GIN trigram index on `email` (for LIKE search)
- GIN index on `skills` (jsonb_path_ops)

---

### `documents` — Uploaded files (CVs, job specs)

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE SET NULL |
| contact_id | UUID | FK → contacts(id) ON DELETE SET NULL |
| type | ENUM(doc_type) | NOT NULL |
| file_name | VARCHAR(255) | |
| file_path | VARCHAR(500) | |
| mime_type | VARCHAR(100) | |
| extracted_data | JSONB | Structured data from LLM parsing |
| raw_text | TEXT | |
| status | ENUM(doc_status) | DEFAULT 'uploaded' NOT NULL |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id, master_agent_id)`, `(tenant_id, created_at)`

---

### `campaigns` — Outreach campaigns

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE SET NULL |
| name | VARCHAR(255) | NOT NULL |
| type | ENUM(campaign_type) | DEFAULT 'email' NOT NULL |
| status | ENUM(campaign_status) | DEFAULT 'draft' NOT NULL |
| config | JSONB | |
| stats | JSONB | `{sent, opened, replied, meetingsBooked}` |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id, status)`, partial: `(id) WHERE status = 'active'`

---

### `campaign_steps` — Email sequence steps

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| campaign_id | UUID | FK → campaigns(id) ON DELETE CASCADE |
| step_number | INTEGER | NOT NULL |
| subject | TEXT | |
| template | TEXT | |
| delay_days | INTEGER | DEFAULT 0 NOT NULL |
| channel | ENUM(step_channel) | DEFAULT 'email' NOT NULL |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(campaign_id)`

> Note: No `from_email` column. The sender address comes from `SMTP_USER` env var.

---

### `campaign_contacts` — Contact enrollment in campaigns

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| campaign_id | UUID | FK → campaigns(id) ON DELETE CASCADE |
| contact_id | UUID | FK → contacts(id) ON DELETE CASCADE |
| current_step | INTEGER | DEFAULT 0 NOT NULL |
| status | ENUM(campaign_contact_status) | DEFAULT 'pending' NOT NULL |
| last_action_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**Indexes:** `UNIQUE(campaign_id, contact_id)`, `(status)`

---

### `emails_sent` — Email delivery records

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| campaign_contact_id | UUID | FK → campaign_contacts(id) ON DELETE CASCADE |
| step_id | UUID | FK → campaign_steps(id) ON DELETE SET NULL |
| from_email | VARCHAR(255) | |
| to_email | VARCHAR(255) | |
| subject | TEXT | |
| body | TEXT | |
| sent_at | TIMESTAMPTZ | |
| opened_at | TIMESTAMPTZ | Null until pixel fires |
| clicked_at | TIMESTAMPTZ | |
| replied_at | TIMESTAMPTZ | |
| bounced_at | TIMESTAMPTZ | |
| message_id | VARCHAR(255) | SMTP message ID |

**Indexes:** `(campaign_contact_id)`, `(sent_at)`

---

### `replies` — Inbound email analysis

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| email_sent_id | UUID | FK → emails_sent(id) ON DELETE CASCADE |
| contact_id | UUID | FK → contacts(id) ON DELETE SET NULL |
| body | TEXT | |
| classification | ENUM(reply_classification) | |
| sentiment | REAL | -1.0 to 1.0 |
| auto_response | TEXT | Claude-generated response |
| processed_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(email_sent_id)`, `(contact_id)`

---

### `interviews` — Interview scheduling

| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| tenant_id | UUID | FK → tenants(id) ON DELETE CASCADE |
| contact_id | UUID | FK → contacts(id) ON DELETE CASCADE |
| master_agent_id | UUID | FK → master_agents(id) ON DELETE SET NULL |
| scheduled_at | TIMESTAMPTZ | |
| status | ENUM(interview_status) | DEFAULT 'scheduled' NOT NULL |
| meeting_url | VARCHAR(500) | |
| notes | TEXT | |
| created_at | TIMESTAMPTZ | |

**Indexes:** `(tenant_id)`, `(contact_id)`

---

## Entity Relationships

```
tenants (1)
  ├── users (N)
  ├── master_agents (N)
  │     ├── agent_configs (N)    — one per agent_type
  │     ├── agent_tasks (N)      — async job records
  │     ├── agent_memory (N)     — key-value store
  │     ├── contacts (N)
  │     ├── documents (N)
  │     ├── campaigns (N)
  │     └── interviews (N)
  ├── companies (N)
  └── contacts (N)
        ├── documents (N)        — CVs, LinkedIn profiles
        ├── campaign_contacts (N)
        │     ├── emails_sent (N)
        │     │     └── replies (N)
        │     └── campaign_steps (via campaign_id)
        └── interviews (N)
```

---

## Common Queries

> All queries require setting the tenant context first:
> ```sql
> SET app.current_tenant_id = 'your-tenant-uuid';
> ```

### View full pipeline status
```sql
SELECT
  status,
  COUNT(*) as count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as pct
FROM contacts
GROUP BY status
ORDER BY
  CASE status
    WHEN 'discovered' THEN 1
    WHEN 'enriched' THEN 2
    WHEN 'scored' THEN 3
    WHEN 'contacted' THEN 4
    WHEN 'replied' THEN 5
    WHEN 'interview_scheduled' THEN 6
    ELSE 7
  END;
```

### Top-scored contacts
```sql
SELECT
  first_name || ' ' || last_name AS name,
  title,
  company_name,
  score,
  status,
  email
FROM contacts
WHERE score IS NOT NULL
ORDER BY score DESC
LIMIT 20;
```

### Agent task performance
```sql
SELECT
  agent_type,
  status,
  COUNT(*) as count,
  AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) as avg_seconds
FROM agent_tasks
GROUP BY agent_type, status
ORDER BY agent_type, status;
```

### Email campaign metrics
```sql
SELECT
  c.name as campaign,
  COUNT(es.id) as sent,
  COUNT(es.opened_at) as opened,
  COUNT(es.replied_at) as replied,
  ROUND(100.0 * COUNT(es.opened_at) / NULLIF(COUNT(es.id), 0), 1) as open_rate_pct
FROM campaigns c
JOIN campaign_contacts cc ON cc.campaign_id = c.id
JOIN emails_sent es ON es.campaign_contact_id = cc.id
GROUP BY c.id, c.name;
```

### Tenant stats summary
```sql
SELECT
  (SELECT COUNT(*) FROM contacts) as total_contacts,
  (SELECT COUNT(*) FROM contacts WHERE status = 'contacted') as contacted,
  (SELECT COUNT(*) FROM emails_sent) as emails_sent,
  (SELECT COUNT(*) FROM interviews WHERE status = 'scheduled') as interviews_scheduled,
  (SELECT COUNT(*) FROM master_agents WHERE status = 'running') as active_agents;
```

---

## Migration & Schema Commands

```bash
# Generate new migration after schema changes
npm run db:generate

# Apply pending migrations (uses DATABASE_URL — direct :5432)
npm run db:migrate

# Apply Row-Level Security policies
psql $DATABASE_URL -f scripts/setup-rls.sql

# Seed initial data (creates tenant + admin user)
npm run db:seed

# Open Drizzle Studio (visual DB browser)
npm run db:studio
```

### Migration files location
```
agentcore/src/db/migrations/
  └── 0000_parched_deadpool.sql   # Initial full schema
```

### Schema source files
```
agentcore/src/db/schema/
  ├── tenants.ts
  ├── users.ts
  ├── master-agents.ts
  ├── agent-configs.ts
  ├── agent-tasks.ts
  ├── agent-memory.ts
  ├── companies.ts
  ├── contacts.ts
  ├── documents.ts
  ├── campaigns.ts
  ├── campaign-steps.ts
  ├── campaign-contacts.ts
  ├── emails-sent.ts
  ├── replies.ts
  ├── interviews.ts
  └── index.ts                   # Barrel export
```

---

## PgBouncer Configuration

PgBouncer runs in **transaction pool** mode, which means:
- Each transaction gets a connection from the pool
- The connection is returned after `COMMIT`/`ROLLBACK`
- `SET LOCAL` (used by RLS) is scoped to the transaction — works correctly

Pool settings (from docker-compose):
```
PGBOUNCER_POOL_MODE=transaction
PGBOUNCER_MAX_CLIENT_CONN=1000
PGBOUNCER_DEFAULT_POOL_SIZE=20
PGBOUNCER_MIN_POOL_SIZE=5
```

> Do NOT use session-level `SET` with PgBouncer transaction mode — only `SET LOCAL` (inside a transaction) is safe.

---

## Database Maintenance

```bash
# Check table sizes
psql $DATABASE_URL -c "
  SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size(tablename::regclass)) as size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(tablename::regclass) DESC;
"

# VACUUM ANALYZE (reclaim space + update statistics)
psql $DATABASE_URL -c "VACUUM ANALYZE;"

# Check index usage
psql $DATABASE_URL -c "
  SELECT
    indexrelname,
    idx_scan,
    idx_tup_fetch
  FROM pg_stat_user_indexes
  ORDER BY idx_scan DESC;
"

# Check active connections
psql $DATABASE_URL -c "
  SELECT count(*), state FROM pg_stat_activity
  WHERE datname = 'agentcore'
  GROUP BY state;
"
```
