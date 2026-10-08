-- Attendance "today" follows the school timezone. current_date uses the
-- database clock, so a mark made after midnight in Asia/Kolkata was rejected
-- while UTC was still on the previous day.

CREATE OR REPLACE FUNCTION public.attendance_date_is_not_future(p_school_id integer, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT p_date <= (
    timezone(
      COALESCE(
        (
          SELECT tz.name
          FROM school_settings setting
          JOIN pg_timezone_names tz ON tz.name = setting.value
          WHERE setting.school_id = p_school_id
            AND setting.key = 'school_timezone'
          LIMIT 1
        ),
        'Asia/Kolkata'
      ),
      now()
    )
  )::date;
$$;

CREATE OR REPLACE FUNCTION public.fn_check_no_future_attendance()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
    school_today date;
BEGIN
    school_today := (
        timezone(
            COALESCE(
                (
                    SELECT tz.name
                    FROM school_settings setting
                    JOIN pg_timezone_names tz ON tz.name = setting.value
                    WHERE setting.school_id = NEW.school_id
                      AND setting.key = 'school_timezone'
                    LIMIT 1
                ),
                'Asia/Kolkata'
            ),
            now()
        )
    )::date;
    IF NEW.attendance_date > school_today THEN
        RAISE EXCEPTION 'Cannot mark attendance for future date: % (Today is %)', NEW.attendance_date, school_today;
    END IF;
    RETURN NEW;
END;
$$;

-- Existing rows are historical and already passed the old current_date check.
-- Skip a full-table scan (this table is large) and enforce the school-local
-- rule on every new or updated attendance row.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_attendance_date_past'
      AND pg_get_constraintdef(oid) ILIKE '%attendance_date_is_not_future%'
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE daily_attendance DROP CONSTRAINT IF EXISTS chk_attendance_date_past;
  ALTER TABLE daily_attendance
    ADD CONSTRAINT chk_attendance_date_past
    CHECK (attendance_date_is_not_future(school_id, attendance_date))
    NOT VALID;
END $$;
