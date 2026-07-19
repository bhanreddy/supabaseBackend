-- Treat a single attended session as a full present day when the other session
-- was never marked. This supports schools that only take morning attendance.
--
-- Day-level rules:
--   present/late + unmarked            -> present
--   present/late + present/late        -> present
--   present/late + explicitly absent   -> half_day
--   absent + absent/unmarked           -> absent
--
-- The rule is symmetric for incomplete data: an attended afternoon session
-- with an unmarked morning session is also present. HALF_DAY therefore means
-- that both sessions were explicitly marked and exactly one was attended.

CREATE OR REPLACE FUNCTION compute_attendance_day_status()
RETURNS TRIGGER AS $$
DECLARE
    v_attended INTEGER := 0;  -- sessions marked present/late
    v_marked   INTEGER := 0;  -- sessions explicitly marked with any status
BEGIN
    -- Preserve legacy/manual writes that only set the overall status.
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

    IF v_attended = 0 THEN
        NEW.status := 'absent';
    ELSIF v_marked = 2 AND v_attended = 1 THEN
        NEW.status := 'half_day';
    ELSE
        NEW.status := 'present';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Correct rows that the previous trigger classified as half-day solely because
-- only one attended session had been recorded. Explicit present/absent splits
-- remain half-day.
--
-- Historical rows can belong to an enrollment that is no longer active. Skip
-- the enrollment/authorization validator for this status-only correction, just
-- as the original session-column backfill did.
ALTER TABLE daily_attendance DISABLE TRIGGER trg_validate_attendance;

UPDATE daily_attendance
SET status = 'present',
    updated_at = NOW()
WHERE deleted_at IS NULL
  AND (
    (morning_status IN ('present', 'late') AND afternoon_status IS NULL)
    OR
    (afternoon_status IN ('present', 'late') AND morning_status IS NULL)
  );

ALTER TABLE daily_attendance ENABLE TRIGGER trg_validate_attendance;
