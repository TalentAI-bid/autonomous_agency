CREATE TYPE "public"."extension_site" AS ENUM('linkedin', 'gmaps', 'crunchbase');--> statement-breakpoint
CREATE TYPE "public"."extension_task_status" AS ENUM('pending', 'dispatched', 'in_progress', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."extension_task_type" AS ENUM('search_companies', 'fetch_company', 'search_businesses', 'fetch_business');--> statement-breakpoint
CREATE TABLE "extension_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key" varchar(128),
	"api_key_hash" varchar(128) NOT NULL,
	"connected" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"daily_tasks_count" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"session_id" uuid,
	"site" "extension_site" NOT NULL,
	"type" "extension_task_type" NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "extension_task_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error" text,
	"priority" integer DEFAULT 5 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_sessions" ADD CONSTRAINT "extension_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_sessions" ADD CONSTRAINT "extension_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_tasks" ADD CONSTRAINT "extension_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_tasks" ADD CONSTRAINT "extension_tasks_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_tasks" ADD CONSTRAINT "extension_tasks_session_id_extension_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."extension_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_sessions_api_key_hash_idx" ON "extension_sessions" USING btree ("api_key_hash");--> statement-breakpoint
CREATE INDEX "extension_sessions_tenant_user_idx" ON "extension_sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "extension_sessions_tenant_revoked_idx" ON "extension_sessions" USING btree ("tenant_id","revoked_at");--> statement-breakpoint
CREATE INDEX "extension_tasks_tenant_status_priority_idx" ON "extension_tasks" USING btree ("tenant_id","status","priority","created_at");--> statement-breakpoint
CREATE INDEX "extension_tasks_site_status_idx" ON "extension_tasks" USING btree ("site","status");--> statement-breakpoint
CREATE INDEX "extension_tasks_session_status_idx" ON "extension_tasks" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "extension_tasks_master_agent_idx" ON "extension_tasks" USING btree ("master_agent_id");