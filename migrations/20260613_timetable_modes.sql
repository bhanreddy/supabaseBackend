-- ════════════════════════════════════════════════════════════
-- Migration: Timetable Scheduling Modes (uniform / per_day)
-- Date: 2026-06-13
-- ════════════════════════════════════════════════════════════
-- Adds:
--   1. schools.timetable_mode flag (default 'uniform' — existing
--      schools keep working unchanged, zero manual intervention).
--   2. periods.is_break flag for the format/period-structure editor
--      (backfilled from legacy break/lunch period names).
--   3. Per-day support on timetable_slots: the active-uniqueness
--      index and the collision trigger are widened to include
--      day_of_week so the same period can differ per weekday.
--
-- BACKWARD COMPATIBILITY:
--   - timetable_mode DEFAULT 'uniform' (precedent: fee adjustment
--     DEFAULT 'waive'). Existing rows are all day_of_week='monday',
--     so widening the unique index keeps every existing row valid.
--   - In uniform mode, content is stored as one template (monday
--     rows) and read back for every weekday — identical to the
--     previous day-agnostic behaviour.
--   - In per_day mode, rows diverge by day_of_week.
--
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- 1. School-level scheduling mode flag
-- ─────────────────────────────────────────────────────────────
ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS timetable_mode TEXT NOT NULL DEFAULT 'uniform';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_schools_timetable_mode'
  ) THEN
    ALTER TABLE schools
      ADD CONSTRAINT chk_schools_timetable_mode
      CHECK (timetable_mode IN ('uniform', 'per_day'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2. Period structure: is_break flag (format editor)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE periods
  ADD COLUMN IF NOT EXISTS is_break BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: classify legacy break/lunch periods by name.
UPDATE periods
SET is_break = TRUE
WHERE is_break = FALSE
  AND (
    name ILIKE '%break%'
    OR name ILIKE '%lunch%'
    OR name ILIKE '%recess%'
    OR name ILIKE '%interval%'
    OR name ILIKE '%assembly%'
  );

-- ─────────────────────────────────────────────────────────────
-- 3. Per-day uniqueness: widen the active-slot unique index to
--    include day_of_week. Existing rows (all 'monday') stay valid.
-- ─────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS uq_timetable_slots_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_timetable_slots_active
  ON timetable_slots (class_section_id, academic_year_id, day_of_week, period_number)
  WHERE deleted_at IS NULL;

-- Fast per-day read path for student/teacher fetches.
CREATE INDEX IF NOT EXISTS idx_timetable_slots_section_day
  ON timetable_slots (class_section_id, academic_year_id, day_of_week)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 4. Collision trigger: scope teacher/room collisions by day_of_week
--    so a teacher booked period 3 Monday no longer falsely collides
--    with period 3 Tuesday in per_day mode.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_timetable_entry()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_teacher_collision BOOLEAN;
    v_room_collision BOOLEAN;
BEGIN
    -- 1. Subject Assignment Check (advisory only; ad-hoc scheduling allowed)
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

        -- 2. Teacher Collision Check (same period, same weekday)
        -- Exclude the slot being upserted: BEFORE INSERT has NEW.id NULL on ON CONFLICT paths.
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

    -- 3. Room Collision Check (same period, same weekday)
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
