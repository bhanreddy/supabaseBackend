-- Nexsyrus Support messenger threads.
-- Intentionally additive. Support users are created lazily per school.
-- NOTE: schema.sql is intentionally not updated here, matching the existing
-- messenger migration pattern; the canonical snapshot can be refreshed later.

ALTER TABLE message_conversations
  DROP CONSTRAINT IF EXISTS message_conversations_pair_type_check;

ALTER TABLE message_conversations
  ADD CONSTRAINT message_conversations_pair_type_check
  CHECK (pair_type IN ('parent_admin','admin_teacher','teacher_parent','group','support'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_support_bot BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS unq_users_support_bot
  ON users (school_id)
  WHERE is_support_bot = true AND deleted_at IS NULL;
