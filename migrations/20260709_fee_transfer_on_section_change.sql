-- ════════════════════════════════════════════════════════════
-- Migration: Reassign student fees when class/section changes
-- Date: 2026-07-09
-- ════════════════════════════════════════════════════════════
-- Bug: moving a student to another section (per_section mode) or
-- class (per_class mode) left student_fees pointing at the old
-- location's structures. The enrollment trigger only fired for
-- INSERT / status flips, and its fee-type de-dup blocked the new
-- section's rows anyway.
--
-- Fix:
--   1. auto_assign_fees_on_enrollment now also handles transfers
--      (class_section_id change while status stays 'active'):
--        a. untouched fees (nothing paid, no discount) at the old
--           location are soft-deleted
--        b. paid/discounted fees are re-pointed to the same fee
--           type at the new location (payments preserved)
--        c. remaining new-location structures are assigned fresh
--   2. One-time backfill applies the same repair to students whose
--      section/class was changed before this fix.
--
-- Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════

BEGIN;

-- Assignment unique index (normally created by feeModeService; no-op if present)
CREATE UNIQUE INDEX IF NOT EXISTS idx_student_fees_unique_assignment
ON student_fees (student_id, fee_structure_id)
WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 1. Enrollment trigger: assign on activation AND on transfer
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_assign_fees_on_enrollment()
RETURNS TRIGGER
SET search_path = public
AS $$
DECLARE
    v_class_id UUID;
    v_section_id UUID;
    v_old_class_id UUID;
    v_old_section_id UUID;
    v_fee_mode TEXT;
    v_newly_active BOOLEAN;
    v_transfer BOOLEAN;
BEGIN
    v_newly_active := NEW.status = 'active'
        AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active');
    v_transfer := TG_OP = 'UPDATE'
        AND NEW.status = 'active'
        AND OLD.status = 'active'
        AND NEW.deleted_at IS NULL
        AND NEW.class_section_id IS DISTINCT FROM OLD.class_section_id
        AND NEW.academic_year_id IS NOT DISTINCT FROM OLD.academic_year_id;

    IF NOT (v_newly_active OR v_transfer) THEN
        RETURN NEW;
    END IF;

    SELECT cs.class_id, cs.section_id INTO v_class_id, v_section_id
    FROM class_sections cs WHERE cs.id = NEW.class_section_id;

    SELECT COALESCE(s.fee_mode, 'per_class') INTO v_fee_mode
    FROM schools s WHERE s.id = NEW.school_id;

    IF v_transfer THEN
        SELECT cs.class_id, cs.section_id INTO v_old_class_id, v_old_section_id
        FROM class_sections cs WHERE cs.id = OLD.class_section_id;

        -- In per_class mode a section move within the same class does not
        -- change the fee location — nothing to do.
        IF v_fee_mode <> 'per_section' AND v_old_class_id IS NOT DISTINCT FROM v_class_id THEN
            RETURN NEW;
        END IF;

        -- (a) untouched fees at the old location are dropped
        UPDATE student_fees sf
        SET deleted_at = NOW(), updated_at = NOW()
        FROM fee_structures src
        WHERE sf.fee_structure_id = src.id
          AND sf.student_id = NEW.student_id
          AND sf.school_id = NEW.school_id
          AND sf.deleted_at IS NULL
          AND sf.amount_paid = 0
          AND sf.discount = 0
          AND src.school_id = NEW.school_id
          AND src.academic_year_id = NEW.academic_year_id
          AND src.class_id = v_old_class_id
          AND ((v_fee_mode = 'per_section' AND src.section_id = v_old_section_id)
            OR (v_fee_mode <> 'per_section' AND src.section_id IS NULL));

        -- (b) paid/discounted fees move with the student: re-point to the
        -- same fee type at the new location (one keeper per target to
        -- respect the assignment unique index)
        UPDATE student_fees sf
        SET fee_structure_id = k.tgt_id,
            amount_due = GREATEST(k.tgt_amount, sf.amount_paid + sf.discount),
            due_date = k.tgt_due_date,
            updated_at = NOW()
        FROM (
            SELECT DISTINCT ON (tgt.id)
                sf2.id AS fee_id,
                tgt.id AS tgt_id,
                tgt.amount AS tgt_amount,
                tgt.due_date AS tgt_due_date
            FROM student_fees sf2
            JOIN fee_structures src ON sf2.fee_structure_id = src.id
            JOIN fee_structures tgt
              ON tgt.school_id = src.school_id
             AND tgt.academic_year_id = src.academic_year_id
             AND tgt.fee_type_id = src.fee_type_id
             AND tgt.class_id = v_class_id
             AND ((v_fee_mode = 'per_section' AND tgt.section_id = v_section_id)
               OR (v_fee_mode <> 'per_section' AND tgt.section_id IS NULL))
             AND tgt.deleted_at IS NULL
             AND tgt.id <> src.id
            WHERE sf2.student_id = NEW.student_id
              AND sf2.school_id = NEW.school_id
              AND sf2.deleted_at IS NULL
              AND src.school_id = NEW.school_id
              AND src.academic_year_id = NEW.academic_year_id
              AND src.class_id = v_old_class_id
              AND ((v_fee_mode = 'per_section' AND src.section_id = v_old_section_id)
                OR (v_fee_mode <> 'per_section' AND src.section_id IS NULL))
              AND NOT EXISTS (
                SELECT 1 FROM student_fees sfx
                WHERE sfx.student_id = NEW.student_id
                  AND sfx.fee_structure_id = tgt.id
                  AND sfx.deleted_at IS NULL
              )
            ORDER BY tgt.id, sf2.amount_paid DESC, sf2.created_at
        ) k
        WHERE sf.id = k.fee_id;
    END IF;

    -- Assign structures at the (new) location the student doesn't have yet
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

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_assign_fees_enrollment ON student_enrollments;
CREATE TRIGGER trg_auto_assign_fees_enrollment
AFTER INSERT OR UPDATE ON student_enrollments
FOR EACH ROW EXECUTE FUNCTION auto_assign_fees_on_enrollment();

