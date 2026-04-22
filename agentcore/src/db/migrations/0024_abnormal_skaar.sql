CREATE TABLE "pipeline_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"master_agent_id" uuid,
	"step" varchar(100) NOT NULL,
	"tool" varchar(50) NOT NULL,
	"severity" varchar(20) DEFAULT 'error' NOT NULL,
	"error_type" varchar(50) NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"retryable" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_errors" ADD CONSTRAINT "pipeline_errors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_errors" ADD CONSTRAINT "pipeline_errors_master_agent_id_master_agents_id_fk" FOREIGN KEY ("master_agent_id") REFERENCES "public"."master_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_errors_tenant_created_idx" ON "pipeline_errors" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "pipeline_errors_master_agent_idx" ON "pipeline_errors" USING btree ("master_agent_id","resolved_at");--> statement-breakpoint
CREATE INDEX "pipeline_errors_type_idx" ON "pipeline_errors" USING btree ("tenant_id","error_type");