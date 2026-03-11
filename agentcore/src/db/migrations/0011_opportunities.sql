DO $$ BEGIN
  CREATE TYPE "opportunity_type" AS ENUM('hiring_signal', 'direct_request', 'recommendation_ask', 'project_announcement', 'funding_signal', 'technology_adoption', 'tender_rfp', 'conference_signal', 'pain_point_expressed', 'partnership_signal');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "opportunity_urgency" AS ENUM('immediate', 'soon', 'exploring', 'none');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "opportunity_status" AS ENUM('new', 'researching', 'qualified', 'contacted', 'converted', 'skipped');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "opportunities" (
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

DO $$ BEGIN
  ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "master_agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "opportunities_tenant_master_idx" ON "opportunities" ("tenant_id", "master_agent_id");
CREATE INDEX IF NOT EXISTS "opportunities_tenant_status_idx" ON "opportunities" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "opportunities_tenant_score_idx" ON "opportunities" ("tenant_id", "buying_intent_score" DESC);
CREATE INDEX IF NOT EXISTS "opportunities_tenant_created_idx" ON "opportunities" ("tenant_id", "created_at" DESC);
