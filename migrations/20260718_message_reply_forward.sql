-- ============================================================================
-- WhatsApp-style reply and forward metadata.
-- Replies keep a reference to a message in the same conversation.
-- Forwards keep the source id for auditability while exposing only the copied
-- body to recipients in the destination conversation.
-- ============================================================================

ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS reply_to_message_id UUID NULL,
    ADD COLUMN IF NOT EXISTS forwarded_from_message_id UUID NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_reply_to'
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT fk_messages_reply_to
            FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_messages_forwarded_from'
    ) THEN
        ALTER TABLE messages
            ADD CONSTRAINT fk_messages_forwarded_from
            FOREIGN KEY (forwarded_from_message_id) REFERENCES messages(id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to
    ON messages (reply_to_message_id)
    WHERE reply_to_message_id IS NOT NULL;

