-- ═══════════════════════════════════════════════════════════════════════════
-- Transport live tracking (Phase 1+2)
-- Proximity-based "bus approaching" pushes need a per-trip-stop dedupe flag:
-- both the GPS-proximity path and the driver checkpoint path claim this
-- column atomically (UPDATE ... WHERE approach_notified_at IS NULL) so a
-- stop's parents are notified exactly once per trip.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE trip_stop_status ADD COLUMN IF NOT EXISTS approach_notified_at TIMESTAMPTZ;
