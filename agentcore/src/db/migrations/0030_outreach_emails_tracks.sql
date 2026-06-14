-- v4 classification tracks on outreach_emails. Six nullable columns + two
-- indexes. All additive; existing rows are unaffected.
--
-- See agentcore/src/prompts/cold-email-drafting.prompt.ts STEP 0 for the
-- semantics of `track` and `classification`. Status values used by the
-- outreach agent are `sent` (existing), `pending_review`
-- (PARTNERSHIP_OUTREACH / COLLABORATION_OUTREACH awaiting human approval),
-- and `skipped` (manual route override / audit trail).

ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS track varchar(32);
ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS classification varchar(32);
ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS partnership_angle varchar(64);
ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS collaboration_angle varchar(64);
ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS proposed_exchange text;
ALTER TABLE outreach_emails ADD COLUMN IF NOT EXISTS skip_reason text;

CREATE INDEX IF NOT EXISTS outreach_emails_tenant_track_idx
  ON outreach_emails (tenant_id, track);

CREATE INDEX IF NOT EXISTS outreach_emails_tenant_status_idx
  ON outreach_emails (tenant_id, status);
