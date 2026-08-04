-- Global LinkedIn People search task type (role + optional geography → import
-- people across companies as leads). Idempotent; applied via psql (the drizzle
-- journal is maintained separately).
ALTER TYPE extension_task_type ADD VALUE IF NOT EXISTS 'search_people';
