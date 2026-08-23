-- Allow class teachers to keep a custom, continuous roll-number order.
-- Automatic sections remain alphabetical. Manual sections preserve the saved
-- roll order when names or enrollments change, compacting gaps as required.

ALTER TABLE public.class_sections
  ADD COLUMN IF NOT EXISTS manual_roll_numbers BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS roll_number_start INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'class_sections_roll_number_start_positive'
      AND conrelid = 'public.class_sections'::regclass
  ) THEN
    ALTER TABLE public.class_sections
      ADD CONSTRAINT class_sections_roll_number_start_positive
      CHECK (roll_number_start BETWEEN 1 AND 9999);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_section_rolls(
    p_class_section_id UUID,
    p_academic_year_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_manual BOOLEAN := false;
    v_start INTEGER := 1;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtext(p_class_section_id::text),
        hashtext(p_academic_year_id::text)
    );

    SELECT COALESCE(manual_roll_numbers, false), COALESCE(roll_number_start, 1)
      INTO v_manual, v_start
    FROM class_sections
    WHERE id = p_class_section_id;

    IF v_manual THEN
        -- Stage existing positive values as negative numbers. This preserves
        -- the teacher's order while avoiding transient unique-index collisions.
        UPDATE student_enrollments
        SET roll_number = -roll_number
        WHERE class_section_id = p_class_section_id
          AND academic_year_id = p_academic_year_id
          AND status = 'active'
          AND deleted_at IS NULL
          AND roll_number IS NOT NULL
          AND roll_number > 0;

        WITH ordered_students AS (
            SELECT
                se.id AS enrollment_id,
                (v_start - 1 + ROW_NUMBER() OVER (
                    ORDER BY
                        ABS(se.roll_number) ASC NULLS LAST,
                        LOWER(BTRIM(COALESCE(p.first_name, ''))) ASC,
                        LOWER(BTRIM(COALESCE(p.middle_name, ''))) ASC,
                        LOWER(BTRIM(COALESCE(p.last_name, ''))) ASC,
                        s.admission_no ASC,
                        s.id ASC
                ))::INTEGER AS new_roll
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            WHERE se.class_section_id = p_class_section_id
              AND se.academic_year_id = p_academic_year_id
              AND se.status = 'active'
              AND se.deleted_at IS NULL
              AND s.deleted_at IS NULL
        )
        UPDATE student_enrollments se
        SET roll_number = ordered_students.new_roll
        FROM ordered_students
        WHERE se.id = ordered_students.enrollment_id;
    ELSE
        UPDATE student_enrollments
        SET roll_number = NULL
        WHERE class_section_id = p_class_section_id
          AND academic_year_id = p_academic_year_id
          AND status = 'active'
          AND deleted_at IS NULL
          AND roll_number IS NOT NULL;

        WITH ordered_students AS (
            SELECT
                se.id AS enrollment_id,
                ROW_NUMBER() OVER (
                    ORDER BY
                        LOWER(BTRIM(COALESCE(p.first_name, ''))) ASC,
                        LOWER(BTRIM(COALESCE(p.middle_name, ''))) ASC,
                        LOWER(BTRIM(COALESCE(p.last_name, ''))) ASC,
                        s.admission_no ASC,
                        s.id ASC
                )::INTEGER AS new_roll
            FROM student_enrollments se
            JOIN students s ON se.student_id = s.id
            JOIN persons p ON s.person_id = p.id
            WHERE se.class_section_id = p_class_section_id
              AND se.academic_year_id = p_academic_year_id
              AND se.status = 'active'
              AND se.deleted_at IS NULL
              AND s.deleted_at IS NULL
        )
        UPDATE student_enrollments se
        SET roll_number = ordered_students.new_roll
        FROM ordered_students
        WHERE se.id = ordered_students.enrollment_id;
    END IF;
END;
$$;
