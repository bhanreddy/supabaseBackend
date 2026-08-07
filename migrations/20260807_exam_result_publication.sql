-- Exam-result release gate. Marks remain private while teachers complete entry;
-- an admin publishes the complete exam in one explicit action.

ALTER TABLE exams
  ADD COLUMN IF NOT EXISTS results_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE exams
  ADD COLUMN IF NOT EXISTS results_published_at TIMESTAMPTZ;
ALTER TABLE exams
  ADD COLUMN IF NOT EXISTS results_published_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_exams_results_published
  ON exams(school_id, results_published)
  WHERE deleted_at IS NULL;

-- Once released, teacher uploads/edits must not change what families see. The
-- admin can unpublish, allow corrections, then publish the complete result again.
CREATE OR REPLACE FUNCTION prevent_published_result_mark_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_exam_subject_id UUID;
  target_exam_id UUID;
  is_published BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_exam_subject_id := OLD.exam_subject_id;
  ELSE
    target_exam_subject_id := NEW.exam_subject_id;
  END IF;

  SELECT es.exam_id
    INTO target_exam_id
  FROM exam_subjects es
  WHERE es.id = target_exam_subject_id;

  SELECT e.results_published
    INTO is_published
  FROM exams e
  WHERE e.id = target_exam_id
  FOR SHARE;

  IF COALESCE(is_published, FALSE) THEN
    RAISE EXCEPTION 'Published results are locked. Unpublish them before changing marks.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_published_result_marks ON marks;
CREATE TRIGGER trg_lock_published_result_marks
BEFORE INSERT OR UPDATE OR DELETE ON marks
FOR EACH ROW EXECUTE FUNCTION prevent_published_result_mark_changes();

-- Scheduled papers are part of the released result contract too. Prevent a
-- published exam from gaining/removing/changing papers behind the admin gate.
CREATE OR REPLACE FUNCTION prevent_published_result_paper_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_exam_id UUID;
  is_published BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' AND
     ROW(NEW.exam_id, NEW.subject_id, NEW.class_id, NEW.exam_date,
         NEW.start_time, NEW.end_time, NEW.max_marks, NEW.passing_marks, NEW.deleted_at)
     IS NOT DISTINCT FROM
     ROW(OLD.exam_id, OLD.subject_id, OLD.class_id, OLD.exam_date,
         OLD.start_time, OLD.end_time, OLD.max_marks, OLD.passing_marks, OLD.deleted_at) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_exam_id := OLD.exam_id;
  ELSE
    target_exam_id := NEW.exam_id;
  END IF;

  SELECT e.results_published
    INTO is_published
  FROM exams e
  WHERE e.id = target_exam_id
  FOR SHARE;

  IF COALESCE(is_published, FALSE) THEN
    RAISE EXCEPTION 'Published results are locked. Unpublish them before changing exam papers.'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lock_published_result_papers ON exam_subjects;
CREATE TRIGGER trg_lock_published_result_papers
BEFORE INSERT OR UPDATE OR DELETE ON exam_subjects
FOR EACH ROW EXECUTE FUNCTION prevent_published_result_paper_changes();
