ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "is_primary_contact" boolean DEFAULT false NOT NULL;