-- ─────────────────────────────────────────────────────────────
-- 2. Backfill: repair students transferred before this fix
-- ─────────────────────────────────────────────────────────────
-- 2a. per_section schools: re-point paid/discounted fees whose structure's
--     class/section no longer matches the student's active enrollment.
WITH keeper AS (
    SELECT DISTINCT ON (sf.student_id, tgt.id)
        sf.id AS fee_id,
        tgt.id AS tgt_id,
        tgt.amount AS tgt_amount,
        tgt.due_date AS tgt_due_date
    FROM student_fees sf
    JOIN fee_structures src ON sf.fee_structure_id = src.id
    JOIN schools sch ON sch.id = sf.school_id
       AND COALESCE(sch.fee_mode, 'per_class') = 'per_section'
    JOIN student_enrollments se
      ON se.student_id = sf.student_id
     AND se.school_id = sf.school_id
     AND se.academic_year_id = src.academic_year_id
     AND se.status = 'active'
     AND se.deleted_at IS NULL
    JOIN class_sections cs ON cs.id = se.class_section_id
    JOIN fee_structures tgt
      ON tgt.school_id = src.school_id
     AND tgt.academic_year_id = src.academic_year_id
     AND tgt.fee_type_id = src.fee_type_id
     AND tgt.class_id = cs.class_id
     AND tgt.section_id = cs.section_id
     AND tgt.deleted_at IS NULL
    WHERE sf.deleted_at IS NULL
      AND (sf.amount_paid > 0 OR sf.discount > 0)
      AND src.section_id IS NOT NULL
      AND (src.class_id <> cs.class_id OR src.section_id <> cs.section_id)
      AND NOT EXISTS (
        SELECT 1 FROM student_fees sfx
        WHERE sfx.student_id = sf.student_id
          AND sfx.fee_structure_id = tgt.id
          AND sfx.deleted_at IS NULL
      )
    ORDER BY sf.student_id, tgt.id, sf.amount_paid DESC, sf.created_at
)
UPDATE student_fees sf
SET fee_structure_id = k.tgt_id,
    amount_due = GREATEST(k.tgt_amount, sf.amount_paid + sf.discount),
    due_date = k.tgt_due_date,
    updated_at = NOW()
FROM keeper k
WHERE sf.id = k.fee_id;

-- 2b. per_section schools: drop untouched fees left at the old section.
UPDATE student_fees sf
SET deleted_at = NOW(), updated_at = NOW()
FROM fee_structures src
JOIN schools sch ON sch.id = src.school_id
   AND COALESCE(sch.fee_mode, 'per_class') = 'per_section'
JOIN student_enrollments se
  ON se.school_id = src.school_id
 AND se.academic_year_id = src.academic_year_id
 AND se.status = 'active'
 AND se.deleted_at IS NULL
JOIN class_sections cs ON cs.id = se.class_section_id
WHERE sf.fee_structure_id = src.id
  AND sf.student_id = se.student_id
  AND sf.school_id = src.school_id
  AND sf.deleted_at IS NULL
  AND sf.amount_paid = 0
  AND sf.discount = 0
  AND src.section_id IS NOT NULL
  AND (src.class_id <> cs.class_id OR src.section_id <> cs.section_id);

