-- Skip teacher/room collision checks when only period times change on timetable_slots.
-- PUT /timetable/periods syncs start_time/end_time across slots without changing assignments.

CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.teacher_id IS NOT DISTINCT FROM OLD.teacher_id
           AND NEW.period_number IS NOT DISTINCT FROM OLD.period_number
           AND NEW.day_of_week IS NOT DISTINCT FROM OLD.day_of_week
           AND NEW.room_no IS NOT DISTINCT FROM OLD.room_no
           AND NEW.academic_year_id IS NOT DISTINCT FROM OLD.academic_year_id
           AND NEW.class_section_id IS NOT DISTINCT FROM OLD.class_section_id
           AND NEW.subject_id IS NOT DISTINCT FROM OLD.subject_id
        THEN
            RETURN NEW;
        END IF;
    END IF;

    IF NEW.teacher_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.teacher_id = NEW.teacher_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
        ) THEN
            NULL;
        END IF;

        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND period_number = NEW.period_number
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND NOT (
                class_section_id = NEW.class_section_id
                AND academic_year_id = NEW.academic_year_id
                AND day_of_week = NEW.day_of_week
                AND period_number = NEW.period_number
              )
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period % on %', NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND period_number = NEW.period_number
              AND day_of_week = NEW.day_of_week
              AND academic_year_id = NEW.academic_year_id
              AND deleted_at IS NULL
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND NOT (
                class_section_id = NEW.class_section_id
                AND academic_year_id = NEW.academic_year_id
                AND day_of_week = NEW.day_of_week
                AND period_number = NEW.period_number
              )
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period % on %', NEW.room_no, NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
