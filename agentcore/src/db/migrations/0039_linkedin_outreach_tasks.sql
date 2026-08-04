-- Review-then-send LinkedIn outreach task types for the browser extension.
-- linkedin_message: open the profile, click Message, type the DM, leave it for
--   the user to click Send.
-- linkedin_connect: open the profile, click Connect → Add a note, type the
--   note, leave it for the user to click Send.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older
-- Postgres, so apply these standalone.
ALTER TYPE extension_task_type ADD VALUE IF NOT EXISTS 'linkedin_message';
ALTER TYPE extension_task_type ADD VALUE IF NOT EXISTS 'linkedin_connect';
