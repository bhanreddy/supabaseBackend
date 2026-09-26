-- Exam-only special subjects (for example Handwriting).
-- Additive only: existing subjects, papers, marks, and IDs are unchanged.
-- Existing rows stay on the subject-teacher model. Nothing is inferred from names.

ALTER TABLE public.subjects
  ADD COLUMN IF NOT EXISTS is_exam_only BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.subjects.is_exam_only IS
  'True when the subject exists for exam marks only and must stay out of timetable and academic pickers.';

ALTER TABLE public.exam_subjects
  ADD COLUMN IF NOT EXISTS is_exam_only BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS marks_responsibility TEXT NOT NULL DEFAULT 'subject_teacher',
  ADD COLUMN IF NOT EXISTS subject_name_snapshot VARCHAR(100);

ALTER TABLE public.exam_subjects
  DROP CONSTRAINT IF EXISTS chk_exam_subjects_marks_responsibility;

ALTER TABLE public.exam_subjects
  ADD CONSTRAINT chk_exam_subjects_marks_responsibility
  CHECK (marks_responsibility IN ('subject_teacher', 'class_teacher'));

ALTER TABLE public.exam_subjects
  DROP CONSTRAINT IF EXISTS chk_exam_only_mark_limits;

ALTER TABLE public.exam_subjects
  ADD CONSTRAINT chk_exam_only_mark_limits
  CHECK (
    NOT is_exam_only
    OR (
      max_marks > 0
      AND passing_marks >= 0
      AND passing_marks <= max_marks
    )
  );

COMMENT ON COLUMN public.exam_subjects.is_exam_only IS
  'True when this paper was configured as an exam-only special subject, not from the teaching timetable.';

COMMENT ON COLUMN public.exam_subjects.marks_responsibility IS
  'Who may enter marks: subject_teacher (existing papers) or class_teacher (exam-only special subjects).';

COMMENT ON COLUMN public.exam_subjects.subject_name_snapshot IS
  'Name configured for this paper. Historical results keep this name when the exam is edited.';

CREATE INDEX IF NOT EXISTS idx_subjects_exam_only
  ON public.subjects (school_id)
  WHERE deleted_at IS NULL AND is_exam_only = TRUE;

CREATE INDEX IF NOT EXISTS idx_exam_subjects_exam_only
  ON public.exam_subjects (school_id, exam_id)
  WHERE deleted_at IS NULL AND is_exam_only = TRUE;

-- One active exam-only name per overlapping target. A class-wide paper overlaps
-- every section of that class; two different sections do not overlap.
CREATE OR REPLACE FUNCTION public.prevent_overlapping_exam_only_papers()
RETURNS TRIGGER
SET search_path = public
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.is_exam_only IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM exam_subjects other
    WHERE other.exam_id = NEW.exam_id
      AND other.school_id = NEW.school_id
      AND other.id IS DISTINCT FROM NEW.id
      AND other.deleted_at IS NULL
      AND other.is_exam_only = TRUE
      AND other.class_id = NEW.class_id
      AND lower(btrim(COALESCE(other.subject_name_snapshot, ''))) = lower(btrim(COALESCE(NEW.subject_name_snapshot, '')))
      AND (
        other.class_section_id IS NOT DISTINCT FROM NEW.class_section_id
        OR other.class_section_id IS NULL
        OR NEW.class_section_id IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'duplicate exam-only subject configuration'
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_exam_only_paper_overlap ON public.exam_subjects;
CREATE TRIGGER trg_exam_only_paper_overlap
BEFORE INSERT OR UPDATE ON public.exam_subjects
FOR EACH ROW EXECUTE FUNCTION public.prevent_overlapping_exam_only_papers();
