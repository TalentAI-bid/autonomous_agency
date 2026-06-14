-- Sales Operations — company-centric triage refactor.
--
-- The triage engine pivots its unit of analysis from contacts to companies.
-- Each rule queries companies; the recommended target contact is picked
-- inside the query (role-priority sort) and joined back in. One pending
-- prospect_action per (tenant, company) is enforced by a partial unique
-- index — no more 3 actions firing for the same company because it has
-- 3 contacts in CRM.
--
-- Schema additions:
--   1. companies — stage tracking columns + do_not_contact + indexes.
--   2. prospect_actions — company_id (NOT NULL after backfill) +
--      target_alternatives jsonb; contact_id becomes nullable so Rule M
--      ("research decision-makers") can produce contact-less actions.
--
-- Backfill:
--   - prospect_actions.company_id from contacts.company_id (existing 15
--     P1 actions from today's earlier triage run all have a contact, so
--     they get a company_id; any orphans get dropped — they were never
--     valid).
--   - companies stage + counters from crm_activities history (companies
--     with inbound responses → engaged; with outbound touches and no
--     inbound → awaiting_response; else new).
--
-- prospect_stages stays as-is (read by contact.routes.ts filters + the
-- reply agent). Triage stops reading it. Decommission is a follow-up.
--
-- Additive + idempotent; safe to re-run.

-- 1a. companies — new columns.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS do_not_contact          BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS current_stage           TEXT        NOT NULL DEFAULT 'new';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS stage_entered_at        TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_touch_at           TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_inbound_at         TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_outbound_touches  INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS total_inbound_responses INTEGER     NOT NULL DEFAULT 0;

-- Stage value guard (matches prospect_stages enum but stored as text).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_current_stage_check'
  ) THEN
    ALTER TABLE companies ADD CONSTRAINT companies_current_stage_check
      CHECK (current_stage IN (
        'new','first_touch_sent','awaiting_response','engaged','qualified',
        'meeting_scheduled','in_evaluation','closed_won','closed_lost','cold','dnc'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS companies_tenant_stage_idx ON companies(tenant_id, current_stage);
CREATE INDEX IF NOT EXISTS companies_tenant_score_idx ON companies(tenant_id, score DESC NULLS LAST);

-- 2a. prospect_actions — new columns.
ALTER TABLE prospect_actions ADD COLUMN IF NOT EXISTS company_id          UUID;
ALTER TABLE prospect_actions ADD COLUMN IF NOT EXISTS target_alternatives JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Allow contact_id to be NULL (Rule M: research-decision-makers actions
-- have no target contact yet).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'prospect_actions'
      AND column_name = 'contact_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE prospect_actions ALTER COLUMN contact_id DROP NOT NULL;
  END IF;
END $$;

-- 2b. Backfill company_id from each row's contact's company.
UPDATE prospect_actions pa
SET    company_id = c.company_id
FROM   contacts c
WHERE  c.id = pa.contact_id
  AND  pa.company_id IS NULL;

-- Drop any orphan rows that have neither a usable company nor contact —
-- they couldn't be acted on anyway.
DELETE FROM prospect_actions WHERE company_id IS NULL AND contact_id IS NULL;

-- For rows with a contact but no resolvable company (contact.company_id
-- was NULL), drop them too — under the new grain we can't queue them
-- without a company. There are at most 0–handful of these in practice.
DELETE FROM prospect_actions WHERE company_id IS NULL;

ALTER TABLE prospect_actions ALTER COLUMN company_id SET NOT NULL;

-- FK after backfill so the constraint applies to the cleaned state.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_actions_company_id_fkey'
  ) THEN
    ALTER TABLE prospect_actions
      ADD CONSTRAINT prospect_actions_company_id_fkey
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS prospect_actions_company_idx        ON prospect_actions(company_id);
CREATE INDEX IF NOT EXISTS prospect_actions_tenant_company_idx ON prospect_actions(tenant_id, company_id);

-- Before enforcing the partial unique index, dedupe pre-existing pending
-- rows that now collide on (tenant_id, company_id) — they were generated
-- under the old contact-grain triage where 3 contacts at the same company
-- could each produce a pending action. Keep the highest-priority + most
-- recent per (tenant, company); supersede the others.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, company_id
           ORDER BY priority ASC, generated_at DESC
         ) AS rn
  FROM   prospect_actions
  WHERE  status = 'pending'
)
UPDATE prospect_actions
SET    status = 'superseded'
WHERE  id IN (SELECT id FROM ranked WHERE rn > 1);

-- One pending action per (tenant, company). Enforced at the DB level —
-- triage uses ON CONFLICT DO NOTHING when re-running.
CREATE UNIQUE INDEX IF NOT EXISTS prospect_actions_one_pending_per_company
  ON prospect_actions(tenant_id, company_id)
  WHERE status = 'pending';

-- 2c. Extend action_type CHECK to include Rule M's research action.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prospect_actions_action_type_valid'
  ) THEN
    ALTER TABLE prospect_actions DROP CONSTRAINT prospect_actions_action_type_valid;
  END IF;
END $$;
ALTER TABLE prospect_actions ADD CONSTRAINT prospect_actions_action_type_valid
  CHECK (action_type IN (
    'linkedin_connect','linkedin_dm_first','linkedin_dm_followup','linkedin_dm_reply',
    'email_first','email_followup','email_reply',
    'whatsapp_send','phone_call',
    'meeting_prep','manual_research','manual_followup_task',
    'reactivation_outreach','breakup_message','mark_dead_review',
    'research_company_decision_makers'
  ));

-- 3. Backfill company stage + counters from crm_activities history.
WITH agg AS (
  SELECT
    co.id                                                              AS company_id,
    MAX(ca.occurred_at) FILTER (WHERE ca.event_category = 'outreach')  AS last_out,
    MAX(ca.occurred_at) FILTER (WHERE ca.event_category = 'response')  AS last_in,
    COUNT(*)            FILTER (WHERE ca.event_category = 'outreach')  AS n_out,
    COUNT(*)            FILTER (WHERE ca.event_category = 'response')  AS n_in
  FROM   companies co
  LEFT JOIN contacts       c  ON c.company_id = co.id
  LEFT JOIN crm_activities ca ON ca.contact_id = c.id
  GROUP BY co.id
)
UPDATE companies co
SET
  current_stage = CASE
    WHEN agg.n_in  > 0 THEN 'engaged'
    WHEN agg.n_out > 0 THEN 'awaiting_response'
    ELSE                    'new'
  END,
  last_touch_at           = agg.last_out,
  last_inbound_at         = agg.last_in,
  total_outbound_touches  = COALESCE(agg.n_out, 0)::int,
  total_inbound_responses = COALESCE(agg.n_in,  0)::int,
  stage_entered_at        = COALESCE(agg.last_in, agg.last_out, co.created_at)
FROM   agg
WHERE  agg.company_id = co.id;
