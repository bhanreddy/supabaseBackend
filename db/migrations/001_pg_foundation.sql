-- ===========================================================================
-- SchoolIMS — Payment Gateway Foundation Migration
-- NexSyrus Pvt. Ltd. | Phase 1 of 10
-- Safe to run on production: additive only, all defaults safe, idempotent
-- Run between 11 PM – 5 AM IST. Expected runtime: < 2 minutes.
-- ===========================================================================


-- ===========================================================================
-- SECTION 1: ADD COLUMNS TO schools TABLE
-- schools.id = INTEGER (SERIAL). These 5 columns are the master control
-- switches for the entire PG feature. All default to OFF for all 8 existing
-- schools. NexSyrus flips them per school via SuperAdmin console in Phase 6.
-- ===========================================================================

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS pg_enabled            BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pg_live_mode          BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pg_provider           TEXT     NOT NULL DEFAULT 'cashfree'
    CHECK (pg_provider IN ('cashfree', 'razorpay')),
  ADD COLUMN IF NOT EXISTS convenience_fee_paise INTEGER  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payouts_enabled       BOOLEAN  NOT NULL DEFAULT false;

COMMENT ON COLUMN schools.pg_enabled IS
  'Master PG kill switch per school. false = all PG routes return 403. NexSyrus sets this via SuperAdmin.';
COMMENT ON COLUMN schools.pg_live_mode IS
  'false = sandbox Cashfree/Razorpay keys, true = production keys. Never flip without sandbox test first.';
COMMENT ON COLUMN schools.pg_provider IS
  'Active PG provider for this school. Switchable per school via SuperAdmin without app redeploy.';
COMMENT ON COLUMN schools.convenience_fee_paise IS
  'NexSyrus platform fee added to parent payment. Stored in paise (integer). 0 = no convenience fee. ₹5 = 500.';
COMMENT ON COLUMN schools.payouts_enabled IS
  'Enables Cashfree Payouts (staff salary disbursal). Separate from PG. Requires separate Cashfree Payouts KYC.';


-- ===========================================================================
-- SECTION 2: school_pg_credentials TABLE
-- Stores encrypted Cashfree and Razorpay credentials per school.
-- school_id is INTEGER to match schools.id (SERIAL).
-- GRANT: service_role ONLY. authenticated gets NO access.
-- The RESTRICTIVE RLS policy is a second layer — GRANT is the first.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS school_pg_credentials (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                INTEGER     NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  pg_provider              TEXT        NOT NULL
                             CHECK (pg_provider IN ('cashfree', 'razorpay')),

  -- Cashfree PG credentials (AES-256-GCM encrypted at app layer before INSERT)
  -- Each field has its own IV + auth tag. Compromising one field does not help
  -- decrypt the other. NULL until credentials are entered via SuperAdmin.
  cf_app_id_encrypted      TEXT,
  cf_secret_encrypted      TEXT,
  cf_app_id_iv             TEXT,
  cf_app_id_tag            TEXT,
  cf_secret_iv             TEXT,
  cf_secret_tag            TEXT,
  cf_environment           TEXT
    CHECK (cf_environment IN ('sandbox', 'production')),
  nexsyrus_vendor_id       TEXT,

  -- Razorpay PG credentials (AES-256-GCM encrypted at app layer before INSERT)
  rp_key_id_encrypted      TEXT,
  rp_key_secret_encrypted  TEXT,
  rp_key_id_iv             TEXT,
  rp_key_id_tag            TEXT,
  rp_key_secret_iv         TEXT,
  rp_key_secret_tag        TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (school_id, pg_provider)
);

COMMENT ON TABLE school_pg_credentials IS
  'Per-school PG credentials. AES-256-GCM encrypted. service_role access only. One row per school per provider.';
COMMENT ON COLUMN school_pg_credentials.nexsyrus_vendor_id IS
  'Cashfree Easy Split vendor ID for NexSyrus. Used to route convenience_fee_paise to NexSyrus at settlement.';

-- GRANT: credentials tables — service_role ONLY, no authenticated access
GRANT ALL ON school_pg_credentials TO service_role;

-- RLS: RESTRICTIVE — second layer after GRANT denial
ALTER TABLE school_pg_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only" ON school_pg_credentials;
CREATE POLICY "service_role_only" ON school_pg_credentials
  AS RESTRICTIVE
  FOR ALL
  USING (auth.role() = 'service_role');


