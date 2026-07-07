-- =============================================================================
-- Audit: RLS for student role — notices, student_fees, attendance, results,
--         timetable_slots, enrollments
--
-- Repository note: no live pg_policies export is checked into this repo.
-- "ASSUMED CURRENT" blocks below describe common mis-configurations to replace.
-- Before apply, compare with:
--   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
--   FROM pg_policies WHERE tablename IN (...);
--
-- Name mapping (this codebase / Express SQL):
--   enrollments          -> student_enrollments
--   attendance_records   -> daily_attendance (no table named attendance_records found)
--   results (exam marks) -> marks (no table named results found; add VIEW if you need it)
--
-- Link model: students.auth_user_id = auth.users.id (added below IF NOT EXISTS).
-- If you already use another column (e.g. profiles.id = auth.uid()), replace
-- student_id_for_session() accordingly — still no service role required.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0) Stable student id for the authenticated session (InitPlan-friendly)
--     CORRECTED vs repeated inline subqueries: single SQL function, STABLE.
--     FLAG on naive policies: correlated subquery per row on marks/attendance.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.student_id_for_session()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.id
  FROM public.students s
  WHERE s.auth_user_id = auth.uid()
    AND s.deleted_at IS NULL
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.student_id_for_session() IS
  'Returns students.id for auth.uid(). SECURITY DEFINER avoids requiring a separate students SELECT RLS policy for subqueries in other policies; it does not use the Supabase service-role key.';

REVOKE ALL ON FUNCTION public.student_id_for_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_id_for_session() TO authenticated;

-- -----------------------------------------------------------------------------
-- 0b) Optional: link auth user to student row (safe IF NOT EXISTS)
-- -----------------------------------------------------------------------------
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users (id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_auth_user_id_unique
  ON public.students (auth_user_id)
  WHERE auth_user_id IS NOT NULL AND deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 1) INDEXES (IF NOT EXISTS) — align predicates used in CORRECTED policies
-- -----------------------------------------------------------------------------

-- notices: tenant + audience + publish ordering (see existing migration partial)
CREATE INDEX IF NOT EXISTS idx_notices_school_audience_publish
  ON public.notices (school_id, audience, publish_at DESC);

CREATE INDEX IF NOT EXISTS idx_notices_school_target_class
  ON public.notices (school_id, target_class_id)
  WHERE target_class_id IS NOT NULL;

-- student_fees
CREATE INDEX IF NOT EXISTS idx_student_fees_student_school_due
  ON public.student_fees (school_id, student_id, due_date DESC)
  WHERE deleted_at IS NULL;

-- daily_attendance (attendance_records in product language)
CREATE INDEX IF NOT EXISTS idx_daily_attendance_enrollment_date
  ON public.daily_attendance (student_enrollment_id, attendance_date DESC)
  WHERE deleted_at IS NULL;

-- marks ("results")
CREATE INDEX IF NOT EXISTS idx_marks_student_enrollment
  ON public.marks (student_enrollment_id);

-- timetable_slots
CREATE INDEX IF NOT EXISTS idx_timetable_slots_school_class_section
  ON public.timetable_slots (school_id, class_section_id);

CREATE INDEX IF NOT EXISTS idx_timetable_slots_class_section_dow
  ON public.timetable_slots (class_section_id, day_of_week);

-- student_enrollments ("enrollments")
CREATE INDEX IF NOT EXISTS idx_student_enrollments_student_status
  ON public.student_enrollments (student_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_student_enrollments_student_class
  ON public.student_enrollments (student_id, class_section_id)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2) TABLE: notices
-- -----------------------------------------------------------------------------
-- ASSUMED CURRENT (anti-pattern — tighten if this matches your DB):
--   CREATE POLICY notices_read_all ON public.notices
--     FOR SELECT TO authenticated USING (publish_at <= now());
-- FLAG: (1) No tenant/student scope — any authenticated user reads all rows.
--       (2) Filter publish_at without (school_id, audience) index can seq scan.

ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notices_read_all ON public.notices;
DROP POLICY IF EXISTS notices_student_select ON public.notices;
DROP POLICY IF EXISTS notices_select_student ON public.notices;

CREATE POLICY notices_select_student
  ON public.notices
  FOR SELECT
  TO authenticated
  USING (
    publish_at <= now()
    AND (expires_at IS NULL OR expires_at > now())
    AND school_id = (SELECT s.school_id FROM public.students s WHERE s.id = public.student_id_for_session() LIMIT 1)
    AND (audience IN ('all', 'students'))
    AND (
      target_class_id IS NULL
      OR target_class_id IN (
        SELECT se.class_section_id
        FROM public.student_enrollments se
        WHERE se.student_id = public.student_id_for_session()
          AND se.status = 'active'
          AND se.deleted_at IS NULL
      )
    )
  );
-- CORRECTED: scoped by school_id + audience + optional class from enrollments.
-- FLAG mitigated: scalar subquery on students for school_id is InitPlan; IN list
-- uses idx_student_enrollments_student_status / student_class.

-- -----------------------------------------------------------------------------
-- 3) TABLE: student_fees
-- -----------------------------------------------------------------------------
-- ASSUMED CURRENT (anti-pattern):
--   CREATE POLICY student_fees_own ON public.student_fees FOR SELECT TO authenticated
--     USING (student_id = auth.uid());
-- FLAG: auth.uid() is auth user UUID, not students.id — wrong join semantics.

