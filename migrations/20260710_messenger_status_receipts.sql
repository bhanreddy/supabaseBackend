-- ============================================================================
-- 20260710_messenger_status_receipts.sql
-- WhatsApp-style delivery/seen status + idempotent sends, using scalable
-- high-water marks on message_participants (NO per-message receipt rows).
--   • "seen"      → participant.last_read_at      >= message.created_at
--   • "delivered" → participant.last_delivered_at >= message.created_at
--   • "sent"      → row exists on the server
-- For groups a message is delivered/seen when the MIN high-water across every
-- other participant crosses the message time (i.e. everyone has it).
-- ============================================================================

-- 1. Per-participant "delivered up to" high-water mark (seen already exists as last_read_at)
ALTER TABLE message_participants
    ADD COLUMN IF NOT EXISTS last_delivered_at TIMESTAMPTZ NULL;

-- 2. Idempotent sends: a client-generated id makes retries safe (offline queue,
--    reconnects, double-taps all collapse to one server message).
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS client_msg_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS unq_messages_client_id
    ON messages (conversation_id, sender_user_id, client_msg_id)
    WHERE client_msg_id IS NOT NULL;

-- 3. Presence: when each user was last active (drives Online / Last seen).
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ NULL;

-- 4. Lightweight typing signal (auto-expires; no history kept).
CREATE TABLE IF NOT EXISTS message_typing (
    conversation_id UUID NOT NULL REFERENCES message_conversations(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
);

-- ============================================================================
-- Indexes for fast status/receipt/presence lookups
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_participants_conv ON message_participants (conversation_id);
CREATE INDEX IF NOT EXISTS idx_typing_conv ON message_typing (conversation_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at);
