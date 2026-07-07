-- Twice-daily student attendance.
--
-- Schools mark attendance twice: once in the morning (first period) and once in
-- the afternoon (first period after lunch). Each session counts as a half day,
-- and half + half = a full day.
--
-- We keep ONE row per (student_enrollment_id, attendance_date) so every existing
-- report/query keeps working, and add two per-session columns. The legacy
-- `status` column is turned into a DERIVED "overall day status" that is kept in
-- sync by a trigger:
--   both sessions attended     -> 'present'   (full day)
--   exactly one attended       -> 'half_day'
--   none attended (>=1 marked) -> 'absent'
-- where "attended" means the session status is 'present' or 'late'.

ALTER TABLE daily_attendance
  ADD COLUMN IF NOT EXISTS morning_status   attendance_status_enum,
  ADD COLUMN IF NOT EXISTS afternoon_status attendance_status_enum;

-- Backfill existing rows. Historically attendance was marked once per day, so a
-- legacy mark represents the WHOLE day: mirror it into both sessions so the
-- overall status is unchanged (present->full day, absent->absent, late->late,
-- half_day->present morning + absent afternoon).
--
-- The validation trigger is skipped here: it re-checks enrollment windows and
-- some historical rows fall outside them, but we are only populating the new
-- session columns, not creating/altering marks. The compute-status trigger is
-- created AFTER this backfill so it does not run against these rows (which would
-- otherwise demote single-session data).
ALTER TABLE daily_attendance DISABLE TRIGGER trg_validate_attendance;

UPDATE daily_attendance
  SET morning_status   = CASE WHEN status = 'half_day' THEN 'present' ELSE status END,
      afternoon_status = CASE WHEN status = 'half_day' THEN 'absent'  ELSE status END
  WHERE morning_status IS NULL
    AND afternoon_status IS NULL;

ALTER TABLE daily_attendance ENABLE TRIGGER trg_validate_attendance;

-- Compute the overall day status from the two session columns.
CREATE OR REPLACE FUNCTION compute_attendance_day_status()
RETURNS TRIGGER AS $$
DECLARE
    v_attended INTEGER := 0;  -- sessions where student was present/late
    v_marked   INTEGER := 0;  -- sessions that have been marked at all
BEGIN
    -- When neither session column is provided, this is a legacy/manual write
    -- that sets `status` directly. Leave it untouched.
    IF NEW.morning_status IS NULL AND NEW.afternoon_status IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.morning_status IS NOT NULL THEN
        v_marked := v_marked + 1;
        IF NEW.morning_status IN ('present', 'late') THEN
            v_attended := v_attended + 1;
        END IF;
    END IF;

    IF NEW.afternoon_status IS NOT NULL THEN
        v_marked := v_marked + 1;
        IF NEW.afternoon_status IN ('present', 'late') THEN
            v_attended := v_attended + 1;
        END IF;
    END IF;

    IF v_attended >= 2 THEN
        NEW.status := 'present';
    ELSIF v_attended = 1 THEN
        NEW.status := 'half_day';
    ELSE
        NEW.status := 'absent';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Runs before trg_validate_attendance (alphabetical order) so `status` is
-- consistent by the time validation/authorization runs.
DROP TRIGGER IF EXISTS trg_attendance_compute_status ON daily_attendance;
CREATE TRIGGER trg_attendance_compute_status
BEFORE INSERT OR UPDATE ON daily_attendance
FOR EACH ROW EXECUTE FUNCTION compute_attendance_day_status();
