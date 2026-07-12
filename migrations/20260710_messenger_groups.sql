-- ============================================================================
-- 20260710_messenger_groups.sql
-- Extend the 1:1 messenger to support admin-created GROUPS.
--   • group_mode 'broadcast' → only group admins (creator) may post; members read
--   • group_mode 'chat'      → any member may post (WhatsApp-style)
-- Members can be any mix of teachers + students/parents (admin's choice).
-- 1:1 threads are unchanged; the dedupe unique index is made partial so it only
-- constrains non-group rows.
-- ============================================================================

-- 1. Group columns on the conversation
ALTER TABLE message_conversations
    ADD COLUMN IF NOT EXISTS is_group    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS group_name  TEXT NULL,
    ADD COLUMN IF NOT EXISTS group_mode  TEXT NULL,
    ADD COLUMN IF NOT EXISTS created_by  UUID NULL REFERENCES users(id);

-- group_mode is only meaningful for groups; constrain its values
ALTER TABLE message_conversations DROP CONSTRAINT IF EXISTS chk_message_conversations_group_mode;
ALTER TABLE message_conversations ADD CONSTRAINT chk_message_conversations_group_mode
    CHECK (group_mode IS NULL OR group_mode IN ('broadcast', 'chat'));

-- A group must have a name + mode; a 1:1 must not
ALTER TABLE message_conversations DROP CONSTRAINT IF EXISTS chk_message_conversations_group_shape;
ALTER TABLE message_conversations ADD CONSTRAINT chk_message_conversations_group_shape
    CHECK (
        (is_group = true  AND group_name IS NOT NULL AND group_mode IS NOT NULL)
     OR (is_group = false AND group_name IS NULL     AND group_mode IS NULL)
    );

-- 2. Allow 'group' as a pair_type and relax the 1:1 participant columns for groups
ALTER TABLE message_conversations DROP CONSTRAINT IF EXISTS message_conversations_pair_type_check;
ALTER TABLE message_conversations ADD CONSTRAINT message_conversations_pair_type_check
    CHECK (pair_type IN ('parent_admin', 'admin_teacher', 'teacher_parent', 'group'));

ALTER TABLE message_conversations ALTER COLUMN participant_low_user_id  DROP NOT NULL;
ALTER TABLE message_conversations ALTER COLUMN participant_high_user_id DROP NOT NULL;

-- 3. Dedupe unique index applies to 1:1 threads ONLY (groups aren't deduped)
DROP INDEX IF EXISTS unq_message_conversations_pair;
CREATE UNIQUE INDEX IF NOT EXISTS unq_message_conversations_pair
    ON message_conversations (
        school_id,
        participant_low_user_id,
        participant_high_user_id,
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000')
    )
    WHERE is_group = false;

-- 4. Per-member group-admin flag (creator can post in broadcast mode)
ALTER TABLE message_participants
    ADD COLUMN IF NOT EXISTS is_group_admin BOOLEAN NOT NULL DEFAULT false;

-- 5. Fast "list a user's conversations" via participation (covers groups + 1:1)
CREATE INDEX IF NOT EXISTS idx_participants_user_conv
    ON message_participants (user_id, school_id, conversation_id);
