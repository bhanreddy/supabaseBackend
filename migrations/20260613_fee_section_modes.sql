-- ════════════════════════════════════════════════════════════
-- Migration: Per-class / per-section fee structure modes
-- Date: 2026-06-13
-- ════════════════════════════════════════════════════════════
-- Adds:
--   1. schools.fee_mode ('per_class' default — existing schools unchanged)
--   2. fee_structures.section_id (nullable FK → sections)
--   3. Partial unique indexes for class-level vs section-level rows
--   4. Section-aware auto-assign triggers
--
-- BACKWARD COMPATIBILITY:
--   - fee_mode DEFAULT 'per_class'; all existing rows keep section_id NULL
--   - per_class mode continues to use section_id IS NULL rows only
--   - Switching back to per_class hides section rows; they are not deleted
--   - Mid-year: existing student_fees keep their fee_structure_id; new
--     assignments follow fee_mode + section match (see trigger comments)
--
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. School-level fee mode flag (precedent: schools.timetable_mode)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS fee_mode TEXT NOT NULL DEFAULT 'per_class';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'schools' AND constraint_name = 'chk_schools_fee_mode'
  ) THEN
    ALTER TABLE schools
      ADD CONSTRAINT chk_schools_fee_mode
      CHECK (fee_mode IN ('per_class', 'per_section'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2. Section scoping on fee_structures
-- ─────────────────────────────────────────────────────────────
ALTER TABLE fee_structures
  ADD COLUMN IF NOT EXISTS section_id UUID REFERENCES sections(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_fee_structures_section_id
  ON fee_structures(section_id)
  WHERE section_id IS NOT NULL;

-- Existing rows represent class-level fees (section_id stays NULL).

-- Replace single unique index with mode-aware partial indexes.
DROP INDEX IF EXISTS idx_fee_structures_active;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_structures_class_level_active
  ON fee_structures (school_id, academic_year_id, class_id, fee_type_id)
  WHERE deleted_at IS NULL AND section_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fee_structures_section_level_active
  ON fee_structures (school_id, academic_year_id, class_id, section_id, fee_type_id)
  WHERE deleted_at IS NULL AND section_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 3. Section-aware fee assignment triggers
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION auto_assign_fees_on_structure_creation()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
    IF NEW.section_id IS NULL THEN
        -- Class-level structure: assign to all active enrollments in the class.
        INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.school_id, se.student_id, NEW.id, NEW.amount, 0, 'pending', NEW.due_date
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = NEW.class_id
          AND se.academic_year_id = NEW.academic_year_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf
            WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id
          );
    ELSE
        -- Section-level structure: assign only to students in that section.
        INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
        SELECT NEW.school_id, se.student_id, NEW.id, NEW.amount, 0, 'pending', NEW.due_date
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        WHERE cs.class_id = NEW.class_id
          AND cs.section_id = NEW.section_id
          AND se.academic_year_id = NEW.academic_year_id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf
            WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id
          );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auto_assign_fees_on_enrollment()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_class_id UUID;
    v_section_id UUID;
    v_fee_mode TEXT;
BEGIN
    IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') THEN
        SELECT cs.class_id, cs.section_id
          INTO v_class_id, v_section_id
        FROM class_sections cs
        WHERE cs.id = NEW.class_section_id;

        SELECT s.fee_mode INTO v_fee_mode FROM schools s WHERE s.id = NEW.school_id;

        IF v_fee_mode = 'per_section' THEN
            -- Per-section mode: prefer section-specific rows; fall back to class-level
            -- when no per-section row exists for that fee_type (mid-year / partial seed).
            INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
            SELECT NEW.school_id, NEW.student_id, fs.id, fs.amount, 0, 'pending', fs.due_date
            FROM fee_structures fs
            WHERE fs.school_id = NEW.school_id
              AND fs.class_id = v_class_id
              AND fs.academic_year_id = NEW.academic_year_id
              AND fs.deleted_at IS NULL
              AND (
                fs.section_id = v_section_id
                OR (
                  fs.section_id IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM fee_structures fs2
                    WHERE fs2.school_id = fs.school_id
                      AND fs2.academic_year_id = fs.academic_year_id
                      AND fs2.class_id = fs.class_id
                      AND fs2.fee_type_id = fs.fee_type_id
                      AND fs2.section_id = v_section_id
                      AND fs2.deleted_at IS NULL
                  )
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sf
                WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id
              );
        ELSE
            -- Per-class mode: class-level structures only (section_id IS NULL).
            INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
            SELECT NEW.school_id, NEW.student_id, fs.id, fs.amount, 0, 'pending', fs.due_date
            FROM fee_structures fs
            WHERE fs.school_id = NEW.school_id
              AND fs.class_id = v_class_id
              AND fs.academic_year_id = NEW.academic_year_id
              AND fs.section_id IS NULL
              AND fs.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sf
                WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id
              );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- VERIFICATION (run manually before/after applying migration)
-- ════════════════════════════════════════════════════════════
--
-- BEFORE:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'schools' AND column_name = 'fee_mode';
--   SELECT COUNT(*) FROM fee_structures WHERE deleted_at IS NULL;
--
-- AFTER:
--   SELECT id, name, fee_mode FROM schools ORDER BY id;
--   SELECT COUNT(*) FILTER (WHERE section_id IS NULL) AS class_level,
--          COUNT(*) FILTER (WHERE section_id IS NOT NULL) AS section_level
--   FROM fee_structures WHERE deleted_at IS NULL;
--   SELECT school_id, academic_year_id, class_id, section_id, fee_type_id, COUNT(*)
--   FROM fee_structures WHERE deleted_at IS NULL
--   GROUP BY 1,2,3,4,5 HAVING COUNT(*) > 1;
