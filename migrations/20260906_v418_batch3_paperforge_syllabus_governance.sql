-- ============================================================
-- Migration: 20260906_v418_batch3_paperforge_syllabus_governance.sql
-- Description: Batch 3 schema additions for SchoolIMS v4.1.8:
--   1. generated_papers (PaperForge history, editing, export)
--   2. syllabus_chapters & syllabus_topics (Curriculum tracking)
--   3. diary_entries syllabus linkage (chapter/topic FKs)
--   4. student_documents & school_document_requirements
-- ============================================================

-- 1. Generated Question Papers (PaperForge)
CREATE TABLE IF NOT EXISTS public.generated_papers (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    school_id integer NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    paper_id text,
    subject text NOT NULL,
    class_level text NOT NULL,
    exam_name text,
    title text,
    blueprint jsonb NOT NULL DEFAULT '{}'::jsonb,
    questions jsonb NOT NULL DEFAULT '[]'::jsonb,
    compliance jsonb DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'READY',
    created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.generated_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_papers FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_generated_papers_school_user ON public.generated_papers(school_id, created_by, created_at DESC);

-- 2. Syllabus Chapters & Topics
CREATE TABLE IF NOT EXISTS public.syllabus_chapters (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    school_id integer NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_year_id uuid REFERENCES public.academic_years(id) ON DELETE SET NULL,
    class_id uuid REFERENCES public.classes(id) ON DELETE CASCADE,
    subject_id uuid REFERENCES public.subjects(id) ON DELETE CASCADE,
    term text DEFAULT 'Term 1',
    chapter_number integer NOT NULL,
    title text NOT NULL,
    estimated_periods integer DEFAULT 1,
    target_completion_date date,
    status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED')),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.syllabus_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.syllabus_chapters FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_syllabus_chapters_lookup ON public.syllabus_chapters(school_id, class_id, subject_id);

CREATE TABLE IF NOT EXISTS public.syllabus_topics (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    chapter_id uuid NOT NULL REFERENCES public.syllabus_chapters(id) ON DELETE CASCADE,
    school_id integer NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    topic_number integer NOT NULL,
    title text NOT NULL,
    target_date date,
    status text NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DELAYED')),
    completed_at date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.syllabus_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.syllabus_topics FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_syllabus_topics_chapter ON public.syllabus_topics(chapter_id, topic_number);
CREATE INDEX IF NOT EXISTS idx_syllabus_topics_school_status ON public.syllabus_topics(school_id, status);

-- 3. Link diary_entries to syllabus
ALTER TABLE public.diary_entries ADD COLUMN IF NOT EXISTS syllabus_chapter_id uuid REFERENCES public.syllabus_chapters(id) ON DELETE SET NULL;
ALTER TABLE public.diary_entries ADD COLUMN IF NOT EXISTS syllabus_topic_id uuid REFERENCES public.syllabus_topics(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_syllabus_chapter ON public.diary_entries(syllabus_chapter_id);
CREATE INDEX IF NOT EXISTS idx_diary_entries_syllabus_topic ON public.diary_entries(syllabus_topic_id);

-- 4. Student Documents & Requirements
CREATE TABLE IF NOT EXISTS public.student_documents (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    school_id integer NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    document_type text NOT NULL,
    title text,
    file_url text,
    status text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('PENDING', 'SUBMITTED', 'VERIFIED', 'REJECTED')),
    verified_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    verified_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.student_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_documents FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_student_documents_student ON public.student_documents(school_id, student_id);
CREATE INDEX IF NOT EXISTS idx_student_documents_type ON public.student_documents(school_id, document_type);

CREATE TABLE IF NOT EXISTS public.school_document_requirements (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    school_id integer NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    document_type text NOT NULL,
    display_name text NOT NULL,
    is_required boolean NOT NULL DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT uq_school_document_requirements UNIQUE (school_id, document_type)
);

ALTER TABLE public.school_document_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.school_document_requirements FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_school_doc_requirements ON public.school_document_requirements(school_id);

-- 5. RLS Policies
DO $$
BEGIN
    -- generated_papers
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'generated_papers' AND policyname = 'Tenant isolation: generated_papers') THEN
        CREATE POLICY "Tenant isolation: generated_papers" ON public.generated_papers
        USING (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id())
        WITH CHECK (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id());
    END IF;

    -- syllabus_chapters
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'syllabus_chapters' AND policyname = 'Tenant isolation: syllabus_chapters') THEN
        CREATE POLICY "Tenant isolation: syllabus_chapters" ON public.syllabus_chapters
        USING (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id())
        WITH CHECK (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id());
    END IF;

    -- syllabus_topics
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'syllabus_topics' AND policyname = 'Tenant isolation: syllabus_topics') THEN
        CREATE POLICY "Tenant isolation: syllabus_topics" ON public.syllabus_topics
        USING (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id())
        WITH CHECK (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id());
    END IF;

    -- student_documents
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'student_documents' AND policyname = 'Tenant isolation: student_documents') THEN
        CREATE POLICY "Tenant isolation: student_documents" ON public.student_documents
        USING (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id())
        WITH CHECK (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id());
    END IF;

    -- school_document_requirements
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'school_document_requirements' AND policyname = 'Tenant isolation: school_document_requirements') THEN
        CREATE POLICY "Tenant isolation: school_document_requirements" ON public.school_document_requirements
        USING (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id())
        WITH CHECK (auth.role() = 'service_role' OR is_super_admin() OR school_id = auth_school_id());
    END IF;
END $$;

-- 6. Table Grants
GRANT ALL ON TABLE public.generated_papers TO authenticated, service_role;
GRANT ALL ON TABLE public.syllabus_chapters TO authenticated, service_role;
GRANT ALL ON TABLE public.syllabus_topics TO authenticated, service_role;
GRANT ALL ON TABLE public.student_documents TO authenticated, service_role;
GRANT ALL ON TABLE public.school_document_requirements TO authenticated, service_role;
