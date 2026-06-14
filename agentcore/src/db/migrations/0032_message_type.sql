-- Studio: message_type subcategory (first_message, first_followup, second_followup,
-- breakup, reactivation, post_meeting, post_no_show). Drives prompt-injected
-- instructions inside agentcore/src/prompts/studio/_message-type-instructions.ts.

ALTER TABLE message_compositions
  ADD COLUMN IF NOT EXISTS message_type varchar(32) NOT NULL DEFAULT 'first_message';
