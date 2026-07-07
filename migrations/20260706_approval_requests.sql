-- ============================================================================
-- RBAC Epic Phase 3 — Generic approval queue (fee underpayment first consumer)
-- Idempotent; safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  type VARCHAR(64) NOT NULL,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  payload JSONB NOT NULL,
  reason TEXT,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_approval_requests_status
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_school_status
  ON approval_requests (school_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending_type
  ON approval_requests (school_id, type)
  WHERE status = 'PENDING';

COMMIT;
