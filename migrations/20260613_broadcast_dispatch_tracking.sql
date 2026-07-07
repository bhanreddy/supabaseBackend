-- Broadcast dispatch tracking: class-targeted sends, per-recipient audit, retry lineage.

-- Extend notification_batches for broadcast metadata and retry lineage.
ALTER TABLE notification_batches
  ADD COLUMN IF NOT EXISTS channel_type TEXT,
  ADD COLUMN IF NOT EXISTS target_class_ids UUID[],
  ADD COLUMN IF NOT EXISTS tokens_targeted INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS no_token_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_batch_id UUID REFERENCES notification_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_notification_batches_parent_batch_id
  ON notification_batches(parent_batch_id);

-- Allow BROADCAST batch type (class-targeted / all-school admin dispatches).
ALTER TABLE notification_batches DROP CONSTRAINT IF EXISTS chk_notification_batches_type;
ALTER TABLE notification_batches ADD CONSTRAINT chk_notification_batches_type
  CHECK (type IN (
    'FEES', 'GENERAL', 'EXAM', 'EMERGENCY', 'ATTENDANCE', 'CUSTOM',
    'DIARY', 'RESULTS', 'NOTICE', 'TEST_TRIGGER', 'BROADCAST'
  )) NOT VALID;

-- Per-recipient dispatch audit (single source of truth for failures + retry).
CREATE TABLE IF NOT EXISTS notification_dispatch_recipients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  batch_id    UUID NOT NULL REFERENCES notification_batches(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token   TEXT,
  status      TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'no_token', 'skipped')),
  error_code  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_recipients_school_id
  ON notification_dispatch_recipients(school_id);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_recipients_batch_id
  ON notification_dispatch_recipients(batch_id);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_recipients_batch_status
  ON notification_dispatch_recipients(batch_id, status);

CREATE INDEX IF NOT EXISTS idx_notification_dispatch_recipients_user_id
  ON notification_dispatch_recipients(user_id);

ALTER TABLE notification_dispatch_recipients ENABLE ROW LEVEL SECURITY;
