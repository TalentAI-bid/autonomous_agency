-- Add a single-person profile re-scrape task type for the browser extension.
-- Used by POST /api/contacts/:id/rescrape-linkedin to open one /in/<handle>/
-- page and read the correct name/title when the company-team scrape got it
-- wrong. ALTER TYPE ... ADD VALUE cannot run inside a transaction block in
-- older Postgres, so apply this statement standalone.
ALTER TYPE extension_task_type ADD VALUE IF NOT EXISTS 'fetch_profile';
