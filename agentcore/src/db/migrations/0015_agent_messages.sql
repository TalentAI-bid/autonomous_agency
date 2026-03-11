CREATE TABLE IF NOT EXISTS "agent_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "master_agent_id" uuid REFERENCES "master_agents"("id") ON DELETE CASCADE,
  "from_agent" varchar(50) NOT NULL,
  "to_agent" varchar(50),
  "message_type" varchar(50) NOT NULL,
  "content" jsonb NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_messages_tenant_master_idx" ON "agent_messages" ("tenant_id", "master_agent_id");
CREATE INDEX IF NOT EXISTS "agent_messages_created_idx" ON "agent_messages" ("master_agent_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "agent_messages_from_agent_idx" ON "agent_messages" ("master_agent_id", "from_agent");
CREATE INDEX IF NOT EXISTS "agent_messages_type_idx" ON "agent_messages" ("master_agent_id", "message_type");