-- ===========================================================================
-- SECTION 3: fee_payments TABLE
-- Tracks every online payment attempt from parent app.
-- Separate from existing fee_transactions (cash/offline).
-- On webhook SUCCESS, backend also writes to fee_transactions to keep the
-- existing fee ledger consistent. Both tables coexist.
-- school_id is INTEGER (matches schools.id).
-- student_id is UUID (matches students.id).
-- fee_head_ids stores student_fees.id values (UUID[]) — the per-student fee
-- assignments being paid, not abstract fee_types.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS fee_payments (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            INTEGER     NOT NULL REFERENCES schools(id),
  student_id           UUID        NOT NULL REFERENCES students(id),

  fee_head_ids         UUID[]      NOT NULL,

  idempotency_key      TEXT        NOT NULL UNIQUE,

  -- All amounts in paise (integer). Never rupees. Never float.
  -- Display layer divides by 100.
  amount_paise         INTEGER     NOT NULL CHECK (amount_paise > 0),
  convenience_paise    INTEGER     NOT NULL DEFAULT 0,
  total_paise          INTEGER     NOT NULL,

  pg_provider          TEXT        NOT NULL
                         CHECK (pg_provider IN ('cashfree', 'razorpay')),
  pg_order_id          TEXT,
  payment_session_id   TEXT,

  -- Cashfree-specific (NULL for Razorpay rows)
  cf_order_id          TEXT,
  cf_payment_id        TEXT,

  -- Razorpay-specific (NULL for Cashfree rows)
  rp_order_id          TEXT,
  rp_payment_id        TEXT,

  -- Status machine
  -- PENDING      → order created, parent has not completed payment yet
  -- SUCCESS      → webhook confirmed, money received by school
  -- FAILED       → bank declined / insufficient funds
  -- CANCELLED    → system or school cancelled
  -- USER_DROPPED → parent closed checkout modal without paying
  status               TEXT        NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN (
                           'PENDING', 'SUCCESS', 'FAILED',
                           'CANCELLED', 'USER_DROPPED'
                         )),

  webhook_received_at  TIMESTAMPTZ,
  webhook_payload      JSONB,

  payment_mode         TEXT,
  initiated_by         UUID        REFERENCES users(id),
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN fee_payments.fee_head_ids IS
  'Array of student_fees.id (UUID) values being paid in this transaction. NOT fee_types.id.';
COMMENT ON COLUMN fee_payments.idempotency_key IS
  'Format: FP-{schoolId}-{studentId}-{timestamp}. Prevents duplicate records on network retry or double-tap.';
COMMENT ON COLUMN fee_payments.total_paise IS
  'amount_paise + convenience_paise. What the parent actually pays.';
COMMENT ON COLUMN fee_payments.payment_session_id IS
  'Cashfree: payment_session_id from order create response. Razorpay: order_id used as session reference.';

