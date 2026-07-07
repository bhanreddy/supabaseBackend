-- ════════════════════════════════════════════════════════════
-- Migration: Exclusive fee mode — only one structure type per school
-- Date: 2026-06-14
-- ════════════════════════════════════════════════════════════
-- Enforces:
--   per_class  → only fee_structures with section_id IS NULL
--   per_section → only fee_structures with section_id IS NOT NULL
--
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────
-- 1. Reject structures that don't match the school's fee_mode
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_fee_structure_mode()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE v_fee_mode TEXT;
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.fee_mode INTO v_fee_mode FROM schools s WHERE s.id = NEW.school_id;

    IF COALESCE(v_fee_mode, 'per_class') = 'per_class' AND NEW.section_id IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot create section-level fee structure when school fee_mode is per_class';
    END IF;

    IF v_fee_mode = 'per_section' AND NEW.section_id IS NULL THEN
        RAISE EXCEPTION 'Cannot create class-level fee structure when school fee_mode is per_section';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_fee_structure_mode ON fee_structures;
CREATE TRIGGER trg_validate_fee_structure_mode
BEFORE INSERT OR UPDATE ON fee_structures
FOR EACH ROW EXECUTE FUNCTION validate_fee_structure_mode();

-- ─────────────────────────────────────────────────────────────
-- 2. Structure creation: respect fee_mode + prevent duplicate assignments
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_assign_fees_on_structure_creation()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE v_fee_mode TEXT;
BEGIN
    IF NEW.deleted_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.fee_mode INTO v_fee_mode FROM schools s WHERE s.id = NEW.school_id;

    IF COALESCE(v_fee_mode, 'per_class') = 'per_class' AND NEW.section_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF v_fee_mode = 'per_section' AND NEW.section_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.section_id IS NULL THEN
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
            WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id AND sf.deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf2
            JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
            WHERE sf2.student_id = se.student_id
              AND sf2.deleted_at IS NULL
              AND fs2.deleted_at IS NULL
              AND fs2.fee_type_id = NEW.fee_type_id
              AND fs2.academic_year_id = NEW.academic_year_id
              AND fs2.class_id = NEW.class_id
          );
    ELSE
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
            WHERE sf.student_id = se.student_id AND sf.fee_structure_id = NEW.id AND sf.deleted_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM student_fees sf2
            JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
            WHERE sf2.student_id = se.student_id
              AND sf2.deleted_at IS NULL
              AND fs2.deleted_at IS NULL
              AND fs2.fee_type_id = NEW.fee_type_id
              AND fs2.academic_year_id = NEW.academic_year_id
              AND fs2.class_id = NEW.class_id
          );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- 3. Enrollment: per_section uses section structures only (no class fallback)
-- ─────────────────────────────────────────────────────────────
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
            INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
            SELECT NEW.school_id, NEW.student_id, fs.id, fs.amount, 0, 'pending', fs.due_date
            FROM fee_structures fs
            WHERE fs.school_id = NEW.school_id
              AND fs.class_id = v_class_id
              AND fs.academic_year_id = NEW.academic_year_id
              AND fs.section_id = v_section_id
              AND fs.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sf
                WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id AND sf.deleted_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sf2
                JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
                WHERE sf2.student_id = NEW.student_id
                  AND sf2.deleted_at IS NULL
                  AND fs2.deleted_at IS NULL
                  AND fs2.fee_type_id = fs.fee_type_id
                  AND fs2.academic_year_id = fs.academic_year_id
                  AND fs2.class_id = fs.class_id
              );
        ELSE
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
                WHERE sf.student_id = NEW.student_id AND sf.fee_structure_id = fs.id AND sf.deleted_at IS NULL
              )
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sf2
                JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
                WHERE sf2.student_id = NEW.student_id
                  AND sf2.deleted_at IS NULL
                  AND fs2.deleted_at IS NULL
                  AND fs2.fee_type_id = fs.fee_type_id
                  AND fs2.academic_year_id = fs.academic_year_id
                  AND fs2.class_id = fs.class_id
              );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────
-- 4. One-time cleanup: remove wrong-mode structures + duplicate fees
-- ─────────────────────────────────────────────────────────────

-- Soft-delete section-level structures for per_class schools
UPDATE fee_structures fs
SET deleted_at = NOW(), updated_at = NOW()
FROM schools s
WHERE fs.school_id = s.id
  AND COALESCE(s.fee_mode, 'per_class') = 'per_class'
  AND fs.section_id IS NOT NULL
  AND fs.deleted_at IS NULL;

-- Soft-delete class-level structures for per_section schools
UPDATE fee_structures fs
SET deleted_at = NOW(), updated_at = NOW()
FROM schools s
WHERE fs.school_id = s.id
  AND s.fee_mode = 'per_section'
  AND fs.section_id IS NULL
  AND fs.deleted_at IS NULL;

-- Soft-delete student_fees linked to deleted/wrong-mode structures (unpaid duplicates)
UPDATE student_fees sf
SET deleted_at = NOW(), updated_at = NOW()
FROM fee_structures fs
JOIN schools s ON s.id = fs.school_id
WHERE sf.fee_structure_id = fs.id
  AND sf.deleted_at IS NULL
  AND sf.amount_paid = 0
  AND (
    (COALESCE(s.fee_mode, 'per_class') = 'per_class' AND fs.section_id IS NOT NULL)
    OR (s.fee_mode = 'per_section' AND fs.section_id IS NULL)
    OR fs.deleted_at IS NOT NULL
  )
  AND EXISTS (
    SELECT 1 FROM student_fees sf2
    JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
    JOIN schools s2 ON s2.id = fs2.school_id
    WHERE sf2.student_id = sf.student_id
      AND sf2.deleted_at IS NULL
      AND fs2.deleted_at IS NULL
      AND fs2.fee_type_id = fs.fee_type_id
      AND fs2.academic_year_id = fs.academic_year_id
      AND fs2.class_id = fs.class_id
      AND (
        (COALESCE(s2.fee_mode, 'per_class') = 'per_class' AND fs2.section_id IS NULL)
        OR (s2.fee_mode = 'per_section' AND fs2.section_id IS NOT NULL)
      )
  );

-- Soft-delete orphan unpaid fees on wrong-mode structures (no matching active-mode fee)
UPDATE student_fees sf
SET deleted_at = NOW(), updated_at = NOW()
FROM fee_structures fs
JOIN schools s ON s.id = fs.school_id
WHERE sf.fee_structure_id = fs.id
  AND sf.deleted_at IS NULL
  AND sf.amount_paid = 0
  AND (
    (COALESCE(s.fee_mode, 'per_class') = 'per_class' AND fs.section_id IS NOT NULL)
    OR (s.fee_mode = 'per_section' AND fs.section_id IS NULL)
  );

COMMIT;
