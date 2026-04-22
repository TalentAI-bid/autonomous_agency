CREATE TYPE "public"."review_mode" AS ENUM('auto', 'manual');--> statement-breakpoint
ALTER TYPE "public"."master_agent_status" ADD VALUE 'awaiting_action_plan';--> statement-breakpoint
ALTER TYPE "public"."master_agent_status" ADD VALUE 'paused_quota';--> statement-breakpoint
ALTER TABLE "master_agents" ADD COLUMN "action_plan" jsonb;--> statement-breakpoint
ALTER TABLE "master_agents" ADD COLUMN "review_mode" "review_mode" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "master_agents" ADD COLUMN "daily_runtime_budget_ms" integer DEFAULT 3600000 NOT NULL;