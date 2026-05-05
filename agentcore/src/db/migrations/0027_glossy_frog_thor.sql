ALTER TYPE "public"."extension_task_type" ADD VALUE 'fetch_company_info';--> statement-breakpoint
ALTER TYPE "public"."extension_task_type" ADD VALUE 'fetch_company_team';--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "is_primary_contact" boolean DEFAULT false NOT NULL;