-- 2c. per_class schools: re-point paid/discounted fees stuck at a previous class.
WITH keeper AS (
    SELECT DISTINCT ON (sf.student_id, tgt.id)
        sf.id AS fee_id,
        tgt.id AS tgt_id,
        tgt.amount AS tgt_amount,
        tgt.due_date AS tgt_due_date
    FROM student_fees sf
    JOIN fee_structures src ON sf.fee_structure_id = src.id
    JOIN schools sch ON sch.id = sf.school_id
       AND COALESCE(sch.fee_mode, 'per_class') = 'per_class'
    JOIN student_enrollments se
      ON se.student_id = sf.student_id
     AND se.school_id = sf.school_id
     AND se.academic_year_id = src.academic_year_id
     AND se.status = 'active'
     AND se.deleted_at IS NULL
    JOIN class_sections cs ON cs.id = se.class_section_id
    JOIN fee_structures tgt
      ON tgt.school_id = src.school_id
     AND tgt.academic_year_id = src.academic_year_id
     AND tgt.fee_type_id = src.fee_type_id
     AND tgt.class_id = cs.class_id
     AND tgt.section_id IS NULL
     AND tgt.deleted_at IS NULL
    WHERE sf.deleted_at IS NULL
      AND (sf.amount_paid > 0 OR sf.discount > 0)
      AND src.section_id IS NULL
      AND src.class_id <> cs.class_id
      AND NOT EXISTS (
        SELECT 1 FROM student_fees sfx
        WHERE sfx.student_id = sf.student_id
          AND sfx.fee_structure_id = tgt.id
          AND sfx.deleted_at IS NULL
      )
    ORDER BY sf.student_id, tgt.id, sf.amount_paid DESC, sf.created_at
)
UPDATE student_fees sf
SET fee_structure_id = k.tgt_id,
    amount_due = GREATEST(k.tgt_amount, sf.amount_paid + sf.discount),
    due_date = k.tgt_due_date,
    updated_at = NOW()
FROM keeper k
WHERE sf.id = k.fee_id;

-- 2d. per_class schools: drop untouched fees left at a previous class.
UPDATE student_fees sf
SET deleted_at = NOW(), updated_at = NOW()
FROM fee_structures src
JOIN schools sch ON sch.id = src.school_id
   AND COALESCE(sch.fee_mode, 'per_class') = 'per_class'
JOIN student_enrollments se
  ON se.school_id = src.school_id
 AND se.academic_year_id = src.academic_year_id
 AND se.status = 'active'
 AND se.deleted_at IS NULL
JOIN class_sections cs ON cs.id = se.class_section_id
WHERE sf.fee_structure_id = src.id
  AND sf.student_id = se.student_id
  AND sf.school_id = src.school_id
  AND sf.deleted_at IS NULL
  AND sf.amount_paid = 0
  AND sf.discount = 0
  AND src.section_id IS NULL
  AND src.class_id <> cs.class_id;

-- 2e. Give every actively-enrolled student the fees of their CURRENT
--     class/section that are still missing (mirrors the trigger's de-dup).
INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
SELECT DISTINCT fs.school_id, se.student_id, fs.id, fs.amount, 0, 'pending'::fee_status_enum, fs.due_date
FROM fee_structures fs
JOIN schools sch ON sch.id = fs.school_id
JOIN class_sections cs
  ON cs.class_id = fs.class_id
 AND cs.academic_year_id = fs.academic_year_id
 AND (
   (COALESCE(sch.fee_mode, 'per_class') = 'per_section' AND fs.section_id = cs.section_id)
   OR (COALESCE(sch.fee_mode, 'per_class') = 'per_class' AND fs.section_id IS NULL)
 )
JOIN student_enrollments se
  ON se.class_section_id = cs.id
 AND se.academic_year_id = fs.academic_year_id
 AND se.status = 'active'
 AND se.deleted_at IS NULL
WHERE fs.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM student_fees sf
    WHERE sf.student_id = se.student_id
      AND sf.fee_structure_id = fs.id
      AND sf.deleted_at IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM student_fees sf2
    JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
    WHERE sf2.student_id = se.student_id
      AND sf2.deleted_at IS NULL
      AND fs2.deleted_at IS NULL
      AND fs2.fee_type_id = fs.fee_type_id
      AND fs2.academic_year_id = fs.academic_year_id
      AND fs2.class_id = fs.class_id
  )
ON CONFLICT (student_id, fee_structure_id) WHERE deleted_at IS NULL DO NOTHING;

COMMIT;
