-- Follow-up engine — CRM-pipeline-driven follow-ups in the Daily Queue.
--
-- 1. crm_stages gains a per-stage follow-up eligibility flag. Stage names are
--    user-defined, so eligibility defaults are set by an LLM classification
--    pass (follow_up_classified_by='ai'); a user edit pins the flag
--    (follow_up_classified_by='user') and is never overwritten.
--    DEFAULT false = zero behavior change until classification runs.
--
-- 2. followup_sequences — per-deal sequence state (deals are 1:1 with
--    contacts; the user-defined stage lives on the deal). touch_number counts
--    only engine follow-ups; next_due_at = last_touch_at + cadence interval.
--    The daily triage scan surfaces due rows as Daily Queue cards
--    (review-and-send only — nothing auto-sends).
--
-- Additive + idempotent; safe to re-run. Apply with psql (journal-less,
-- same as 0033-0035).

-- 1. crm_stages columns.
ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS follow_up_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE crm_stages ADD COLUMN IF NOT EXISTS follow_up_classified_by text; -- NULL | 'ai' | 'user'

-- 2. followup_sequences table.
CREATE TABLE IF NOT EXISTS followup_sequences (
  deal_id          uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'active', -- active | halted | completed
  touch_number     integer NOT NULL DEFAULT 0,     -- engine follow-ups already sent
  last_touch_at    timestamptz,
  next_due_at      timestamptz,
  cadence_override text,                           -- NULL | fast | mid | slow
  halt_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_sequences_due_idx
  ON followup_sequences (tenant_id, status, next_due_at);
CREATE INDEX IF NOT EXISTS followup_sequences_contact_idx
  ON followup_sequences (contact_id);
