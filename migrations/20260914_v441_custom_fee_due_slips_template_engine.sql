-- 1. DOCUMENT TEMPLATES TABLE
CREATE TABLE IF NOT EXISTS public.document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  document_type VARCHAR(64) NOT NULL DEFAULT 'fee_due_slip',
  description TEXT,
  template_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  page_settings JSONB NOT NULL DEFAULT '{"page_size":"A4","orientation":"portrait","slips_per_page":1,"margins":{"top":10,"bottom":10,"left":10,"right":10}}'::jsonb,
  is_default BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(32) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_templates_school_type_status
  ON public.document_templates (school_id, document_type, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates_default
  ON public.document_templates (school_id, document_type)
  WHERE (is_default = true AND status = 'active');

-- 2. DOCUMENT GENERATION JOBS TABLE
CREATE TABLE IF NOT EXISTS public.document_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  template_id UUID REFERENCES public.document_templates(id) ON DELETE SET NULL,
  document_type VARCHAR(64) NOT NULL DEFAULT 'fee_due_slip',
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  student_count INTEGER NOT NULL DEFAULT 0 CHECK (student_count >= 0),
  total_due_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  output_format VARCHAR(32) NOT NULL DEFAULT 'pdf',
  output_location TEXT,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_document_generation_jobs_school_status
  ON public.document_generation_jobs (school_id, status, created_at DESC);

-- 3. DOCUMENT NUMBER COUNTERS TABLE
CREATE TABLE IF NOT EXISTS public.document_number_counters (
  school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
  document_type VARCHAR(64) NOT NULL DEFAULT 'fee_due_slip',
  last_number BIGINT NOT NULL DEFAULT 1000 CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, document_type)
);

-- 4. SEQUENTIAL DOCUMENT NUMBER GENERATOR FUNCTION
CREATE OR REPLACE FUNCTION public.get_next_document_no(p_school_id INTEGER, p_doc_type TEXT DEFAULT 'fee_due_slip')
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next_number BIGINT;
  v_prefix TEXT;
  v_year TEXT;
BEGIN
  IF p_school_id IS NULL THEN
    RAISE EXCEPTION 'school_id is required to generate a document number';
  END IF;

  v_prefix := CASE
    WHEN p_doc_type = 'fee_due_slip' THEN 'FDS'
    WHEN p_doc_type = 'fee_collection_slip' THEN 'FCS'
    WHEN p_doc_type = 'payment_reminder' THEN 'PR'
    WHEN p_doc_type = 'student_statement' THEN 'SS'
    WHEN p_doc_type = 'salary_slip' THEN 'SLS'
    ELSE 'DOC'
  END;

  v_year := TO_CHAR(NOW(), 'YYYY');

  INSERT INTO public.document_number_counters AS counters (school_id, document_type, last_number, updated_at)
  VALUES (p_school_id, p_doc_type, 1001, NOW())
  ON CONFLICT (school_id, document_type) DO UPDATE
  SET last_number = counters.last_number + 1,
      updated_at = NOW()
  RETURNING last_number INTO v_next_number;

  RETURN v_prefix || '-' || v_year || '-' || LPAD(v_next_number::TEXT, 6, '0');
END;
$$;

-- RLS Enablement
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_number_counters ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.document_templates TO postgres;
GRANT ALL ON TABLE public.document_generation_jobs TO postgres;
GRANT ALL ON TABLE public.document_number_counters TO postgres;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.document_templates TO service_role;
    GRANT ALL ON TABLE public.document_generation_jobs TO service_role;
    GRANT ALL ON TABLE public.document_number_counters TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_templates TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_generation_jobs TO authenticated;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.document_number_counters TO authenticated;
  END IF;
END $$;
