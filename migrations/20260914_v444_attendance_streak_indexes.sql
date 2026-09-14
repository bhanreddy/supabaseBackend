-- Migration: 20260914_v444_attendance_streak_indexes.sql
-- Purpose: Optimize reverse-chronological attendance lookups for consecutive absence streak calculation.
-- Ensures high-performance queries filtering by school_id and student_enrollment_id,
-- ordering by attendance_date DESC, and skipping soft-deleted rows.

CREATE INDEX IF NOT EXISTS idx_daily_attendance_streak_lookup
ON public.daily_attendance (school_id, student_enrollment_id, attendance_date DESC)
WHERE deleted_at IS NULL;

COMMENT ON INDEX idx_daily_attendance_streak_lookup IS
'Accelerates consecutive absence streak lookbacks across multi-tenant class rosters.';
