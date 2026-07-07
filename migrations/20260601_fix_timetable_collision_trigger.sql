-- Fix validate_timetable_entry: allow updating an existing slot via INSERT...ON CONFLICT.
-- BEFORE INSERT runs with NEW.id unset, so the old check falsely collided with the same row.
-- Note: run via node/db.js (postgres.js does not support BEGIN/COMMIT in sql.unsafe).

CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    IF NEW.teacher_id IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND NOT (
                class_section_id = NEW.class_section_id
                AND period_number = NEW.period_number
                AND academic_year_id = NEW.academic_year_id
              )
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period %', NEW.period_number;
        END IF;
    END IF;

    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND NOT (
                class_section_id = NEW.class_section_id
                AND period_number = NEW.period_number
                AND academic_year_id = NEW.academic_year_id
              )
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period %', NEW.room_no, NEW.period_number;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
