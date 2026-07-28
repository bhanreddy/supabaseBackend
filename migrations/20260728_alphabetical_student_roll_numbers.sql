-- Keep active student roll numbers continuous and aligned with alphabetical
-- first-name order inside each class-section and academic year.

DO $$
DECLARE
    unique_constraint RECORD;
BEGIN
    -- The original table-level unique constraint also covered completed and
    -- soft-deleted enrollments. Those historical rows must not reserve a roll
    -- number that an active student needs.
    FOR unique_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.student_enrollments'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid)
              LIKE 'UNIQUE (%class_section_id, academic_year_id, roll_number)%'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.student_enrollments DROP CONSTRAINT %I',
            unique_constraint.conname
        );
    END LOOP;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_enrollment_roll_number
ON public.student_enrollments (class_section_id, academic_year_id, roll_number)
WHERE status = 'active'
  AND deleted_at IS NULL
  AND roll_number IS NOT NULL;

-- The existing guard rejected every update to an enrollment after its student
-- was soft-deleted, including the roll-only cleanup below. Keep the guard for
-- actual enrollment assignments while allowing harmless maintenance fields.
CREATE OR REPLACE FUNCTION public.ensure_active_student_enrollment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    should_validate BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        should_validate := TRUE;
    ELSE
        should_validate :=
            NEW.student_id IS DISTINCT FROM OLD.student_id
            OR NEW.class_section_id IS DISTINCT FROM OLD.class_section_id
            OR NEW.academic_year_id IS DISTINCT FROM OLD.academic_year_id
            OR (
                NEW.status = 'active'
                AND NEW.status IS DISTINCT FROM OLD.status
            );
    END IF;

    IF should_validate AND EXISTS (
        SELECT 1
        FROM students
        WHERE id = NEW.student_id
          AND deleted_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Cannot enroll a deleted student';
    END IF;

    RETURN NEW;
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
BEGIN
    -- Serialize recalculations for the same section/year.
    PERFORM pg_advisory_xact_lock(
        hashtext(p_class_section_id::text),
        hashtext(p_academic_year_id::text)
    );

    -- Clear the target range first so swaps cannot collide with the unique
    -- index. Enrollments belonging to deleted students intentionally stay NULL.
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
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_rolls_after_enrollment_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalculate_section_rolls(
            OLD.class_section_id,
            OLD.academic_year_id
        );
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        PERFORM recalculate_section_rolls(
            OLD.class_section_id,
            OLD.academic_year_id
        );
    END IF;

    PERFORM recalculate_section_rolls(
        NEW.class_section_id,
        NEW.academic_year_id
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_enrollment_change
ON public.student_enrollments;
CREATE TRIGGER trg_recalculate_rolls_after_enrollment_change
AFTER INSERT OR DELETE OR UPDATE OF
    class_section_id, academic_year_id, status, deleted_at
ON public.student_enrollments
FOR EACH ROW
EXECUTE FUNCTION public.recalculate_rolls_after_enrollment_change();

CREATE OR REPLACE FUNCTION public.recalculate_rolls_after_student_name_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    target RECORD;
BEGIN
    IF ROW(OLD.first_name, OLD.middle_name, OLD.last_name)
       IS NOT DISTINCT FROM
       ROW(NEW.first_name, NEW.middle_name, NEW.last_name) THEN
        RETURN NEW;
    END IF;

    FOR target IN
        SELECT DISTINCT se.class_section_id, se.academic_year_id
        FROM students s
        JOIN student_enrollments se ON se.student_id = s.id
        WHERE s.person_id = NEW.id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
    LOOP
        PERFORM recalculate_section_rolls(
            target.class_section_id,
            target.academic_year_id
        );
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_student_name_change
ON public.persons;
CREATE TRIGGER trg_recalculate_rolls_after_student_name_change
AFTER UPDATE OF first_name, middle_name, last_name
ON public.persons
FOR EACH ROW
EXECUTE FUNCTION public.recalculate_rolls_after_student_name_change();

CREATE OR REPLACE FUNCTION public.recalculate_rolls_after_student_delete_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    target RECORD;
BEGIN
    IF OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN
        RETURN NEW;
    END IF;

    FOR target IN
        SELECT DISTINCT se.class_section_id, se.academic_year_id
        FROM student_enrollments se
        WHERE se.student_id = NEW.id
          AND se.status = 'active'
          AND se.deleted_at IS NULL
    LOOP
        PERFORM recalculate_section_rolls(
            target.class_section_id,
            target.academic_year_id
        );
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recalculate_rolls_after_student_delete_change
ON public.students;
CREATE TRIGGER trg_recalculate_rolls_after_student_delete_change
AFTER UPDATE OF deleted_at
ON public.students
FOR EACH ROW
EXECUTE FUNCTION public.recalculate_rolls_after_student_delete_change();

-- Correct existing data immediately.
DO $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
        SELECT DISTINCT se.class_section_id, se.academic_year_id
        FROM public.student_enrollments se
        WHERE se.status = 'active'
          AND se.deleted_at IS NULL
    LOOP
        PERFORM public.recalculate_section_rolls(
            target.class_section_id,
            target.academic_year_id
        );
    END LOOP;
END;
$$;
