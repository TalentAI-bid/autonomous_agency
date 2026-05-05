-- Forward-additive: aligns DB with agentcore/src/db/schema/contacts.ts:41,45.
-- Schema declared these in Round 7 (followup scheduler + manual unsubscribe)
-- but the migration was never generated. Every EnrichmentAgent.execute then
-- crashed on `SELECT * FROM contacts` with `column "timezone" does not exist`,
-- silently halting the post-discovery pipeline.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "unsubscribed" boolean DEFAULT false NOT NULL;
