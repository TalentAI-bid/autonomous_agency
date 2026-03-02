CREATE TYPE "public"."crm_activity_type" AS ENUM('email_sent', 'email_opened', 'email_replied', 'email_bounced', 'stage_change', 'note_added', 'call_logged', 'meeting_scheduled', 'status_change', 'score_updated', 'agent_action');--> statement-breakpoint
CREATE TYPE "public"."email_provider" AS ENUM('smtp', 'ses', 'sendgrid', 'custom');--> statement-breakpoint
CREATE TYPE "public"."listener_protocol" AS ENUM('imap', 'pop3');--> statement-breakpoint
CREATE TYPE "public"."email_queue_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'email-listen';--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'email-send';--> statement-breakpoint
CREATE TABLE "crm_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid,
	"deal_id" uuid,
	"user_id" uuid,
	"master_agent_id" uuid,
	"type" "crm_activity_type" NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"color" varchar(7) DEFAULT '#6366f1' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_won" boolean DEFAULT false NOT NULL,
	"is_lost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_stages_tenant_slug_unique" UNIQUE("tenant_id","slug")
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"campaign_id" uuid,
	"stage_id" uuid NOT NULL,
	"title" varchar(500) NOT NULL,
	"value" numeric(12, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"notes" text,
	"closed_at" timestamp with time zone,
	"expected_close_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" "email_provider" DEFAULT 'smtp' NOT NULL,
	"smtp_host" varchar(255),
	"smtp_port" integer DEFAULT 587,
	"smtp_user" varchar(255),
	"smtp_pass" text,
	"from_email" varchar(255) NOT NULL,
	"from_name" varchar(255),
	"reply_to" varchar(255),
	"daily_quota" integer DEFAULT 500 NOT NULL,
	"hourly_quota" integer DEFAULT 50 NOT NULL,
	"is_warmup" boolean DEFAULT false NOT NULL,
	"warmup_start_date" timestamp with time zone,
	"warmup_days_sent" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_listener_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email_account_id" uuid,
	"protocol" "listener_protocol" DEFAULT 'imap' NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"username" varchar(255) NOT NULL,
	"password" text NOT NULL,
	"use_tls" boolean DEFAULT true NOT NULL,
	"mailbox" varchar(255) DEFAULT 'INBOX' NOT NULL,
	"polling_interval_ms" integer DEFAULT 60000 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_seen_uid" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid,
	"campaign_contact_id" uuid,
	"email_account_id" uuid,
	"from_email" varchar(255) NOT NULL,
	"to_email" varchar(255) NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"text_body" text,
	"tracking_id" varchar(255),
	"status" "email_queue_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"master_agent_id" uuid,
	"campaign_id" uuid,
	"step_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activities_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_crm_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."crm_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_listener_configs" ADD CONSTRAINT "email_listener_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_listener_configs" ADD CONSTRAINT "email_listener_configs_email_account_id_email_accounts_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_campaign_contact_id_campaign_contacts_id_fk" FOREIGN KEY ("campaign_contact_id") REFERENCES "public"."campaign_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_email_account_id_email_accounts_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_activities_tenant_idx" ON "crm_activities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "crm_activities_contact_idx" ON "crm_activities" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "crm_activities_deal_idx" ON "crm_activities" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "crm_activities_occurred_at_idx" ON "crm_activities" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "crm_activities_type_idx" ON "crm_activities" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "crm_stages_tenant_idx" ON "crm_stages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "crm_stages_tenant_position_idx" ON "crm_stages" USING btree ("tenant_id","position");--> statement-breakpoint
CREATE INDEX "deals_tenant_idx" ON "deals" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "deals_tenant_stage_idx" ON "deals" USING btree ("tenant_id","stage_id");--> statement-breakpoint
CREATE INDEX "deals_contact_idx" ON "deals" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "deals_master_agent_idx" ON "deals" USING btree ("master_agent_id");--> statement-breakpoint
CREATE INDEX "email_accounts_tenant_idx" ON "email_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_accounts_tenant_active_idx" ON "email_accounts" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "email_listener_configs_tenant_idx" ON "email_listener_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_listener_configs_active_idx" ON "email_listener_configs" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "email_queue_tenant_status_idx" ON "email_queue" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "email_queue_scheduled_idx" ON "email_queue" USING btree ("scheduled_at");