-- ===========================================================================
-- SchoolIMS — Payment Gateway Lifecycle State
-- NexSyrus Pvt. Ltd. | Phase 2
-- Additive only. Idempotent. Safe on production.
-- PREREQUISITE: 001_pg_foundation.sql must be applied first (adds schools.pg_enabled).
-- ===========================================================================
--
-- Decision (recorded during Phase 2 STEP 0):
--   pg_state is the SOURCE OF TRUTH for the per-school PG lifecycle state machine.
--   pg_enabled remains the runtime KILL SWITCH that every PG route checks.
--   They are complementary, not redundant:
--     - pg_enabled  : "is this school allowed to use PG at all?" (NexSyrus flips via SuperAdmin)
--     - pg_state    : "where in the lifecycle is this school?" (advanced by app on credential save)
--   The 4-state machine that previously existed only as prose in 001's comments is now a
--   real, CHECK-constrained column.
-- ===========================================================================

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS pg_state TEXT NOT NULL DEFAULT 'NOT_CONFIGURED'
    CHECK (pg_state IN (
      'NOT_CONFIGURED',
      'SANDBOX_ACTIVE',
      'PRODUCTION_ACTIVE',
      'SUSPENDED'
    ));

COMMENT ON COLUMN schools.pg_state IS
  'PG lifecycle state machine (source of truth). NOT_CONFIGURED -> SANDBOX_ACTIVE -> PRODUCTION_ACTIVE. SUSPENDED blocks credential changes until NexSyrus restores. Transitions are enforced in services/cashfreeService.js (nextPgState). pg_enabled is the separate runtime kill switch.';


-- ===========================================================================
-- VERIFICATION (run manually after applying)
-- ===========================================================================
-- V1: column exists with correct default
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'schools' AND column_name = 'pg_state';
-- EXPECTED: 1 row, data_type = text, default 'NOT_CONFIGURED'

-- V2: every existing school starts NOT_CONFIGURED
-- SELECT pg_state, COUNT(*) FROM schools GROUP BY pg_state;
-- EXPECTED: NOT_CONFIGURED = 8 (all schools)


-- ===========================================================================
-- ROLLBACK (only if needed — column is additive with a safe default, no data written)
-- ===========================================================================
-- ALTER TABLE schools DROP COLUMN IF EXISTS pg_state;
