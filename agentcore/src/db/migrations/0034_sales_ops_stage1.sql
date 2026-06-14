-- Sales Operations Platform — Stage 1.
--
-- Adds the schema needed for unified contact tracking + manual capture:
--   1. New columns on contacts (source_type, source_metadata, custom_tags,
--      do_not_contact*, headline/about/phone/whatsapp/twitter_url,
--      intent_score, created_by_user_id) + race-safe dedup unique indexes
--      on (tenant_id, lower(email)) and (tenant_id, linkedin_url).
--   2. Extends crm_activities (= our timeline log) with eventCategory and
--      actorType, plus six new enum values for capture-flow events.
--   3. Two new tables: prospect_stages (1 row per contact) and
--      prospect_actions (created here, populated by Stage 3 worker later).
--
-- Additive only. Each statement is idempotent (IF NOT EXISTS / DO NOTHING),
-- so re-runs and partial-state recovery are safe. No data loss possible.

-- 1a. contacts — new columns.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_type      TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source_metadata  JSONB;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_reason TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS do_not_contact_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS custom_tags      TEXT[];
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS headline         TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS about            TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone            VARCHAR(64);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp         VARCHAR(64);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS twitter_url      VARCHAR(500);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS intent_score     INT  NOT NULL DEFAULT 0;

-- Defaults + range guard. Set defaults AFTER backfill so legacy rows fill in.
UPDATE contacts SET source_type     = 'ai_discovery' WHERE source_type     IS NULL;
UPDATE contacts SET source_metadata = '{}'::jsonb    WHERE source_metadata IS NULL;
UPDATE contacts SET custom_tags     = ARRAY[]::text[] WHERE custom_tags    IS NULL;

ALTER TABLE contacts ALTER COLUMN source_type     SET DEFAULT 'ai_discovery';
ALTER TABLE contacts ALTER COLUMN source_type     SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN source_metadata SET DEFAULT '{}'::jsonb;
ALTER TABLE contacts ALTER COLUMN source_metadata SET NOT NULL;
ALTER TABLE contacts ALTER COLUMN custom_tags     SET DEFAULT ARRAY[]::text[];
ALTER TABLE contacts ALTER COLUMN custom_tags     SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_intent_score_range'
  ) THEN
    ALTER TABLE contacts ADD CONSTRAINT contacts_intent_score_range
      CHECK (intent_score >= 0 AND intent_score <= 100);
  END IF;
END $$;

