CREATE TABLE "outreach_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"contact_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"message_id" text,
	"status" varchar(20) DEFAULT 'sent' NOT NULL,
	"sent_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"target_audience" text,
	"pain_points_solved" jsonb,
	"key_features" jsonb,
	"differentiators" jsonb,
	"pricing_model" varchar(50),
	"pricing_details" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "pain_points" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "website_status" varchar(50);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "seo_score" integer;--> statement-breakpoint
ALTER TABLE "outreach_emails" ADD CONSTRAINT "outreach_emails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_emails" ADD CONSTRAINT "outreach_emails_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_emails" ADD CONSTRAINT "outreach_emails_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_emails_tenant_idx" ON "outreach_emails" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "outreach_emails_contact_idx" ON "outreach_emails" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "outreach_emails_tenant_contact_idx" ON "outreach_emails" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX "products_tenant_id_idx" ON "products" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "products_tenant_active_idx" ON "products" USING btree ("tenant_id","is_active");