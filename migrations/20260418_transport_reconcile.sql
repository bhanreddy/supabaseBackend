-- Legacy trip reconciliation: backfill trip_date for rows missing it (run after Phase 1 transport DDL).
BEGIN;

UPDATE trips
SET trip_date = COALESCE((started_at AT TIME ZONE 'UTC')::date, (created_at AT TIME ZONE 'UTC')::date)
WHERE trip_date IS NULL;

-- Optional one-time normalization (uncomment if product approves — clients should use mapTripUiStatus):
-- UPDATE trips SET status = 'in_progress' WHERE status = 'active' AND ended_at IS NULL;

COMMIT;
