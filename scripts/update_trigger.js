import sql from '../db.js';

async function updateTrigger() {

  const triggerSql = `
CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    -- 1. Subject Assignment Check
    IF NEW.teacher_id IS NOT NULL THEN
        -- Check permissions (skipped if we want to allow ad-hoc for now, but schema has it)
        -- We'll keep schema logic:
        IF NOT EXISTS (
            SELECT 1 FROM class_subjects cs
            WHERE cs.class_section_id = NEW.class_section_id
              AND cs.teacher_id = NEW.teacher_id
              AND cs.subject_id = NEW.subject_id
              AND cs.deleted_at IS NULL
        ) THEN
             -- RAISE EXCEPTION 'Teacher is not assigned to this Class/Subject combination';
             -- For now, we will leave it commented as per user request to start simple, 
             -- OR better: Uncomment it if we are sure data is clean. 
             -- "Refactor... completely data-driven" implies strictness.
             -- But if I enable it, I risk breaking existing flows if class_subjects is empty.
             -- User said "No separate mappings". 
             -- Schema has class_subjects.
             -- I will keep it commented for now to avoid blocking the user if they haven't set up class_subjects properly yet.
             -- Actually, the schema had it enabled.
             -- I should enable it.
             RAISE EXCEPTION 'Teacher is not assigned to this Class/Subject combination';

        END IF;

        -- 2. Teacher Collision Check (Same day, same period)
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE teacher_id = NEW.teacher_id
              AND day_of_week = NEW.day_of_week
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_teacher_collision;

        IF v_teacher_collision THEN
            RAISE EXCEPTION 'Teacher Collision: Teacher is already booked for period % on %', NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    -- 3. Room Collision Check
    IF NEW.room_no IS NOT NULL AND NEW.room_no <> '' THEN
        SELECT EXISTS (
            SELECT 1 FROM timetable_slots
            WHERE room_no = NEW.room_no
              AND day_of_week = NEW.day_of_week
              AND period_number = NEW.period_number
              AND academic_year_id = NEW.academic_year_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
        ) INTO v_room_collision;

        IF v_room_collision THEN
            RAISE EXCEPTION 'Room Collision: Room % is already occupied during period % on %', NEW.room_no, NEW.period_number, NEW.day_of_week;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
    `;

  try {
    await sql.unsafe(triggerSql);

  } catch (err) {

  } finally {
    process.exit();
  }
}

updateTrigger();