-- Teacher salary calculation, effective-dated policy, and immutable payslip snapshots.
-- Existing staff, attendance, leave, holiday, and staff_payroll rows stay the source of truth.

ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS relieving_date DATE,
  ADD COLUMN IF NOT EXISTS employment_type TEXT NOT NULL DEFAULT 'FULL_TIME',
  ADD COLUMN IF NOT EXISTS probation_end_date DATE,
  ADD COLUMN IF NOT EXISTS department_name TEXT,
  ADD COLUMN IF NOT EXISTS campus_id UUID,
  ADD COLUMN IF NOT EXISTS weekly_off_weekdays SMALLINT[],
  ADD COLUMN IF NOT EXISTS bank_account_last4 VARCHAR(4),
  ADD COLUMN IF NOT EXISTS payment_reference_masked TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_staff_employment_type') THEN
    ALTER TABLE staff
      ADD CONSTRAINT chk_staff_employment_type
      CHECK (employment_type IN ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'PERMANENT', 'PROBATION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_staff_relieving_date') THEN
    ALTER TABLE staff
      ADD CONSTRAINT chk_staff_relieving_date
      CHECK (relieving_date IS NULL OR relieving_date >= joining_date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_staff_bank_last4') THEN
    ALTER TABLE staff
      ADD CONSTRAINT chk_staff_bank_last4
      CHECK (bank_account_last4 IS NULL OR bank_account_last4 ~ '^[0-9]{4}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_campus_id_fkey') THEN
    ALTER TABLE staff
      ADD CONSTRAINT staff_campus_id_fkey
      FOREIGN KEY (campus_id) REFERENCES campus_attendance_policies(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE staff_attendance
  ADD COLUMN IF NOT EXISTS is_on_duty BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS late_converted_to_half_day BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE staff_payroll
  ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS calculation_engine TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS calculation_version TEXT,
  ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'ORIGINAL',
  ADD COLUMN IF NOT EXISTS run_sequence INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS requires_review BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_reason TEXT,
  ADD COLUMN IF NOT EXISTS prepared_by UUID,
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validated_by UUID,
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by UUID,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_by UUID,
  ADD COLUMN IF NOT EXISTS reversal_of_id UUID;

UPDATE staff_payroll
SET workflow_status = 'PAID'
WHERE status = 'paid' AND workflow_status = 'DRAFT';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_staff_payroll_workflow') THEN
    ALTER TABLE staff_payroll
      ADD CONSTRAINT chk_staff_payroll_workflow
      CHECK (workflow_status IN ('DRAFT', 'VALIDATED', 'APPROVED', 'LOCKED', 'PAID'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_staff_payroll_run_kind') THEN
    ALTER TABLE staff_payroll
      ADD CONSTRAINT chk_staff_payroll_run_kind
      CHECK (run_kind IN ('ORIGINAL', 'SUPPLEMENTARY', 'REVERSAL'));
  END IF;
END $$;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'public'
    AND rel.relname = 'staff_payroll'
    AND con.contype = 'u'
    AND pg_get_constraintdef(con.oid) ILIKE '%payroll_month%'
    AND pg_get_constraintdef(con.oid) NOT ILIKE '%run_kind%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.staff_payroll DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_payroll_run
  ON staff_payroll (school_id, staff_id, payroll_month, payroll_year, run_kind, run_sequence);

CREATE TABLE IF NOT EXISTS school_payroll_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  effective_to DATE,
  config JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_school_payroll_policies_school
  ON school_payroll_policies (school_id, effective_from);

CREATE TABLE IF NOT EXISTS staff_locality_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN ('LOCAL', 'NON_LOCAL')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_staff_locality_classifications_lookup
  ON staff_locality_classifications (school_id, staff_id, effective_from);

CREATE TABLE IF NOT EXISTS staff_salary_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  monthly_salary NUMERIC(14, 4) NOT NULL CHECK (monthly_salary >= 0),
  effective_from DATE NOT NULL,
  effective_to DATE,
  reason TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS idx_staff_salary_revisions_lookup
  ON staff_salary_revisions (school_id, staff_id, effective_from);

INSERT INTO staff_salary_revisions (school_id, staff_id, monthly_salary, effective_from, reason)
SELECT s.school_id, s.id, s.salary, s.joining_date, 'Backfilled from the staff salary on record'
FROM staff s
WHERE s.deleted_at IS NULL
  AND s.salary IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM staff_salary_revisions r WHERE r.staff_id = s.id
  );

CREATE TABLE IF NOT EXISTS staff_payroll_cl_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  payroll_month INTEGER NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  payroll_year INTEGER NOT NULL,
  eligible BOOLEAN NOT NULL,
  reason TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, staff_id, payroll_month, payroll_year)
);

CREATE TABLE IF NOT EXISTS teacher_payroll_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_payroll_id UUID NOT NULL REFERENCES staff_payroll(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('EARNING', 'DEDUCTION')),
  component_name TEXT NOT NULL,
  amount NUMERIC(14, 4) NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  supporting_reference TEXT,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by UUID REFERENCES users(id) ON DELETE RESTRICT,
  approved_at TIMESTAMPTZ,
  CHECK (
    (approved_by IS NULL AND approved_at IS NULL)
    OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_teacher_payroll_adjustments_payroll
  ON teacher_payroll_adjustments (staff_payroll_id);

CREATE TABLE IF NOT EXISTS teacher_payroll_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_payroll_id UUID NOT NULL UNIQUE REFERENCES staff_payroll(id) ON DELETE CASCADE,
  calculation_version TEXT NOT NULL,
  publish_at TEXT NOT NULL CHECK (publish_at IN ('APPROVED', 'LOCKED')),
  input JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  result JSONB NOT NULL,
  frozen BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teacher_payroll_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_payroll_id UUID,
  staff_id UUID,
  actor_id UUID,
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_teacher_payroll_audit_payroll
  ON teacher_payroll_audit_logs (school_id, staff_payroll_id, created_at);

INSERT INTO school_payroll_policies (school_id, effective_from, config)
SELECT s.id, DATE '2000-01-01', jsonb_build_object(
  'localPermittedLates', 3,
  'nonLocalPermittedLates', 5,
  'deductionPerExcessLateDays', '0.5',
  'lateDeductionMode', 'PER_EXCESS',
  'monthlyClEntitlementDays', '1',
  'holidayThresholdForDisablingCl', 8,
  'unusedClBonusDays', '1',
  'salaryBasis', 'CALENDAR_DAYS',
  'currency', 'INR',
  'roundingMode', 'HALF_UP',
  'roundingScale', 2,
  'weeklyOffWeekdays', jsonb_build_array(0),
  'countWeeklyOffAsHoliday', false,
  'includeOptionalHolidays', false,
  'clRequiresFullMonth', true,
  'probationClEligible', false,
  'clEligibleEmploymentTypes', jsonb_build_array('FULL_TIME', 'PERMANENT'),
  'paidLeaveTypes', jsonb_build_array('casual', 'sick', 'earned', 'maternity', 'paternity'),
  'excessClTreatment', 'unpaid',
  'payslipPublishAt', 'LOCKED',
  'requireAdjustmentApproval', true
)
FROM schools s
WHERE NOT EXISTS (
  SELECT 1 FROM school_payroll_policies p WHERE p.school_id = s.id
);

CREATE OR REPLACE FUNCTION prevent_immutable_staff_payroll()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  IF OLD.workflow_status IN ('APPROVED', 'LOCKED', 'PAID') THEN
    IF OLD.base_salary IS DISTINCT FROM NEW.base_salary
       OR OLD.bonus IS DISTINCT FROM NEW.bonus
       OR OLD.deductions IS DISTINCT FROM NEW.deductions
       OR OLD.net_salary IS DISTINCT FROM NEW.net_salary
       OR OLD.salary_adjustment IS DISTINCT FROM NEW.salary_adjustment
       OR OLD.staff_id IS DISTINCT FROM NEW.staff_id
       OR OLD.payroll_month IS DISTINCT FROM NEW.payroll_month
       OR OLD.payroll_year IS DISTINCT FROM NEW.payroll_year
       OR OLD.run_kind IS DISTINCT FROM NEW.run_kind
       OR OLD.run_sequence IS DISTINCT FROM NEW.run_sequence
    THEN
      RAISE EXCEPTION 'Payroll amounts are immutable after approval';
    END IF;
    IF OLD.workflow_status = 'PAID' THEN
      RAISE EXCEPTION 'Paid payroll is immutable';
    ELSIF OLD.workflow_status = 'LOCKED' AND NEW.workflow_status IS DISTINCT FROM 'PAID' AND NEW.workflow_status IS DISTINCT FROM 'LOCKED' THEN
      RAISE EXCEPTION 'Locked payroll can only be marked paid';
    ELSIF OLD.workflow_status = 'APPROVED' AND NEW.workflow_status IS DISTINCT FROM 'LOCKED' AND NEW.workflow_status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'Approved payroll can only be locked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_immutable_staff_payroll ON staff_payroll;
CREATE TRIGGER trg_prevent_immutable_staff_payroll
BEFORE UPDATE ON staff_payroll
FOR EACH ROW EXECUTE FUNCTION prevent_immutable_staff_payroll();

CREATE OR REPLACE FUNCTION prevent_frozen_payroll_snapshot_rewrite()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.frozen THEN
      RAISE EXCEPTION 'Frozen payroll snapshot cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.frozen AND (
    NEW.input IS DISTINCT FROM OLD.input
    OR NEW.result IS DISTINCT FROM OLD.result
    OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
  ) THEN
    RAISE EXCEPTION 'Frozen payroll snapshot cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_frozen_payroll_snapshot ON teacher_payroll_snapshots;
CREATE TRIGGER trg_prevent_frozen_payroll_snapshot
BEFORE UPDATE OR DELETE ON teacher_payroll_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_frozen_payroll_snapshot_rewrite();

CREATE OR REPLACE FUNCTION recalculate_staff_payroll(
    p_staff_id UUID,
    p_month INTEGER,
    p_year INTEGER
)
RETURNS VOID
SET search_path = public
AS $$
DECLARE
    v_base_salary DECIMAL(12,2);
    v_per_day_salary DECIMAL(12,2);
    v_total_deduction_days INTEGER := 0;
    v_deduction_amount DECIMAL(12,2);
    v_start_date DATE;
    v_end_date DATE;
    v_bonus DECIMAL(12,2) := 0;
    v_adjustment DECIMAL(12,2) := 0;
    v_engine TEXT;
    v_workflow TEXT;
    v_status TEXT;
    v_payroll_id UUID;
BEGIN
    SELECT sp.id, sp.calculation_engine, sp.workflow_status, sp.status::text
      INTO v_payroll_id, v_engine, v_workflow, v_status
    FROM staff_payroll sp
    WHERE sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year
      AND sp.run_kind = 'ORIGINAL'
      AND sp.run_sequence = 0;

    IF v_engine = 'teacher-salary-v1' THEN
      IF v_workflow IN ('DRAFT', 'VALIDATED') THEN
        UPDATE staff_payroll
        SET requires_review = true,
            workflow_status = 'DRAFT',
            review_reason = 'Attendance or leave changed after this draft was calculated. Recalculate before approval.',
            validated_by = NULL,
            validated_at = NULL,
            updated_at = now()
        WHERE id = v_payroll_id;
      END IF;
      RETURN;
    END IF;

    IF v_status = 'paid' OR v_workflow IN ('APPROVED', 'LOCKED', 'PAID') THEN
      RETURN;
    END IF;

    SELECT salary INTO v_base_salary FROM staff WHERE id = p_staff_id;
    IF v_base_salary IS NULL THEN v_base_salary := 0; END IF;
    v_per_day_salary := v_base_salary / 30.0;
    v_start_date := make_date(p_year, p_month, 1);
    v_end_date := (v_start_date + interval '1 month' - interval '1 day')::DATE;

    WITH deductible_dates AS (
        SELECT attendance_date AS d_date
        FROM staff_attendance
        WHERE staff_id = p_staff_id
          AND attendance_date BETWEEN v_start_date AND v_end_date
          AND status = 'absent'
          AND deleted_at IS NULL
        UNION
        SELECT generate_series(
            GREATEST(start_date, v_start_date),
            LEAST(end_date, v_end_date),
            interval '1 day'
        )::DATE AS d_date
        FROM leave_applications
        WHERE applicant_id = (SELECT id FROM users WHERE person_id = (SELECT person_id FROM staff WHERE id = p_staff_id))
          AND status = 'rejected'
          AND leave_type != 'unpaid'
          AND end_date >= v_start_date
          AND start_date <= v_end_date
    )
    SELECT COUNT(DISTINCT d_date) INTO v_total_deduction_days FROM deductible_dates;

    v_deduction_amount := v_total_deduction_days * v_per_day_salary;

    SELECT COALESCE(sp.bonus, 0), COALESCE(sp.salary_adjustment, 0)
      INTO v_bonus, v_adjustment
    FROM staff_payroll sp
    WHERE sp.school_id = (SELECT school_id FROM staff WHERE id = p_staff_id)
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year
      AND sp.run_kind = 'ORIGINAL'
      AND sp.run_sequence = 0;

    UPDATE staff_payroll sp
    SET base_salary = v_base_salary,
        deductions = v_deduction_amount,
        net_salary = GREATEST(0, v_base_salary + v_bonus + v_adjustment - v_deduction_amount),
        updated_at = now()
    WHERE sp.school_id = (SELECT school_id FROM staff WHERE id = p_staff_id)
      AND sp.staff_id = p_staff_id
      AND sp.payroll_month = p_month
      AND sp.payroll_year = p_year
      AND sp.run_kind = 'ORIGINAL'
      AND sp.run_sequence = 0
      AND sp.calculation_engine IS DISTINCT FROM 'teacher-salary-v1'
      AND sp.status <> 'paid';

    IF NOT FOUND AND v_payroll_id IS NULL THEN
      INSERT INTO staff_payroll (
        school_id, staff_id, payroll_month, payroll_year,
        base_salary, bonus, salary_adjustment, deductions, net_salary, status
      )
      VALUES (
        (SELECT school_id FROM staff WHERE id = p_staff_id),
        p_staff_id, p_month, p_year,
        v_base_salary, 0, 0, v_deduction_amount,
        GREATEST(0, v_base_salary - v_deduction_amount),
        'pending'
      );
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
  ('payroll.prepare', 'Prepare Payroll'),
  ('payroll.approve', 'Approve Payroll'),
  ('payroll.pay', 'Mark Payroll Paid'),
  ('payroll.audit', 'Audit Payroll')
) AS v(code, name)
WHERE NOT EXISTS (
  SELECT 1 FROM permissions p WHERE p.school_id = s.id AND p.code = v.code
);

INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT r.school_id, r.id, p.id
FROM roles r
JOIN permissions p ON p.school_id = r.school_id AND p.code IN (
  'payroll.prepare', 'payroll.approve', 'payroll.pay', 'payroll.audit'
)
WHERE r.code IN ('admin', 'principal')
  AND r.deleted_at IS NULL
  AND p.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id AND rp.school_id = r.school_id
  );

ALTER TABLE school_payroll_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_locality_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_salary_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_payroll_cl_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_payroll_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_payroll_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_payroll_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teacher_payroll_service_all ON school_payroll_policies;
CREATE POLICY teacher_payroll_service_all ON school_payroll_policies
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS teacher_payroll_service_all ON staff_locality_classifications;
CREATE POLICY teacher_payroll_service_all ON staff_locality_classifications
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS teacher_payroll_service_all ON staff_salary_revisions;
CREATE POLICY teacher_payroll_service_all ON staff_salary_revisions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS teacher_payroll_service_all ON staff_payroll_cl_overrides;
CREATE POLICY teacher_payroll_service_all ON staff_payroll_cl_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS teacher_payroll_service_all ON teacher_payroll_adjustments;
CREATE POLICY teacher_payroll_service_all ON teacher_payroll_adjustments
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS teacher_payroll_service_all ON teacher_payroll_snapshots;
CREATE POLICY teacher_payroll_service_all ON teacher_payroll_snapshots
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS teacher_payroll_service_all ON teacher_payroll_audit_logs;
CREATE POLICY teacher_payroll_service_all ON teacher_payroll_audit_logs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON school_payroll_policies FROM PUBLIC, anon, authenticated;
REVOKE ALL ON staff_locality_classifications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON staff_salary_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON staff_payroll_cl_overrides FROM PUBLIC, anon, authenticated;
REVOKE ALL ON teacher_payroll_adjustments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON teacher_payroll_snapshots FROM PUBLIC, anon, authenticated;
REVOKE ALL ON teacher_payroll_audit_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON school_payroll_policies TO service_role;
GRANT ALL ON staff_locality_classifications TO service_role;
GRANT ALL ON staff_salary_revisions TO service_role;
GRANT ALL ON staff_payroll_cl_overrides TO service_role;
GRANT ALL ON teacher_payroll_adjustments TO service_role;
GRANT ALL ON teacher_payroll_snapshots TO service_role;
GRANT ALL ON teacher_payroll_audit_logs TO service_role;
