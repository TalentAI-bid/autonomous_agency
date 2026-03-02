ALTER TABLE "companies" ADD COLUMN "master_agent_id" uuid REFERENCES "master_agents"("id") ON DELETE SET NULL;
CREATE INDEX "companies_tenant_master_idx" ON "companies" ("tenant_id", "master_agent_id");
