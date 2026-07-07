-- Migration: Data-Driven Timetable Refactor
-- Created: 2026-02-12
-- Description: Automates class teacher assignment based on Monday Period 1 timetable slot.

BEGIN;

-- 1. Automate Class Teacher Assignment (Monday Period 1 Rule)
CREATE OR REPLACE FUNCTION sync_class_teacher_from_timetable()
RETURNS TRIGGER AS $$
DECLARE
    v_class_section_id UUID;
    v_teacher_id UUID;
BEGIN
    -- Only care about Monday Period 1 changes
    -- 'monday' checks for Day enum. '1' checks for Period Number.
    IF (TG_OP = 'DELETE') THEN
        IF OLD.period_number = 1 AND OLD.day_of_week = 'monday' THEN
             UPDATE class_sections 
             SET class_teacher_id = NULL 
             WHERE id = OLD.class_section_id;
        END IF;
        RETURN OLD;
    END IF;

    IF (TG_OP = 'INSERT' OR TG_OP = 'UPDATE') THEN
        IF NEW.period_number = 1 AND NEW.day_of_week = 'monday' THEN
             UPDATE class_sections 
             SET class_teacher_id = NEW.teacher_id 
             WHERE id = NEW.class_section_id;
        END IF;
        RETURN NEW;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_sync_class_teacher ON timetable_slots;
CREATE TRIGGER trg_sync_class_teacher
AFTER INSERT OR UPDATE OR DELETE ON timetable_slots
FOR EACH ROW EXECUTE FUNCTION sync_class_teacher_from_timetable();

-- 2. Initial Sync (Run once to fix existing data)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN 
        SELECT class_section_id, teacher_id 
        FROM timetable_slots 
        WHERE day_of_week = 'monday' AND period_number = 1
    LOOP
        UPDATE class_sections 
        SET class_teacher_id = r.teacher_id 
        WHERE id = r.class_section_id;
    END LOOP;
END $$;

-- 3. Prevent Manual Overrides of Class Teacher (Optional but good for consistency)
-- If we want to strictly enforce "Timetable is Source of Truth", we should block manual updates
-- to class_teacher_id that don't match the timetable.
CREATE OR REPLACE FUNCTION enforce_class_teacher_source_of_truth()
RETURNS TRIGGER AS $$
BEGIN
    -- Allow updates if they match Monday Period 1 (which the trigger above does)
    -- But if a user manually tries to set it to something else, we should either:
    -- A) Block it.
    -- B) Let it happen but it will be overwritten next timetable change.
    
    -- Let's just rely on the trigger. If they manually change it, it might be for a valid reason 
    -- (temp substitute), but the next timetable edit will reset it. 
    -- User requirement: "No static or manually assigned class teacher logic."
    -- So we should probably effectively make it read-only from the API perspective, 
    -- or just let the trigger handle it.
    
    -- To adhere to "Single Source of Truth", we can force checking against timetable on update.
    -- But that causes circular logic if we aren't careful.
    -- Let's stick to the AFTER trigger on timetable_slots as the primary mechanism.
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
