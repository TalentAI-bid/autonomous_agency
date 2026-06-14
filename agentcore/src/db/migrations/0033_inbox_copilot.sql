-- LinkedIn Inbox Copilot: persists ongoing LinkedIn DM threads and the
-- copilot's generated reply drafts. See
-- agentcore/src/services/inbox-copilot.service.ts.

CREATE TABLE IF NOT EXISTS linkedin_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  recipient_linkedin_url text NOT NULL,
  recipient_name text,
  recipient_company text,
  recipient_title text,
  contact_id uuid,
  first_message_at timestamptz,
  last_message_at timestamptz,
  total_messages integer DEFAULT 0,
  outbound_count integer DEFAULT 0,
  inbound_count integer DEFAULT 0,
  current_stage varchar(32),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(tenant_id, recipient_linkedin_url)
);

CREATE INDEX IF NOT EXISTS idx_linkedin_conv_user
  ON linkedin_conversations(tenant_id, user_id);

CREATE TABLE IF NOT EXISTS linkedin_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES linkedin_conversations(id) ON DELETE CASCADE,
  direction varchar(16) NOT NULL,
  body text NOT NULL,
  sent_at timestamptz NOT NULL,
  classified_intent varchar(32),
  classified_priority varchar(16),
  classification_confidence integer,
  is_copilot_draft boolean DEFAULT false,
  draft_for_message_id uuid,
  draft_strategy text,
  draft_used boolean,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_linkedin_msg_conv
  ON linkedin_messages(conversation_id, sent_at);