-- 1b. Race-safe dedup. Scoped per-tenant so two tenants can hold the same
-- email/linkedin URL without colliding. Partial WHERE clause skips NULLs
-- so legacy contacts without one of the two identifiers still insert.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_email_unique
  ON contacts (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_linkedin_unique
  ON contacts (tenant_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_tenant_tags_gin
  ON contacts USING GIN (custom_tags);

-- 1c. crm_activities (= the timeline log). New enum values for capture flow.
-- ALTER TYPE ADD VALUE cannot run in a transaction in older Postgres; each
-- ; ends an implicit tx so this is safe under the drizzle-kit migrate runner.
ALTER TYPE crm_activity_type ADD VALUE IF NOT EXISTS 'contact_added';
ALTER TYPE crm_activity_type ADD VALUE IF NOT EXISTS 'contact_tagged';
ALTER TYPE crm_activity_type ADD VALUE IF NOT EXISTS 'contact_untagged';
ALTER TYPE crm_activity_type ADD VALUE IF NOT EXISTS 'contact_marked_dnc';
ALTER TYPE crm_activity_type ADD VALUE IF NOT EXISTS 'contact_reassigned';
ALTER TYPE crm_activity_type ADD VALUE IF NOT EXISTS 'duplicate_capture_attempted';

ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS event_category TEXT;
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS actor_type     TEXT;

-- Backfill event_category from existing rows so the column can be NOT NULL.
UPDATE crm_activities SET event_category = CASE
    WHEN type IN ('email_sent','linkedin_message_sent','linkedin_connection_sent',
                  'linkedin_followup_sent','manual_email_sent')                  THEN 'outreach'
    WHEN type IN ('email_opened','email_replied','email_received','email_bounced',
                  'linkedin_message_received','linkedin_connection_accepted',
                  'manual_email_received')                                       THEN 'response'
    WHEN type IN ('stage_change','status_change','score_updated')                THEN 'status_change'
    WHEN type = 'note_added'                                                     THEN 'manual_note'
    WHEN type = 'meeting_scheduled'                                              THEN 'meeting'
    WHEN type = 'call_logged'                                                    THEN 'outreach'
    ELSE 'system_action'
  END
  WHERE event_category IS NULL;

UPDATE crm_activities SET actor_type = CASE
    WHEN user_id IS NOT NULL                                THEN 'user'
    WHEN type IN ('email_opened','email_replied','email_received','email_bounced',
                  'linkedin_message_received',
                  'linkedin_connection_accepted',
                  'manual_email_received')                  THEN 'recipient'
    ELSE 'system'
  END
  WHERE actor_type IS NULL;

ALTER TABLE crm_activities ALTER COLUMN event_category SET NOT NULL;
ALTER TABLE crm_activities ALTER COLUMN actor_type     SET NOT NULL;
ALTER TABLE crm_activities ALTER COLUMN event_category SET DEFAULT 'system_action';
ALTER TABLE crm_activities ALTER COLUMN actor_type     SET DEFAULT 'user';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'crm_activities_actor_type_valid'
  ) THEN
    ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_actor_type_valid
      CHECK (actor_type IN ('system','user','recipient','integration'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS crm_activities_contact_occurred_idx
  ON crm_activities(contact_id, occurred_at DESC);

-- 1d. prospect_stages — single row per contact tracking pipeline position.
CREATE TABLE IF NOT EXISTS prospect_stages (
  contact_id       UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  current_stage    TEXT NOT NULL DEFAULT 'new',
  stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_action_due  TIMESTAMPTZ,
  total_touches    INT NOT NULL DEFAULT 0,
  last_touch_at    TIMESTAMPTZ,
  last_response_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT prospect_stages_current_stage_valid CHECK (current_stage IN (
    'new','first_touch_sent','awaiting_response','engaged','qualified',
    'meeting_scheduled','in_evaluation','closed_won','closed_lost','cold','dnc'
  ))
);
CREATE INDEX IF NOT EXISTS prospect_stages_tenant_stage_idx
  ON prospect_stages(tenant_id, current_stage);
CREATE INDEX IF NOT EXISTS prospect_stages_next_action_idx
  ON prospect_stages(tenant_id, next_action_due) WHERE next_action_due IS NOT NULL;

-- 1e. prospect_actions — the daily action queue. Created here so Stage 3's
-- triage worker has a target. No rows inserted by this migration; UI/worker
-- in later stages populate it.
CREATE TABLE IF NOT EXISTS prospect_actions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tenant_id             UUID NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  action_type           TEXT NOT NULL,
  priority              TEXT NOT NULL,
  priority_reason       TEXT,
  why_now               TEXT,
  strategy_note         TEXT,
  scheduled_for         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
  draft_subject         TEXT,
  draft_body            TEXT,
  draft_confidence      INT,
  channel_target        TEXT,
  context_summary       TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_opened_at        TIMESTAMPTZ,
  user_completed_at     TIMESTAMPTZ,
  user_skipped_at       TIMESTAMPTZ,
  skip_reason           TEXT,
  user_notes            TEXT,
  triggered_by_event_id UUID REFERENCES crm_activities(id) ON DELETE SET NULL,
  CONSTRAINT prospect_actions_action_type_valid CHECK (action_type IN (
    'linkedin_connect','linkedin_dm_first','linkedin_dm_followup','linkedin_dm_reply',
    'email_first','email_followup','email_reply','whatsapp_send','phone_call',
    'meeting_prep','manual_research','manual_followup_task','reactivation_outreach',
    'breakup_message','mark_dead_review'
  )),
  CONSTRAINT prospect_actions_priority_valid CHECK (priority IN ('P0','P1','P2','P3')),
  CONSTRAINT prospect_actions_status_valid CHECK (status IN (
    'pending','in_progress','completed','skipped','expired','superseded'
  ))
);
CREATE INDEX IF NOT EXISTS prospect_actions_queue_idx
  ON prospect_actions(user_id, priority, scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS prospect_actions_tenant_status_idx
  ON prospect_actions(tenant_id, status, scheduled_for);
CREATE INDEX IF NOT EXISTS prospect_actions_contact_idx
  ON prospect_actions(contact_id);

-- 1f. Backfill prospect_stages from existing contacts.status. Mapping
-- preserves the existing pipeline state so the Stage 2 detail page +
-- Stage 3 triage worker see meaningful current_stage values for legacy
-- contacts (rather than a flood of artificial 'new' rows).
INSERT INTO prospect_stages (contact_id, tenant_id, current_stage, stage_entered_at)
  SELECT id, tenant_id,
    CASE
      WHEN status = 'replied'             THEN 'engaged'
      WHEN status = 'contacted'           THEN 'awaiting_response'
      WHEN status = 'qualified'           THEN 'qualified'
      WHEN status = 'interview_scheduled' THEN 'meeting_scheduled'
      WHEN status = 'archived'            THEN 'closed_lost'
      ELSE 'new'
    END,
    created_at
  FROM contacts
  ON CONFLICT (contact_id) DO NOTHING;
