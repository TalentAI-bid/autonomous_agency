CREATE TYPE "public"."step_delay_basis" AS ENUM('after_first', 'after_previous');--> statement-breakpoint
CREATE TYPE "public"."step_type" AS ENUM('initial', 'followup_short', 'followup_value', 'followup_breakup', 'custom');--> statement-breakpoint
ALTER TYPE "public"."campaign_contact_status" ADD VALUE 'in_sequence';--> statement-breakpoint
ALTER TYPE "public"."campaign_contact_status" ADD VALUE 'stopped_manual';--> statement-breakpoint
ALTER TYPE "public"."campaign_contact_status" ADD VALUE 'failed';--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "next_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "stopped_reason" text;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_contacts" ADD COLUMN "sequence_state" jsonb;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "delay_basis" "step_delay_basis" DEFAULT 'after_first' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "step_type" "step_type" DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_steps" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "unsubscribed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD COLUMN "touch_number" integer;--> statement-breakpoint
ALTER TABLE "emails_sent" ADD COLUMN "in_reply_to" varchar(998);--> statement-breakpoint
ALTER TABLE "emails_sent" ADD COLUMN "references" text;--> statement-breakpoint
ALTER TABLE "extension_tasks" ADD COLUMN "dispatch_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "campaign_contacts_due_idx" ON "campaign_contacts" USING btree ("status","next_scheduled_at");--> statement-breakpoint
CREATE INDEX "extension_tasks_dispatch_after_idx" ON "extension_tasks" USING btree ("tenant_id","status","dispatch_after");