ALTER TYPE "public"."contact_source" ADD VALUE 'inbound';--> statement-breakpoint
ALTER TYPE "public"."reply_classification" ADD VALUE 'inquiry';--> statement-breakpoint
ALTER TYPE "public"."reply_classification" ADD VALUE 'application';--> statement-breakpoint
ALTER TYPE "public"."reply_classification" ADD VALUE 'partnership';--> statement-breakpoint
ALTER TYPE "public"."reply_classification" ADD VALUE 'support_request';--> statement-breakpoint
ALTER TYPE "public"."reply_classification" ADD VALUE 'spam';--> statement-breakpoint
ALTER TYPE "public"."reply_classification" ADD VALUE 'introduction';--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "from_email" varchar(255);--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "is_inbound" boolean DEFAULT false;