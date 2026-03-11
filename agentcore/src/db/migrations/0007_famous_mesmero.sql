CREATE TYPE "public"."delivery_signal_type" AS ENUM('delivered', 'bounced_hard', 'bounced_soft', 'opened', 'replied');--> statement-breakpoint
CREATE TYPE "public"."email_discovery_method" AS ENUM('searxng', 'github', 'domain_pattern', 'mx_guess', 'manual', 'crawl');--> statement-breakpoint
CREATE TYPE "public"."email_thread_priority" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."email_thread_status" AS ENUM('active', 'archived', 'needs_action', 'waiting');--> statement-breakpoint
ALTER TYPE "public"."agent_type" ADD VALUE 'mailbox';--> statement-breakpoint
ALTER TYPE "public"."crm_activity_type" ADD VALUE 'email_received' BEFORE 'email_bounced';--> statement-breakpoint
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
ALTER TABLE "companies" ADD COLUMN "master_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "email_listener_configs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD COLUMN "tracking_id" varchar(255);--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_signals_domain_idx" ON "delivery_signals" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "delivery_signals_email_idx" ON "delivery_signals" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_patterns_domain_pattern_uniq" ON "domain_patterns" USING btree ("domain","pattern");--> statement-breakpoint
CREATE INDEX "domain_patterns_domain_idx" ON "domain_patterns" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "email_intel_name_domain_uniq" ON "email_intelligence" USING btree ("first_name","last_name","domain");--> statement-breakpoint
CREATE INDEX "email_intel_domain_name_idx" ON "email_intelligence" USING btree ("domain","first_name","last_name");--> statement-breakpoint
CREATE INDEX "email_intel_email_idx" ON "email_intelligence" USING btree ("email");--> statement-breakpoint
CREATE INDEX "email_threads_tenant_idx" ON "email_threads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_threads_tenant_status_idx" ON "email_threads" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "email_threads_tenant_last_msg_idx" ON "email_threads" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE INDEX "email_threads_contact_idx" ON "email_threads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "email_threads_deal_idx" ON "email_threads" USING btree ("deal_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_queue" ADD CONSTRAINT "email_queue_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_thread_id_email_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."email_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_tenant_master_idx" ON "companies" USING btree ("tenant_id","master_agent_id");--> statement-breakpoint
CREATE INDEX "email_queue_thread_idx" ON "email_queue" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "emails_sent_tracking_id_idx" ON "emails_sent" USING btree ("tracking_id");--> statement-breakpoint
CREATE INDEX "replies_tenant_created_idx" ON "replies" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "replies_thread_idx" ON "replies" USING btree ("thread_id");