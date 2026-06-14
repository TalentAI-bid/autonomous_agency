ALTER TABLE "extension_tasks" ADD COLUMN IF NOT EXISTS "dispatch_after" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extension_tasks_dispatch_after_idx" ON "extension_tasks" USING btree ("tenant_id","status","dispatch_after");
