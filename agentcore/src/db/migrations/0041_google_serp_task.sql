-- Google web-search (SERP) discovery: a new 'google' extension site and a
-- 'search_serp' task type. The extension opens google.com/search with an
-- R1-generated dork and returns result URLs; the server router interprets
-- LinkedIn company/person URLs. Idempotent; applied via psql (the drizzle
-- journal is maintained separately).
ALTER TYPE extension_site ADD VALUE IF NOT EXISTS 'google';
ALTER TYPE extension_task_type ADD VALUE IF NOT EXISTS 'search_serp';
