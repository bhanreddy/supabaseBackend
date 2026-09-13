-- SchoolIMS v4.1.8 Phase 5-12 security and release-gate corrections.
-- This is deliberately forward-only: do not edit the established Batch 2/3 files.

-- The release baseline contains the legacy PaperForge table. Batch 3's
-- CREATE TABLE IF NOT EXISTS cannot upgrade it, so add the v4.1.8 contract
-- without discarding historical rows. created_by_user is the typed FK used by
-- new code; legacy created_by remains intact for evidence/history.
ALTER TABLE public.generated_papers
  ADD COLUMN IF NOT EXISTS paper_id text,
  ADD COLUMN IF NOT EXISTS subject text,
  ADD COLUMN IF NOT EXISTS class_level text,
  ADD COLUMN IF NOT EXISTS exam_name text,
  ADD COLUMN IF NOT EXISTS blueprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS compliance jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'READY',
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by_user uuid;
ALTER TABLE public.generated_papers ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE public.generated_papers ADD COLUMN IF NOT EXISTS total_marks integer;
ALTER TABLE public.generated_papers ADD COLUMN IF NOT EXISTS sections jsonb;

UPDATE public.generated_papers gp
SET created_by_user = u.id
FROM public.users u
WHERE gp.created_by_user IS NULL
  AND gp.created_by::text = u.id::text
  AND gp.school_id = u.school_id;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='generated_papers_created_by_user_fkey') THEN
    ALTER TABLE public.generated_papers ADD CONSTRAINT generated_papers_created_by_user_fkey
      FOREIGN KEY (created_by_user) REFERENCES public.users(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_generated_papers_typed_owner
  ON public.generated_papers(school_id, created_by_user, updated_at DESC);

-- Browser sessions must never access internal workflow tables directly. The API's
-- service connection is the sole authorization boundary for these records.
REVOKE ALL ON TABLE public.generated_papers FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.syllabus_chapters FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.syllabus_topics FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.student_documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.school_document_requirements FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.generated_papers TO service_role;
GRANT ALL ON TABLE public.syllabus_chapters TO service_role;
GRANT ALL ON TABLE public.syllabus_topics TO service_role;
GRANT ALL ON TABLE public.student_documents TO service_role;
GRANT ALL ON TABLE public.school_document_requirements TO service_role;

-- SECURITY DEFINER counters must not be callable by a portal JWT.
REVOKE EXECUTE ON FUNCTION public.get_next_certificate_serial(integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_certificate_serial(integer, text, integer) TO service_role;
REVOKE EXECUTE ON FUNCTION public.next_certificate_serial(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_certificate_serial(text, integer) TO service_role;

-- Fail the deployment instead of silently preserving ambiguous duplicate
-- curriculum rows. These tables are new in v4.1.8, so duplicates indicate a
-- partial/bad rollout that needs explicit reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_syllabus_chapter_number
  ON public.syllabus_chapters (
    school_id, academic_year_id, class_id, subject_id, term, chapter_number
  ) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_syllabus_topic_number
  ON public.syllabus_topics (school_id, chapter_id, topic_number);

CREATE INDEX IF NOT EXISTS idx_audit_logs_school_created
  ON public.audit_logs (school_id, created_at DESC);
