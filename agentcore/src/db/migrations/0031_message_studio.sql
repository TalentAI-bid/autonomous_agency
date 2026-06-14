-- Message Studio: standalone manual-composition tool. See
-- agentcore/src/services/message-studio.service.ts.
--
-- 1) Per-tenant messaging configuration (sender identity + value-prop
--    snippets used by every generated message).
-- 2) A history table of generated messages — useful for debugging,
--    rate-limit audit, and future analytics. NOT integrated with the
--    outreach pipeline; pure copy-paste artifact storage.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS messaging_config jsonb DEFAULT '{}'::jsonb NOT NULL;

CREATE TABLE IF NOT EXISTS message_compositions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  channel varchar(64) NOT NULL,
  track varchar(32) NOT NULL,
  recipient_name text NOT NULL,
  recipient_company text,
  recipient_title text,
  recipient_location text,
  recipient_linkedin_url text,
  custom_context text,
  subject text,
  body text NOT NULL,
  classification varchar(32),
  character_count integer,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS message_compositions_tenant_idx
  ON message_compositions (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS message_compositions_tenant_user_idx
  ON message_compositions (tenant_id, user_id, created_at DESC);
