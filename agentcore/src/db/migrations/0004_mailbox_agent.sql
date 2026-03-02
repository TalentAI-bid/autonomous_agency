-- Step 0: Add mailbox to agent_type enum
ALTER TYPE "agent_type" ADD VALUE IF NOT EXISTS 'mailbox' AFTER 'email-send';

-- Step 1: Add email_received to crm_activity_type enum
ALTER TYPE "crm_activity_type" ADD VALUE IF NOT EXISTS 'email_received' AFTER 'email_replied';

-- Step 2: Create email_thread_status enum
DO $$ BEGIN
  CREATE TYPE "email_thread_status" AS ENUM ('active', 'archived', 'needs_action', 'waiting');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Step 3: Create email_thread_priority enum
DO $$ BEGIN
  CREATE TYPE "email_thread_priority" AS ENUM ('high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Step 4: Create email_threads table
CREATE TABLE IF NOT EXISTS "email_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "contact_id" uuid,
  "master_agent_id" uuid,
  "deal_id" uuid,
  "subject" text,
  "last_message_at" timestamp with time zone,
  "message_count" integer DEFAULT 0 NOT NULL,
  "summary" text,
  "status" "email_thread_status" DEFAULT 'active' NOT NULL,
  "priority" "email_thread_priority" DEFAULT 'medium' NOT NULL,
  "next_action" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Step 5: Add foreign keys for email_threads
DO $$ BEGIN
  ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "master_agents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Step 6: Create indexes for email_threads
CREATE INDEX IF NOT EXISTS "email_threads_tenant_idx" ON "email_threads" ("tenant_id");
CREATE INDEX IF NOT EXISTS "email_threads_tenant_status_idx" ON "email_threads" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "email_threads_tenant_last_msg_idx" ON "email_threads" ("tenant_id", "last_message_at");
CREATE INDEX IF NOT EXISTS "email_threads_contact_idx" ON "email_threads" ("contact_id");
CREATE INDEX IF NOT EXISTS "email_threads_deal_idx" ON "email_threads" ("deal_id");

-- Step 7: Add tenant_id column to replies
ALTER TABLE "replies" ADD COLUMN IF NOT EXISTS "tenant_id" uuid;

DO $$ BEGIN
  ALTER TABLE "replies" ADD CONSTRAINT "replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Step 8: Add thread_id column to replies
ALTER TABLE "replies" ADD COLUMN IF NOT EXISTS "thread_id" uuid;

DO $$ BEGIN
  ALTER TABLE "replies" ADD CONSTRAINT "replies_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "replies_tenant_created_idx" ON "replies" ("tenant_id", "created_at");
CREATE INDEX IF NOT EXISTS "replies_thread_idx" ON "replies" ("thread_id");

-- Step 9: Add thread_id column to email_queue
ALTER TABLE "email_queue" ADD COLUMN IF NOT EXISTS "thread_id" uuid;

DO $$ BEGIN
  ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "email_queue_thread_idx" ON "email_queue" ("thread_id");
