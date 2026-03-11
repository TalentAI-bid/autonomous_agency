ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "data_completeness" integer DEFAULT 0;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "data_completeness" integer DEFAULT 0;
CREATE INDEX IF NOT EXISTS "companies_completeness_idx" ON "companies" ("tenant_id", "data_completeness");
CREATE INDEX IF NOT EXISTS "contacts_completeness_idx" ON "contacts" ("tenant_id", "data_completeness");
