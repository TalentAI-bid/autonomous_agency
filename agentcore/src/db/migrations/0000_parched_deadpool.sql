CREATE TYPE "public"."agent_type" AS ENUM('discovery', 'enrichment', 'document', 'scoring', 'outreach', 'reply', 'action');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('short_term', 'medium_term', 'long_term');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."campaign_contact_status" AS ENUM('pending', 'active', 'replied', 'bounced', 'unsubscribed', 'completed');--> statement-breakpoint
CREATE TYPE "public"."step_channel" AS ENUM('email', 'linkedin');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'completed');--> statement-breakpoint
CREATE TYPE "public"."campaign_type" AS ENUM('email', 'linkedin', 'multi_channel');--> statement-breakpoint
CREATE TYPE "public"."contact_source" AS ENUM('linkedin_search', 'linkedin_profile', 'cv_upload', 'manual', 'web_search');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('discovered', 'enriched', 'scored', 'contacted', 'replied', 'qualified', 'interview_scheduled', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('uploaded', 'processing', 'processed', 'error');--> statement-breakpoint
CREATE TYPE "public"."doc_type" AS ENUM('job_spec', 'cv', 'whitepaper', 'spec', 'linkedin_profile', 'other');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."master_agent_status" AS ENUM('idle', 'running', 'paused', 'error');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'starter', 'pro', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('recruitment', 'sales', 'both');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('interested', 'objection', 'not_now', 'out_of_office', 'unsubscribe', 'bounce', 'other');--> statement-breakpoint
CREATE TYPE "public"."use_case" AS ENUM('recruitment', 'sales', 'custom');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
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
	"name" varchar(255) NOT NULL,
	"domain" varchar(255),
	"industry" varchar(255),
	"size" varchar(100),
	"tech_stack" jsonb,
	"funding" varchar(255),
	"linkedin_url" varchar(500),
	"description" text,
	"raw_data" jsonb,
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
	"message_id" varchar(255)
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
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email_sent_id" uuid,
	"contact_id" uuid,
	"body" text,
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
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD CONSTRAINT "campaign_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD CONSTRAINT "campaign_steps_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD CONSTRAINT "emails_sent_campaign_contact_id_campaign_contacts_id_fk" FOREIGN KEY ("campaign_contact_id") REFERENCES "public"."campaign_contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD CONSTRAINT "emails_sent_step_id_campaign_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."campaign_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agents" ADD CONSTRAINT "master_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_agents" ADD CONSTRAINT "master_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_email_sent_id_emails_sent_id_fk" FOREIGN KEY ("email_sent_id") REFERENCES "public"."emails_sent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_master_type_uniq" ON "agent_configs" USING btree ("master_agent_id","agent_type");--> statement-breakpoint
CREATE INDEX "agent_configs_tenant_master_idx" ON "agent_configs" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "agent_memory_tenant_agent_idx" ON "agent_memory" USING btree ("tenant_id","master_agent_id","agent_type");--> statement-breakpoint
CREATE INDEX "agent_memory_key_idx" ON "agent_memory" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_status_idx" ON "agent_tasks" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_created_idx" ON "agent_tasks" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_tenant_master_idx" ON "agent_tasks" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_contacts_campaign_contact_uniq" ON "campaign_contacts" USING btree ("campaign_id","contact_id");--> statement-breakpoint
CREATE INDEX "campaign_contacts_status_idx" ON "campaign_contacts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaign_steps_campaign_idx" ON "campaign_steps" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_tenant_status_idx" ON "campaigns" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "campaigns_active_idx" ON "campaigns" USING btree ("id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "companies_tenant_id_idx" ON "companies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "companies_tech_stack_gin_idx" ON "companies" USING gin ("tech_stack" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "contacts_tenant_status_idx" ON "contacts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "contacts_tenant_created_idx" ON "contacts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "contacts_tenant_master_idx" ON "contacts" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "contacts_email_gin_idx" ON "contacts" USING gin ("email" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_skills_gin_idx" ON "contacts" USING gin ("skills" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "documents_tenant_master_idx" ON "documents" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_created_idx" ON "documents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "emails_sent_campaign_contact_idx" ON "emails_sent" USING btree ("campaign_contact_id");--> statement-breakpoint
CREATE INDEX "emails_sent_sent_at_idx" ON "emails_sent" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "interviews_tenant_id_idx" ON "interviews" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "interviews_contact_idx" ON "interviews" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "master_agents_tenant_id_idx" ON "master_agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "master_agents_tenant_status_idx" ON "master_agents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "master_agents_active_idx" ON "master_agents" USING btree ("id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "replies_email_sent_idx" ON "replies" USING btree ("email_sent_id");--> statement-breakpoint
CREATE INDEX "replies_contact_idx" ON "replies" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id");