CREATE TYPE "public"."agent_type" AS ENUM('discovery', 'enrichment', 'document', 'scoring', 'outreach', 'reply', 'action', 'email-listen', 'email-send', 'mailbox', 'reddit-monitor', 'strategy', 'strategist');--> statement-breakpoint
CREATE TYPE "public"."strategy_status" AS ENUM('pending', 'analyzing', 'executing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('short_term', 'medium_term', 'long_term');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."campaign_contact_status" AS ENUM('pending', 'active', 'replied', 'bounced', 'unsubscribed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."step_channel" AS ENUM('email', 'linkedin');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."campaign_type" AS ENUM('email', 'linkedin', 'multi_channel');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('linkedin_search', 'linkedin_profile', 'cv_upload', 'manual', 'web_search', 'inbound', 'reddit');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('discovered', 'enriched', 'scored', 'contacted', 'replied', 'qualified', 'interview_scheduled', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_type" AS ENUM('text', 'file_upload', 'pipeline_proposal', 'pipeline_approved', 'error');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."crm_activity_type" AS ENUM('email_sent', 'email_opened', 'email_replied', 'email_received', 'email_bounced', 'stage_change', 'note_added', 'call_logged', 'meeting_scheduled', 'status_change', 'score_updated', 'agent_action');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('uploaded', 'processing', 'processed', 'error');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('job_spec', 'cv', 'whitepaper', 'spec', 'linkedin_profile', 'other');--> statement-breakpoint
CREATE TYPE "public"."email_provider" AS ENUM('smtp', 'ses', 'sendgrid', 'custom');--> statement-breakpoint
CREATE TYPE "public"."delivery_signal_type" AS ENUM('delivered', 'bounced_hard', 'bounced_soft', 'opened', 'replied');--> statement-breakpoint
CREATE TYPE "public"."email_discovery_method" AS ENUM('generect', 'searxng', 'github', 'domain_pattern', 'mx_guess', 'manual', 'crawl');--> statement-breakpoint
CREATE TYPE "public"."listener_protocol" AS ENUM('imap', 'pop3');--> statement-breakpoint
CREATE TYPE "public"."email_queue_status" AS ENUM('queued', 'sending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."email_thread_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."email_thread_status" AS ENUM('active', 'archived', 'needs_action', 'waiting');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."master_agent_status" AS ENUM('idle', 'running', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('new', 'researching', 'qualified', 'contacted', 'converted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."opportunity_type" AS ENUM('hiring_signal', 'direct_request', 'recommendation_ask', 'project_announcement', 'funding_signal', 'technology_adoption', 'tender_rfp', 'conference_signal', 'pain_point_expressed', 'partnership_signal');--> statement-breakpoint
CREATE TYPE "public"."opportunity_urgency" AS ENUM('immediate', 'soon', 'exploring', 'none');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'starter', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('recruitment', 'sales', 'both');--> statement-breakpoint
CREATE TYPE "public"."reddit_opportunity_status" AS ENUM('new', 'processing', 'contacted', 'converted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('interested', 'objection', 'not_now', 'out_of_office', 'unsubscribe', 'bounce', 'other', 'inquiry', 'application', 'partnership', 'support_request', 'spam', 'introduction');--> statement-breakpoint
CREATE TYPE "public"."use_case" AS ENUM('recruitment', 'sales', 'custom');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TABLE "agent_activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
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
--> statement-breakpoint
CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid NOT NULL,
	"agent_type" "agent_type" NOT NULL,
	"system_prompt" text,
	"tools" jsonb,
	"parameters" jsonb,
	"output_schema" jsonb,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_daily_strategy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid NOT NULL,
	"strategy_date" date NOT NULL,
	"performance_analysis" jsonb,
	"strategy_decisions" jsonb,
	"action_plan" jsonb,
	"execution_status" "strategy_status" DEFAULT 'pending' NOT NULL,
	"executed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"agent_type" "agent_type" NOT NULL,
	"memory_type" "memory_type" NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"from_agent" varchar(50) NOT NULL,
	"to_agent" varchar(50),
	"message_type" varchar(50) NOT NULL,
	"content" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"agent_type" "agent_type" NOT NULL,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" "campaign_contact_status" DEFAULT 'pending' NOT NULL,
	"last_action_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_number" integer NOT NULL,
	"subject" text,
	"template" text,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"channel" "step_channel" DEFAULT 'email' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"name" varchar(255) NOT NULL,
	"type" "campaign_type" DEFAULT 'email' NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"config" jsonb,
	"stats" jsonb DEFAULT '{"sent":0,"opened":0,"replied":0,"meetingsBooked":0}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"name" varchar(255) NOT NULL,
	"domain" varchar(255),
	"industry" varchar(255),
	"size" varchar(100),
	"tech_stack" jsonb,
	"funding" varchar(255),
	"linkedin_url" varchar(500),
	"description" text,
	"raw_data" jsonb,
	"score" integer,
	"score_details" jsonb,
	"data_completeness" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"first_name" varchar(255),
	"last_name" varchar(255),
	"email" varchar(255),
	"email_verified" boolean DEFAULT false,
	"linkedin_url" varchar(500),
	"title" varchar(255),
	"company_id" uuid,
	"company_name" varchar(255),
	"location" varchar(255),
	"skills" jsonb,
	"experience" jsonb,
	"education" jsonb,
	"score" integer,
	"score_details" jsonb,
	"source" "contact_source",
	"status" "contact_status" DEFAULT 'discovered' NOT NULL,
	"raw_data" jsonb,
	"data_completeness" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"type" "message_type" DEFAULT 'text' NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"proposal_data" jsonb,
	"order_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"status" "conversation_status" DEFAULT 'active' NOT NULL,
	"extracted_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"contact_id" uuid,
	"type" "doc_type" NOT NULL,
	"file_name" varchar(255),
	"file_path" varchar(500),
	"mime_type" varchar(100),
	"extracted_data" jsonb,
	"raw_text" text,
	"status" "doc_status" DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "delivery_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"domain" varchar(255) NOT NULL,
	"pattern_used" varchar(255),
	"signal_type" "delivery_signal_type" NOT NULL,
	"bounce_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" varchar(255) NOT NULL,
	"pattern" varchar(255) NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"bounced_count" integer DEFAULT 0 NOT NULL,
	"is_catch_all" boolean DEFAULT false NOT NULL,
	"mx_provider" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_intelligence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"first_name" varchar(255) NOT NULL,
	"last_name" varchar(255) NOT NULL,
	"domain" varchar(255) NOT NULL,
	"confidence" integer DEFAULT 0 NOT NULL,
	"method" "email_discovery_method",
	"source" text,
	"verified" boolean DEFAULT false NOT NULL,
	"invalidated" boolean DEFAULT false NOT NULL,
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
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid,
	"thread_id" uuid,
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
CREATE TABLE "email_threads" (
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
--> statement-breakpoint
CREATE TABLE "emails_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_contact_id" uuid,
	"step_id" uuid,
	"from_email" varchar(255),
	"to_email" varchar(255),
	"subject" text,
	"body" text,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"message_id" varchar(255),
	"tracking_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"scheduled_at" timestamp with time zone,
	"status" "interview_status" DEFAULT 'scheduled' NOT NULL,
	"meeting_url" varchar(500),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"mission" text,
	"use_case" "use_case" NOT NULL,
	"status" "master_agent_status" DEFAULT 'idle' NOT NULL,
	"config" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"opportunity_type" "opportunity_type" NOT NULL,
	"source" varchar(500),
	"source_url" varchar(1000),
	"source_platform" varchar(100),
	"company_name" varchar(255),
	"company_domain" varchar(255),
	"person_name" varchar(255),
	"person_title" varchar(255),
	"technologies" jsonb,
	"budget" varchar(100),
	"timeline" varchar(100),
	"location" varchar(255),
	"raw_content" text,
	"buying_intent_score" integer DEFAULT 0 NOT NULL,
	"urgency" "opportunity_urgency" DEFAULT 'none' NOT NULL,
	"status" "opportunity_status" DEFAULT 'new' NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reddit_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"reddit_post_id" varchar(50) NOT NULL,
	"subreddit" varchar(100),
	"post_title" text,
	"post_url" text NOT NULL,
	"author_username" varchar(100),
	"buying_intent_score" integer,
	"opportunity_type" varchar(50),
	"recommended_action" varchar(50),
	"extracted_data" jsonb,
	"author_profile_data" jsonb,
	"status" "reddit_opportunity_status" DEFAULT 'new' NOT NULL,
	"contact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"thread_id" uuid,
	"email_sent_id" uuid,
	"contact_id" uuid,
	"body" text,
	"from_email" varchar(255),
	"subject" text,
	"is_inbound" boolean DEFAULT false,
	"classification" "reply_classification",
	"sentiment" real,
	"auto_response" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"product_type" "product_type" DEFAULT 'recruitment' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"name" varchar(255),
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_activity_log" ADD CONSTRAINT "agent_activity_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_activity_log" ADD CONSTRAINT "agent_activity_log_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_daily_strategy" ADD CONSTRAINT "agent_daily_strategy_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_daily_strategy" ADD CONSTRAINT "agent_daily_strategy_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_listener_configs" ADD CONSTRAINT "email_listener_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_listener_configs" ADD CONSTRAINT "email_listener_configs_email_account_id_email_accounts_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_campaign_contact_id_campaign_contacts_id_fk" FOREIGN KEY ("campaign_contact_id") REFERENCES "public"."campaign_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_email_account_id_email_accounts_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD CONSTRAINT "emails_sent_campaign_contact_id_campaign_contacts_id_fk" FOREIGN KEY ("campaign_contact_id") REFERENCES "public"."campaign_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD CONSTRAINT "emails_sent_step_id_campaign_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."campaign_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agents" ADD CONSTRAINT "master_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agents" ADD CONSTRAINT "master_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_opportunities" ADD CONSTRAINT "reddit_opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_opportunities" ADD CONSTRAINT "reddit_opportunities_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_opportunities" ADD CONSTRAINT "reddit_opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_email_sent_id_emails_sent_id_fk" FOREIGN KEY ("email_sent_id") REFERENCES "public"."emails_sent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_tenant_created_idx" ON "agent_activity_log" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "activity_log_tenant_master_idx" ON "agent_activity_log" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "activity_log_tenant_type_idx" ON "agent_activity_log" USING btree ("tenant_id","agent_type");--> statement-breakpoint
CREATE INDEX "activity_log_tenant_status_idx" ON "agent_activity_log" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_master_type_uniq" ON "agent_configs" USING btree ("master_agent_id","agent_type");--> statement-breakpoint
CREATE INDEX "agent_configs_tenant_master_idx" ON "agent_configs" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_master_date_uniq" ON "agent_daily_strategy" USING btree ("master_agent_id","strategy_date");--> statement-breakpoint
CREATE INDEX "strategy_tenant_master_idx" ON "agent_daily_strategy" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "strategy_tenant_date_idx" ON "agent_daily_strategy" USING btree ("tenant_id","strategy_date" DESC);--> statement-breakpoint
CREATE INDEX "agent_memory_tenant_agent_idx" ON "agent_memory" USING btree ("tenant_id","master_agent_id","agent_type");--> statement-breakpoint
CREATE INDEX "agent_memory_key_idx" ON "agent_memory" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "agent_messages_tenant_master_idx" ON "agent_messages" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "agent_messages_created_idx" ON "agent_messages" USING btree ("master_agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_messages_from_agent_idx" ON "agent_messages" USING btree ("master_agent_id","from_agent");--> statement-breakpoint
CREATE INDEX "agent_messages_type_idx" ON "agent_messages" USING btree ("master_agent_id","message_type");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_status_idx" ON "agent_tasks" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_created_idx" ON "agent_tasks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_master_idx" ON "agent_tasks" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_contacts_campaign_contact_uniq" ON "campaign_contacts" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "campaign_contacts_status_idx" ON "campaign_contacts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaign_steps_campaign_idx" ON "campaign_steps" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_tenant_status_idx" ON "campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_active_idx" ON "campaigns" USING btree ("id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "companies_tenant_id_idx" ON "companies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "companies_tenant_master_idx" ON "companies" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "companies_tech_stack_gin_idx" ON "companies" USING gin ("tech_stack" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "companies_completeness_idx" ON "companies" USING btree ("tenant_id","data_completeness");--> statement-breakpoint
CREATE INDEX "contacts_tenant_status_idx" ON "contacts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "contacts_tenant_created_idx" ON "contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_tenant_master_idx" ON "contacts" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "contacts_email_gin_idx" ON "contacts" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_skills_gin_idx" ON "contacts" USING gin ("skills" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "contacts_completeness_idx" ON "contacts" USING btree ("tenant_id","data_completeness");--> statement-breakpoint
CREATE INDEX "conversation_messages_conversation_id_idx" ON "conversation_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_order_idx" ON "conversation_messages" USING btree ("conversation_id","order_index");--> statement-breakpoint
CREATE INDEX "conversations_tenant_id_idx" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversations_user_id_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_tenant_status_idx" ON "conversations" USING btree ("tenant_id","status");--> statement-breakpoint
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
CREATE INDEX "documents_tenant_master_idx" ON "documents" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_created_idx" ON "documents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "email_accounts_tenant_idx" ON "email_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_accounts_tenant_active_idx" ON "email_accounts" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "delivery_signals_domain_idx" ON "delivery_signals" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "delivery_signals_email_idx" ON "delivery_signals" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_patterns_domain_pattern_uniq" ON "domain_patterns" USING btree ("domain","pattern");--> statement-breakpoint
CREATE INDEX "domain_patterns_domain_idx" ON "domain_patterns" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "email_intel_name_domain_uniq" ON "email_intelligence" USING btree ("first_name","last_name","domain");--> statement-breakpoint
CREATE INDEX "email_intel_domain_name_idx" ON "email_intelligence" USING btree ("domain","first_name","last_name");--> statement-breakpoint
CREATE INDEX "email_intel_email_idx" ON "email_intelligence" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_listener_configs_tenant_idx" ON "email_listener_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_listener_configs_active_idx" ON "email_listener_configs" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "email_queue_tenant_status_idx" ON "email_queue" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "email_queue_scheduled_idx" ON "email_queue" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "email_queue_thread_idx" ON "email_queue" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "email_threads_tenant_idx" ON "email_threads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_threads_tenant_status_idx" ON "email_threads" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "email_threads_tenant_last_msg_idx" ON "email_threads" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE INDEX "email_threads_contact_idx" ON "email_threads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "email_threads_deal_idx" ON "email_threads" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "emails_sent_campaign_contact_idx" ON "emails_sent" USING btree ("campaign_contact_id");--> statement-breakpoint
CREATE INDEX "emails_sent_sent_at_idx" ON "emails_sent" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "emails_sent_tracking_id_idx" ON "emails_sent" USING btree ("tracking_id");--> statement-breakpoint
CREATE INDEX "interviews_tenant_id_idx" ON "interviews" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "interviews_contact_idx" ON "interviews" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "master_agents_tenant_id_idx" ON "master_agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "master_agents_tenant_status_idx" ON "master_agents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "master_agents_active_idx" ON "master_agents" USING btree ("id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "opportunities_tenant_master_idx" ON "opportunities" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "opportunities_tenant_status_idx" ON "opportunities" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "opportunities_tenant_score_idx" ON "opportunities" USING btree ("tenant_id","buying_intent_score" DESC);--> statement-breakpoint
CREATE INDEX "opportunities_tenant_created_idx" ON "opportunities" USING btree ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "reddit_opp_tenant_post_uniq" ON "reddit_opportunities" USING btree ("tenant_id","reddit_post_id");--> statement-breakpoint
CREATE INDEX "reddit_opp_tenant_status_idx" ON "reddit_opportunities" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "reddit_opp_tenant_score_idx" ON "reddit_opportunities" USING btree ("tenant_id","buying_intent_score" DESC);--> statement-breakpoint
CREATE INDEX "reddit_opp_tenant_master_idx" ON "reddit_opportunities" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "replies_email_sent_idx" ON "replies" USING btree ("email_sent_id");--> statement-breakpoint
CREATE INDEX "replies_contact_idx" ON "replies" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "replies_tenant_created_idx" ON "replies" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "replies_thread_idx" ON "replies" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id");