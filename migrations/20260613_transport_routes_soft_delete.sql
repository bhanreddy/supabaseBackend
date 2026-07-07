-- ════════════════════════════════════════════════════════════
-- Migration: transport_routes soft delete (deleted_at)
-- Date: 2026-06-13
-- ════════════════════════════════════════════════════════════
-- DELETE /transport/routes/:id sets deleted_at; column was missing
-- from live DB while transport_stops and buses already use it.
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

ALTER TABLE transport_routes
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transport_routes_active
  ON transport_routes(school_id)
  WHERE deleted_at IS NULL;