ALTER TABLE public.student_fees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS student_fees_own ON public.student_fees;
DROP POLICY IF EXISTS student_fees_student_select ON public.student_fees;

CREATE POLICY student_fees_select_own
  ON public.student_fees
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND student_id = public.student_id_for_session()
    AND school_id = (SELECT s.school_id FROM public.students s WHERE s.id = public.student_id_for_session() LIMIT 1)
  );
-- CORRECTED: direct equality on indexed student_id + school guard.
-- No per-row join; student_id_for_session() evaluated once per statement (STABLE).

-- -----------------------------------------------------------------------------
-- 4) TABLE: daily_attendance (requested name: attendance_records)
-- -----------------------------------------------------------------------------
-- ASSUMED CURRENT (anti-pattern):
--   CREATE POLICY attendance_read ON public.daily_attendance FOR SELECT TO authenticated
--     USING (student_enrollment_id IN (SELECT id FROM student_enrollments));
-- FLAG: Uncorrelated IN without student_id predicate — exposes all enrollments' rows.

ALTER TABLE public.daily_attendance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_read ON public.daily_attendance;
DROP POLICY IF EXISTS daily_attendance_student_select ON public.daily_attendance;

CREATE POLICY daily_attendance_select_own
  ON public.daily_attendance
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND student_enrollment_id IN (
      SELECT se.id
      FROM public.student_enrollments se
      WHERE se.student_id = public.student_id_for_session()
        AND se.deleted_at IS NULL
    )
  );
-- CORRECTED: IN list restricted to current student's enrollment ids.
-- Uses idx_daily_attendance_enrollment_date for row filter + enrollment PK/index.

-- -----------------------------------------------------------------------------
-- 5) TABLE: marks (requested name: results)
-- -----------------------------------------------------------------------------
-- ASSUMED CURRENT (anti-pattern):
--   CREATE POLICY marks_select_join ON public.marks FOR SELECT TO authenticated
--     USING (EXISTS (
--       SELECT 1 FROM student_enrollments se
--       JOIN students st ON st.id = se.student_id
--       WHERE se.id = marks.student_enrollment_id AND st.user_id = auth.uid()
--     ));
-- FLAG: EXISTS + JOIN per row — expensive; often wrong column (user_id vs auth).

ALTER TABLE public.marks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marks_select_join ON public.marks;
DROP POLICY IF EXISTS marks_student_select ON public.marks;

CREATE POLICY marks_select_own
  ON public.marks
  FOR SELECT
  TO authenticated
  USING (
    student_enrollment_id IN (
      SELECT se.id
      FROM public.student_enrollments se
      WHERE se.student_id = public.student_id_for_session()
        AND se.deleted_at IS NULL
    )
  );
-- CORRECTED: same enrollment-id set as attendance; uses idx_marks_student_enrollment.

-- -----------------------------------------------------------------------------
-- 6) TABLE: timetable_slots
-- -----------------------------------------------------------------------------
-- ASSUMED CURRENT (anti-pattern):
--   CREATE POLICY timetable_any ON public.timetable_slots FOR SELECT TO authenticated
--     USING (true);
-- FLAG: Leaks all sections' timetables.

ALTER TABLE public.timetable_slots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS timetable_any ON public.timetable_slots;
DROP POLICY IF EXISTS timetable_slots_student_select ON public.timetable_slots;

CREATE POLICY timetable_slots_select_enrolled
  ON public.timetable_slots
  FOR SELECT
  TO authenticated
  USING (
    school_id = (SELECT s.school_id FROM public.students s WHERE s.id = public.student_id_for_session() LIMIT 1)
    AND class_section_id IN (
      SELECT se.class_section_id
      FROM public.student_enrollments se
      WHERE se.student_id = public.student_id_for_session()
        AND se.status = 'active'
        AND se.deleted_at IS NULL
    )
  );
-- CORRECTED: tenant school_id + class_section_id in active enrollments.
-- Consider partial index WHERE deleted_at IS NULL on timetable_slots if you soft-delete slots.

-- -----------------------------------------------------------------------------
-- 7) TABLE: student_enrollments (requested name: enrollments)
-- -----------------------------------------------------------------------------
-- ASSUMED CURRENT (anti-pattern):
--   CREATE POLICY enrollments_by_auth ON public.student_enrollments FOR SELECT TO authenticated
--     USING (student_id = auth.uid());
-- FLAG: Wrong UUID comparison (same as student_fees).

ALTER TABLE public.student_enrollments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enrollments_by_auth ON public.student_enrollments;
DROP POLICY IF EXISTS student_enrollments_student_select ON public.student_enrollments;

CREATE POLICY student_enrollments_select_own
  ON public.student_enrollments
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND student_id = public.student_id_for_session()
    AND school_id = (SELECT s.school_id FROM public.students s WHERE s.id = public.student_id_for_session() LIMIT 1)
  );
-- CORRECTED: student_id equality + school_id alignment; indexed paths above.

COMMIT;

-- =============================================================================
-- Optional follow-up (not executed here):
-- If you maintain a physical table public.attendance_records or public.results,
-- mirror the same enrollment / student predicates and add matching indexes.
-- =============================================================================