CREATE INDEX IF NOT EXISTS idx_fee_payments_school
  ON fee_payments (school_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_student
  ON fee_payments (student_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_pg_order
  ON fee_payments (pg_order_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_cf_order
  ON fee_payments (cf_order_id);
CREATE INDEX IF NOT EXISTS idx_fee_payments_school_status
  ON fee_payments (school_id, status);

GRANT SELECT, INSERT, UPDATE ON fee_payments TO authenticated;
GRANT ALL ON fee_payments TO service_role;

ALTER TABLE fee_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "school_isolation_fee_payments" ON fee_payments;
CREATE POLICY "school_isolation_fee_payments" ON fee_payments
  FOR ALL
  USING (
    school_id = auth_school_id()
    OR auth.role() = 'service_role'
  );


-- ===========================================================================
-- SECTION 4: ADD UPI COLUMNS TO staff TABLE
-- Used for Cashfree Payouts (staff salary disbursal — Phase 5 + 8).
-- staff.id = UUID, staff.school_id = INTEGER.
-- All columns additive with safe defaults. 80 existing staff rows unaffected.
-- upi_verified defaults false: entering a UPI ID does not auto-verify it.
-- Backend must call Cashfree VPA validation API before setting upi_verified=true.
-- If upi_id changes, backend MUST reset upi_verified=false immediately.
-- ===========================================================================

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS upi_id             TEXT,
  ADD COLUMN IF NOT EXISTS upi_verified       BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS upi_verified_name  TEXT,
  ADD COLUMN IF NOT EXISTS upi_verified_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bank_account_no    TEXT,
  ADD COLUMN IF NOT EXISTS bank_ifsc          TEXT;

COMMENT ON COLUMN staff.upi_id IS
  'UPI Virtual Payment Address (VPA). Must be verified via Cashfree VPA API before any disbursal.';
COMMENT ON COLUMN staff.upi_verified IS
  'true only after Cashfree VPA validation confirms the UPI ID is live and linked to a bank account.';
COMMENT ON COLUMN staff.upi_verified_name IS
  'Account holder name returned by Cashfree VPA validation. Accountant must visually confirm this matches staff name.';
COMMENT ON COLUMN staff.upi_verified_at IS
  'Timestamp of last successful UPI verification. Re-verify if upi_id changes.';


-- ===========================================================================
-- SECTION 5: school_payout_credentials TABLE
-- Cashfree PAYOUTS = completely separate product from Cashfree PG.
-- Different API, different base URL, different KYC, different credentials.
-- NEVER store Payouts credentials in school_pg_credentials.
-- school_id is INTEGER (matches schools.id).
-- GRANT: service_role ONLY. Same rationale as school_pg_credentials.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS school_payout_credentials (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id                   INTEGER     NOT NULL UNIQUE REFERENCES schools(id)
                                ON DELETE CASCADE,

  payouts_app_id_encrypted    TEXT        NOT NULL,
  payouts_secret_encrypted    TEXT        NOT NULL,
  payouts_app_id_iv           TEXT        NOT NULL,
  payouts_app_id_tag          TEXT        NOT NULL,
  payouts_secret_iv           TEXT        NOT NULL,
  payouts_secret_tag          TEXT        NOT NULL,

  cf_payout_environment       TEXT        NOT NULL DEFAULT 'sandbox'
    CHECK (cf_payout_environment IN ('sandbox', 'production')),

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE school_payout_credentials IS
  'Cashfree Payouts credentials. NOT the same as Cashfree PG credentials. Separate API, separate KYC.';

GRANT ALL ON school_payout_credentials TO service_role;

ALTER TABLE school_payout_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_only_payouts" ON school_payout_credentials;
CREATE POLICY "service_role_only_payouts" ON school_payout_credentials
  AS RESTRICTIVE
  FOR ALL
  USING (auth.role() = 'service_role');


-- ===========================================================================
-- SECTION 6: payroll_runs TABLE
-- New approval + disbursal orchestration layer.
-- Does NOT replace staff_payroll (existing, 107 rows, has triggers — untouched).
-- payroll_runs orchestrates WHO approved WHAT and WHEN money was disbursed.
-- Phase 5 backend will derive net_amount_paise from staff_payroll records.
-- school_id is INTEGER. created_by, approved_by are UUID (references users).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id            INTEGER     NOT NULL REFERENCES schools(id),
  run_month            INTEGER     NOT NULL CHECK (run_month BETWEEN 1 AND 12),
  run_year             INTEGER     NOT NULL CHECK (run_year >= 2024),
  total_amount_paise   INTEGER     NOT NULL DEFAULT 0,

  -- Status machine (linear — no skipping):
  -- DRAFT            → accounts creates, not yet submitted for approval
  -- PENDING_APPROVAL → accounts submits, admin notified via FCM
  -- APPROVED         → admin approves (must be different user than creator)
  -- DISBURSING       → Cashfree Payouts batch transfer in flight
  -- COMPLETED        → all transfers finished (individual disbursals may be FAILED)
  -- FAILED           → catastrophic failure before any transfer (balance check, auth)
  -- REJECTED         → admin rejected with reason
  status               TEXT        NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN (
      'DRAFT', 'PENDING_APPROVAL', 'APPROVED',
      'DISBURSING', 'COMPLETED', 'FAILED', 'REJECTED'
    )),

  -- Two-person control: backend MUST enforce created_by != approved_by.
  -- This is not just a UI rule. The approve route checks this server-side.
  created_by           UUID        NOT NULL REFERENCES users(id),
  approved_by          UUID        REFERENCES users(id),
  approved_at          TIMESTAMPTZ,
  rejected_reason      TEXT,
  disbursed_at         TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One payroll run per school per month. Prevents accidental duplicate disbursals.
  UNIQUE (school_id, run_month, run_year)
);

COMMENT ON TABLE payroll_runs IS
  'Approval + disbursal orchestration for staff salary. Separate from staff_payroll (existing). Does not modify staff_payroll.';
COMMENT ON COLUMN payroll_runs.created_by IS
  'Accounts role user who created this payroll run. Cannot also be the approver (two-person control).';
COMMENT ON COLUMN payroll_runs.approved_by IS
  'Admin role user who approved. Backend enforces approved_by != created_by. NULL until approved.';

GRANT SELECT, INSERT, UPDATE ON payroll_runs TO authenticated;
GRANT ALL ON payroll_runs TO service_role;

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "school_isolation_payroll_runs" ON payroll_runs;
CREATE POLICY "school_isolation_payroll_runs" ON payroll_runs
  FOR ALL
  USING (
    school_id = auth_school_id()
    OR auth.role() = 'service_role'
  );


-- ===========================================================================
-- SECTION 7: payroll_disbursals TABLE
-- One row per staff member per payroll run.
-- Stores a SNAPSHOT of staff data at disbursal time — not a live join.
-- Reason: staff may leave or change UPI ID after disbursal. Historical records
-- must be immutable. Never join to staff for disbursal history display.
-- school_id is INTEGER. payroll_run_id, staff_id are UUID.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS payroll_disbursals (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id         UUID        NOT NULL REFERENCES payroll_runs(id),
  school_id              INTEGER     NOT NULL REFERENCES schools(id),
  staff_id               UUID        NOT NULL REFERENCES staff(id),

  -- Snapshot fields — immutable after INSERT
  staff_name_snapshot    TEXT        NOT NULL,
  upi_id_snapshot        TEXT        NOT NULL,
  upi_name_snapshot      TEXT,

  -- Amounts in paise
  gross_amount_paise     INTEGER     NOT NULL CHECK (gross_amount_paise > 0),
  deductions_paise       INTEGER     NOT NULL DEFAULT 0
                           CHECK (deductions_paise >= 0),
  net_amount_paise       INTEGER     NOT NULL CHECK (net_amount_paise > 0),

  -- Cashfree Payouts tracking
  -- idempotency_key format: PAY-{runId}-{disbursalId}
  -- Safe to retry: calling Cashfree Payouts again with same idempotency_key
  -- returns the original transfer result without double-paying.
  idempotency_key        TEXT        NOT NULL UNIQUE,
  cf_transfer_id         TEXT,
  cf_reference_id        TEXT,

  status                 TEXT        NOT NULL DEFAULT 'PENDING'
    CHECK (status IN (
      'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED'
    )),
  failure_reason         TEXT,
  disbursed_at           TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE payroll_disbursals IS
  'Per-staff disbursal records. Snapshot-based — do not join to staff for history display.';
COMMENT ON COLUMN payroll_disbursals.idempotency_key IS
  'Format: PAY-{runId}-{disbursalId}. Cashfree Payouts idempotency key. Safe to retry failed transfers.';
COMMENT ON COLUMN payroll_disbursals.staff_name_snapshot IS
  'Staff name at time of disbursal. Immutable. Do not update even if staff record changes later.';

CREATE INDEX IF NOT EXISTS idx_payroll_disbursals_run
  ON payroll_disbursals (payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_disbursals_school
  ON payroll_disbursals (school_id);
CREATE INDEX IF NOT EXISTS idx_payroll_disbursals_staff
  ON payroll_disbursals (staff_id);

GRANT SELECT, INSERT, UPDATE ON payroll_disbursals TO authenticated;
GRANT ALL ON payroll_disbursals TO service_role;

ALTER TABLE payroll_disbursals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "school_isolation_payroll_disbursals" ON payroll_disbursals;
CREATE POLICY "school_isolation_payroll_disbursals" ON payroll_disbursals
  FOR ALL
  USING (
    school_id = auth_school_id()
    OR auth.role() = 'service_role'
  );


-- ===========================================================================
-- VERIFICATION QUERIES
-- Run these manually in Supabase SQL editor AFTER the migration.
-- ALL must return the expected result before Phase 2 begins.
-- ===========================================================================

-- V1: PG columns on schools (expect 5 rows)
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'schools'
--   AND column_name IN (
--     'pg_enabled','pg_live_mode','pg_provider',
--     'convenience_fee_paise','payouts_enabled'
--   );
-- EXPECTED: 5 rows

-- V2: Zero schools with pg_enabled = true (CRITICAL)
-- SELECT COUNT(*) AS schools_pg_enabled FROM schools WHERE pg_enabled = true;
-- EXPECTED: 0  — if > 0, STOP immediately

-- V3: Zero schools with payouts_enabled = true
-- SELECT COUNT(*) AS schools_payouts_enabled FROM schools WHERE payouts_enabled = true;
-- EXPECTED: 0

-- V4: All 5 new tables exist
-- SELECT table_name
-- FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'school_pg_credentials', 'fee_payments',
--     'school_payout_credentials', 'payroll_runs', 'payroll_disbursals'
--   )
-- ORDER BY table_name;
-- EXPECTED: 5 rows

-- V5: UPI columns on staff (expect 6 rows including bank columns)
-- SELECT column_name
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'staff'
--   AND column_name IN (
--     'upi_id','upi_verified','upi_verified_name',
--     'upi_verified_at','bank_account_no','bank_ifsc'
--   );
-- EXPECTED: 6 rows

-- V6: RLS enabled on all 5 new tables
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'school_pg_credentials','school_payout_credentials',
--     'fee_payments','payroll_runs','payroll_disbursals'
--   );
-- EXPECTED: rowsecurity = true for ALL 5 rows

-- V7: school_id FK type is INTEGER on all new tables
-- SELECT
--   tc.table_name,
--   kcu.column_name,
--   c.data_type
-- FROM information_schema.table_constraints tc
-- JOIN information_schema.key_column_usage kcu
--   ON tc.constraint_name = kcu.constraint_name
-- JOIN information_schema.columns c
--   ON c.table_name = kcu.table_name
--   AND c.column_name = kcu.column_name
-- WHERE tc.constraint_type = 'FOREIGN KEY'
--   AND kcu.column_name = 'school_id'
--   AND tc.table_name IN (
--     'school_pg_credentials','fee_payments',
--     'school_payout_credentials','payroll_runs','payroll_disbursals'
--   );
-- EXPECTED: data_type = 'integer' for ALL rows (NOT uuid)

-- V8: Existing production data intact
-- SELECT
--   (SELECT COUNT(*) FROM schools)         AS schools,
--   (SELECT COUNT(*) FROM students)        AS students,
--   (SELECT COUNT(*) FROM staff)           AS staff,
--   (SELECT COUNT(*) FROM staff_payroll)   AS staff_payroll,
--   (SELECT COUNT(*) FROM fee_transactions) AS fee_transactions;
-- EXPECTED: schools=8, students=2428, staff=80, staff_payroll=107, fee_transactions=34
-- If ANY count differs from discovery report: STOP and investigate

-- V9: New tables are all empty (nothing was pre-populated)
-- SELECT
--   (SELECT COUNT(*) FROM school_pg_credentials)    AS pg_creds,
--   (SELECT COUNT(*) FROM fee_payments)             AS fee_payments,
--   (SELECT COUNT(*) FROM school_payout_credentials) AS payout_creds,
--   (SELECT COUNT(*) FROM payroll_runs)             AS payroll_runs,
--   (SELECT COUNT(*) FROM payroll_disbursals)       AS payroll_disbursals;
-- EXPECTED: all 0

-- V10: GRANTs correct — credentials tables NOT granted to authenticated
-- SELECT grantee, table_name, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'public'
--   AND table_name IN ('school_pg_credentials','school_payout_credentials')
--   AND grantee = 'authenticated';
-- EXPECTED: 0 rows — authenticated has no access to credentials tables


-- ===========================================================================
-- ROLLBACK (run only if something goes wrong — NOT part of the migration)
-- Zero existing data is affected — all new tables are empty, all new columns
-- have safe defaults that were never written to.
-- ===========================================================================
-- ALTER TABLE schools
--   DROP COLUMN IF EXISTS pg_enabled,
--   DROP COLUMN IF EXISTS pg_live_mode,
--   DROP COLUMN IF EXISTS pg_provider,
--   DROP COLUMN IF EXISTS convenience_fee_paise,
--   DROP COLUMN IF EXISTS payouts_enabled;
--
-- ALTER TABLE staff
--   DROP COLUMN IF EXISTS upi_id,
--   DROP COLUMN IF EXISTS upi_verified,
--   DROP COLUMN IF EXISTS upi_verified_name,
--   DROP COLUMN IF EXISTS upi_verified_at,
--   DROP COLUMN IF EXISTS bank_account_no,
--   DROP COLUMN IF EXISTS bank_ifsc;
--
-- DROP TABLE IF EXISTS payroll_disbursals;
-- DROP TABLE IF EXISTS payroll_runs;
-- DROP TABLE IF EXISTS school_payout_credentials;
-- DROP TABLE IF EXISTS fee_payments;
-- DROP TABLE IF EXISTS school_pg_credentials;
