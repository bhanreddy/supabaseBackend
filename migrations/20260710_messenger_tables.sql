-- ============================================================================
-- 20260710_messenger_tables.sql
-- In-app 1:1 messenger: parent↔admin, admin↔teacher, teacher↔parent
-- ============================================================================

-- 1. Conversations — one row per 1:1 thread
CREATE TABLE IF NOT EXISTS message_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    pair_type TEXT NOT NULL CHECK (pair_type IN ('parent_admin', 'admin_teacher', 'teacher_parent')),
    participant_low_user_id UUID NOT NULL REFERENCES users(id),
    participant_high_user_id UUID NOT NULL REFERENCES users(id),
    student_id UUID NULL REFERENCES students(id),
    subject TEXT NULL,
    last_message_at TIMESTAMPTZ NULL,
    last_message_preview TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ NULL
    -- Unique constraint handled via index below to support COALESCE expression
);

CREATE UNIQUE INDEX IF NOT EXISTS unq_message_conversations_pair
    ON message_conversations (
        school_id, 
        participant_low_user_id, 
        participant_high_user_id, 
        COALESCE(student_id, '00000000-0000-0000-0000-000000000000')
    );

-- 2. Participants — 2 rows per conversation (read state + mute per user)
CREATE TABLE IF NOT EXISTS message_participants (
    conversation_id UUID NOT NULL REFERENCES message_conversations(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    last_read_at TIMESTAMPTZ NULL,
    muted BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (conversation_id, user_id)
);

-- 3. Messages — individual messages in a thread
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES message_conversations(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    sender_user_id UUID NOT NULL REFERENCES users(id),
    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL
);

-- ============================================================================
-- Indexes (keyset pagination + unread must be fast)
-- ============================================================================

-- Thread messages: keyset pagination by (created_at DESC, id DESC)
CREATE INDEX IF NOT EXISTS idx_messages_conv_created
    ON messages (conversation_id, created_at DESC, id DESC);

-- Conversation list for a user: find all conversations where user is participant_low
CREATE INDEX IF NOT EXISTS idx_conv_low_user
    ON message_conversations (school_id, participant_low_user_id, last_message_at DESC NULLS LAST);

-- Conversation list for a user: find all conversations where user is participant_high
CREATE INDEX IF NOT EXISTS idx_conv_high_user
    ON message_conversations (school_id, participant_high_user_id, last_message_at DESC NULLS LAST);

-- Fast participant lookup for access checks and unread count
CREATE INDEX IF NOT EXISTS idx_participants_user
    ON message_participants (user_id, school_id);

-- ============================================================================
-- Triggers
-- ============================================================================

-- Reuse existing update_timestamp() for updated_at on conversations
CREATE TRIGGER trg_message_conversations_updated_at
    BEFORE UPDATE ON message_conversations
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- Auto-update conversation preview on new message insert
CREATE OR REPLACE FUNCTION update_conversation_on_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE message_conversations
    SET last_message_at = NEW.created_at,
        last_message_preview = LEFT(NEW.body, 100),
        updated_at = now()
    WHERE id = NEW.conversation_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_messages_update_conversation
    AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION update_conversation_on_message();
