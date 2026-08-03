-- ════════════════════════════════════════════════════════════
-- Migration: transport_stops stop_order uniqueness for active rows only
-- Date: 2026-08-03
-- ════════════════════════════════════════════════════════════
-- Soft-deleted stops keep their stop_order, which collided with
-- UNIQUE (school_id, route_id, stop_order) when adding or reordering
-- active stops (PostgreSQL 23505 → "Duplicate Entry").
-- Match other soft-delete tables: uniqueness applies WHERE deleted_at IS NULL.
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

ALTER TABLE transport_stops
  DROP CONSTRAINT IF EXISTS transport_stops_school_id_route_id_stop_order_key;

ALTER TABLE transport_stops
  DROP CONSTRAINT IF EXISTS transport_stops_route_id_stop_order_key;

DROP INDEX IF EXISTS transport_stops_school_id_route_id_stop_order_key;
DROP INDEX IF EXISTS transport_stops_route_id_stop_order_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_stops_route_order_active
  ON transport_stops (school_id, route_id, stop_order)
  WHERE deleted_at IS NULL;
