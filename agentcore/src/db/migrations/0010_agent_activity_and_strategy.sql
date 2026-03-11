-- Add 'strategy' to agent_type enum
ALTER TYPE "agent_type" ADD VALUE IF NOT EXISTS 'strategy';

-- Create agent_activity_log table
CREATE TABLE IF NOT EXISTS "agent_activity_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "master_agent_id" uuid REFERENCES "master_agents"("id") ON DELETE SET NULL,
  "agent_type" "agent_type" NOT NULL,
  "action" varchar(100) NOT NULL,
  "status" varchar(20) NOT NULL,
  "input_summary" text,
  "output_summary" text,
  "details" jsonb,
  "duration_ms" integer,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes for agent_activity_log
CREATE INDEX IF NOT EXISTS "activity_log_tenant_created_idx" ON "agent_activity_log" ("tenant_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "activity_log_tenant_master_idx" ON "agent_activity_log" ("tenant_id", "master_agent_id");
CREATE INDEX IF NOT EXISTS "activity_log_tenant_type_idx" ON "agent_activity_log" ("tenant_id", "agent_type");
CREATE INDEX IF NOT EXISTS "activity_log_tenant_status_idx" ON "agent_activity_log" ("tenant_id", "status");

-- Create strategy_status enum
DO $$ BEGIN
  CREATE TYPE "strategy_status" AS ENUM ('pending', 'analyzing', 'executing', 'completed', 'failed');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create agent_daily_strategy table
CREATE TABLE IF NOT EXISTS "agent_daily_strategy" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "master_agent_id" uuid NOT NULL REFERENCES "master_agents"("id") ON DELETE CASCADE,
  "strategy_date" date NOT NULL,
  "performance_analysis" jsonb,
  "strategy_decisions" jsonb,
  "action_plan" jsonb,
  "execution_status" "strategy_status" DEFAULT 'pending' NOT NULL,
  "executed_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indexes for agent_daily_strategy
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_master_date_uniq" ON "agent_daily_strategy" ("master_agent_id", "strategy_date");
CREATE INDEX IF NOT EXISTS "strategy_tenant_master_idx" ON "agent_daily_strategy" ("tenant_id", "master_agent_id");
CREATE INDEX IF NOT EXISTS "strategy_tenant_date_idx" ON "agent_daily_strategy" ("tenant_id", "strategy_date" DESC);
