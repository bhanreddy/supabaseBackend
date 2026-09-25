-- Monthly attendance totals for schools that import a third-party biometric summary.
-- Manual totals replace SchoolIMS daily attendance for that payroll only.
-- Holiday count is shared by the school payroll month and does not rewrite calendar dates.

CREATE TABLE IF NOT EXISTS teacher_payroll_attendance_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  staff_payroll_id UUID NOT NULL UNIQUE REFERENCES staff_payroll(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  input_mode TEXT NOT NULL CHECK (input_mode IN ('SYSTEM_DAILY', 'MANUAL_SUMMARY')),
  origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL', 'THIRD_PARTY')),
  cl_days NUMERIC(6, 1) NOT NULL DEFAULT 0 CHECK (cl_days >= 0 AND (cl_days * 2) = trunc(cl_days * 2)),
  non_cl_days NUMERIC(6, 1) NOT NULL DEFAULT 0 CHECK (non_cl_days >= 0 AND (non_cl_days * 2) = trunc(non_cl_days * 2)),
  late_count INTEGER NOT NULL DEFAULT 0 CHECK (late_count >= 0),
  provider_name TEXT,
  supporting_reference TEXT,
  reason TEXT,
  verified BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    input_mode = 'SYSTEM_DAILY'
    OR (
      verified
      AND reason IS NOT NULL
      AND length(btrim(reason)) > 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_teacher_payroll_attendance_summaries_staff
  ON teacher_payroll_attendance_summaries (school_id, staff_id);

CREATE TABLE IF NOT EXISTS school_payroll_period_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  payroll_year INTEGER NOT NULL,
  payroll_month INTEGER NOT NULL CHECK (payroll_month BETWEEN 1 AND 12),
  holiday_count INTEGER NOT NULL CHECK (holiday_count >= 0),
  source TEXT NOT NULL DEFAULT 'MANUAL',
  provider_name TEXT,
  supporting_reference TEXT,
  reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (school_id, payroll_year, payroll_month)
);

ALTER TABLE teacher_payroll_attendance_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_payroll_period_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS teacher_payroll_service_all ON teacher_payroll_attendance_summaries;
CREATE POLICY teacher_payroll_service_all ON teacher_payroll_attendance_summaries
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS teacher_payroll_service_all ON school_payroll_period_overrides;
CREATE POLICY teacher_payroll_service_all ON school_payroll_period_overrides
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON teacher_payroll_attendance_summaries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON school_payroll_period_overrides FROM PUBLIC, anon, authenticated;
GRANT ALL ON teacher_payroll_attendance_summaries TO service_role;
GRANT ALL ON school_payroll_period_overrides TO service_role;
