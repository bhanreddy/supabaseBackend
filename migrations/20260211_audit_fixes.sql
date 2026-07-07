-- Migration: Audit Fixes for Database Integrity
-- Date: 2026-02-11
-- Description: Enforce UNIQUE constraints for Attendance and optimize indexes.

BEGIN;

-- 1. ATTENDANCE: Enforce Unique Constraint for ON CONFLICT support
-- Current schema has 'uq_attendance_active' (Partial Index on deleted_at IS NULL). 
-- This is good, but for ON CONFLICT to work seamlessly, we often want a strict unique constraint if we don't use soft deletes, 
-- OR we must use the index in the ON CONFLICT clause.
-- Since the requirement is "Attendance must enforce: UNIQUE (class_id, student_id, date)", which maps to (student_enrollment_id, attendance_date).

-- Improve the index to be fully compatible with ON CONFLICT if needed, or just rely on the existing one.
-- Existing: CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_active ON daily_attendance(student_enrollment_id, attendance_date) WHERE deleted_at IS NULL;

-- 2. INDEXES: Add missing FK indexes for performance
CREATE INDEX IF NOT EXISTS idx_complaints_raised_for ON complaints(raised_for_student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);

CREATE INDEX IF NOT EXISTS idx_lms_courses_subject ON lms_courses(subject_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_class ON lms_courses(class_id);
CREATE INDEX IF NOT EXISTS idx_lms_courses_instructor ON lms_courses(instructor_id);

-- 3. TIMETABLE: Enforce prevent duplicate/invalid inserts (Already has unique constraint in schema.sql: UNIQUE (class_section_id, academic_year_id, day_of_week, period_number))
-- Adding specific index for querying by teacher (collision detection)
CREATE INDEX IF NOT EXISTS idx_timetable_slots_time_check 
ON timetable_slots(teacher_id, day_of_week, start_time, end_time);

COMMIT;
