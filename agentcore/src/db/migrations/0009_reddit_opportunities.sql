-- Reddit Opportunities
CREATE TYPE "public"."reddit_opportunity_status" AS ENUM('new', 'processing', 'contacted', 'converted', 'skipped');--> statement-breakpoint

ALTER TYPE "public"."contact_source" ADD VALUE IF NOT EXISTS 'reddit';--> statement-breakpoint

ALTER TYPE "public"."agent_type" ADD VALUE IF NOT EXISTS 'reddit-monitor';--> statement-breakpoint

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
);--> statement-breakpoint

ALTER TABLE "reddit_opportunities" ADD CONSTRAINT "reddit_opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_opportunities" ADD CONSTRAINT "reddit_opportunities_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reddit_opportunities" ADD CONSTRAINT "reddit_opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "reddit_opp_tenant_post_uniq" ON "reddit_opportunities" USING btree ("tenant_id","reddit_post_id");--> statement-breakpoint
CREATE INDEX "reddit_opp_tenant_status_idx" ON "reddit_opportunities" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "reddit_opp_tenant_score_idx" ON "reddit_opportunities" USING btree ("tenant_id","buying_intent_score" DESC);--> statement-breakpoint
CREATE INDEX "reddit_opp_tenant_master_idx" ON "reddit_opportunities" USING btree ("tenant_id","master_agent_id");
