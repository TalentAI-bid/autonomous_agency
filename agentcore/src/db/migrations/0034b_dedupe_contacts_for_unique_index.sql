-- Sales Operations Platform — Stage 1 dedup step.
--
-- The two partial unique indexes added in 0034 (contacts_tenant_email_unique
-- and contacts_tenant_linkedin_unique) failed because historical inserts
-- produced duplicates: ~1 email duplicate and ~589 linkedin_url duplicates
-- across all tenants. Most originate from earlier AI-discovery runs racing
-- against themselves before dispatcher dedup tightened.
--
-- Strategy: soft-merge. For each (tenant_id, identifier) duplicate group,
-- KEEP the oldest contact's identifier; NULL the identifier on every newer
-- row. No rows are deleted — all referenced history (outreach_emails,
-- crm_activities, deals) stays intact. The newer "shadow" duplicates remain
-- as contacts with their other fields preserved (name, title, company,
-- skills, rawData) but no longer claim the conflicting email/linkedin_url.
--
-- The cleared values are preserved in source_metadata.dedupShadow so a
-- future merge-contacts tool can reconstruct the original identifier if
-- needed. This step is idempotent — re-running finds no dups and noops.

BEGIN;

-- 1) Email duplicates. Keep the OLDEST (by created_at, then id) per
--    (tenant_id, lower(email)); NULL the email on newer rows.
WITH ranked_email AS (
  SELECT id, tenant_id, email, created_at,
         row_number() OVER (
           PARTITION BY tenant_id, lower(email)
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM contacts
   WHERE email IS NOT NULL
),
shadow_email AS (
  SELECT id, email FROM ranked_email WHERE rn > 1
)
UPDATE contacts c
   SET email = NULL,
       source_metadata = COALESCE(c.source_metadata, '{}'::jsonb)
                       || jsonb_build_object('dedupShadow',
                            COALESCE(c.source_metadata->'dedupShadow', '{}'::jsonb)
                            || jsonb_build_object('email', s.email)),
       updated_at = NOW()
  FROM shadow_email s
 WHERE c.id = s.id;

-- 2) LinkedIn-URL duplicates. Same strategy.
WITH ranked_li AS (
  SELECT id, tenant_id, linkedin_url, created_at,
         row_number() OVER (
           PARTITION BY tenant_id, linkedin_url
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM contacts
   WHERE linkedin_url IS NOT NULL
),
shadow_li AS (
  SELECT id, linkedin_url FROM ranked_li WHERE rn > 1
)
UPDATE contacts c
   SET linkedin_url = NULL,
       source_metadata = COALESCE(c.source_metadata, '{}'::jsonb)
                       || jsonb_build_object('dedupShadow',
                            COALESCE(c.source_metadata->'dedupShadow', '{}'::jsonb)
                            || jsonb_build_object('linkedinUrl', s.linkedin_url)),
       updated_at = NOW()
  FROM shadow_li s
 WHERE c.id = s.id;

COMMIT;

-- 3) Now (idempotently) re-attempt the indexes from 0034 that failed.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_email_unique
  ON contacts (tenant_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_tenant_linkedin_unique
  ON contacts (tenant_id, linkedin_url) WHERE linkedin_url IS NOT NULL;
