-- Migration: Audit Hardening
-- Date: 2026-02-11
-- Description: Upgrade constraints based on audit findings.

-- Description: Upgrade constraints based on audit findings.
-- 1. TIMETABLE: Enforce Strict Subject-Teacher Mapping
-- Change NOTICE to EXCEPTION in validate_timetable_entry

CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER AS $$
DECLARE
    v_is_valid BOOLEAN;
BEGIN
    -- Skip check if no teacher assigned (free period)
    IF NEW.teacher_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Check if teacher is assigned to this class (via class_subjects)
    SELECT EXISTS (
        SELECT 1 FROM class_subjects cs
        WHERE cs.class_section_id = NEW.class_section_id
          AND cs.teacher_id = NEW.teacher_id
          AND (NEW.subject_id IS NULL OR cs.subject_id = NEW.subject_id)
    ) INTO v_is_valid;

    IF NOT v_is_valid THEN
        RAISE EXCEPTION 'Constraint Violation: Teacher is not assigned to this class/subject in class_subjects mapping';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. CLASS SUBJECTS: Enforce Uniqueness (already unique index? Let's check/add)
-- schema.sql has: UNIQUE (class_section_id, subject_id)
-- But maybe not for (class_section_id, subject_id, teacher_id)?
-- Actually, a subject in a class usually has ONE teacher.
-- If multiple teachers share a subject, that's complex.
-- Let's stick to the current schema but ensure the index exists.

-- 3. ATTENDANCE: Ensure strict uniqueness for active records
-- (Already covered by uq_attendance_active, but let's ensure it's there)
-- CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_active ... (Idempotent)

-- CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_active ... (Idempotent)
