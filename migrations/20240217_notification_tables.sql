-- ============================================================\r\n-- DEPRECATED: This migration has been consolidated into schema.sql.\r\n-- Do NOT run this file on new deployments. It is kept for historical reference only.\r\n-- All notification tables (user_devices, notification_config, notification_logs, notification_batches)\r\n-- are now created by schema.sql (Section 19: Notification Infrastructure).\r\n-- ============================================================\r\n\r\n-- Migration: Create Notification Config & Log Tables

-- 1. Notification Configuration
CREATE TABLE IF NOT EXISTS notification_config (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Seed Kill Switch if not exists
INSERT INTO notification_config (key, value)
VALUES ('kill_switch', '{"global": false, "types": {}}')
ON CONFLICT (key) DO NOTHING;

-- 2. Notification Logs
CREATE TABLE IF NOT EXISTS notification_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    notification_type TEXT NOT NULL,
    status TEXT CHECK (status IN ('success', 'failed', 'partial')),
    provider_response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Index for analytics
CREATE INDEX IF NOT EXISTS idx_notification_logs_type_date ON notification_logs(notification_type, created_at DESC);

-- 3. Notification Batches (for fees/general bulk sends)
CREATE TABLE IF NOT EXISTS notification_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id UUID REFERENCES users(id),
    type TEXT NOT NULL,
    filters JSONB DEFAULT '{}',
    status TEXT CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'aborted')) DEFAULT 'pending',
    total_targets INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_batches_status ON notification_batches(status);
