-- ============================================================
-- SchoolIMS v4.1.8 — Batch 1: Database Hardening & Automation Foundations
-- Generated: 2026-09-05
-- ============================================================

-- 1. HARDEN CORE OPERATIONAL & FK INDEXES (Resolving migration drift)
CREATE INDEX IF NOT EXISTS idx_attendance_date ON public.daily_attendance(attendance_date);
CREATE INDEX IF NOT EXISTS idx_attendance_enrollment ON public.daily_attendance(student_enrollment_id);
CREATE INDEX IF NOT EXISTS idx_attendance_composite ON public.daily_attendance(student_enrollment_id, status, attendance_date);

CREATE INDEX IF NOT EXISTS idx_transactions_paid_at ON public.fee_transactions(paid_at);
CREATE INDEX IF NOT EXISTS idx_fee_transactions_student_fee_id ON public.fee_transactions(student_fee_id);
CREATE INDEX IF NOT EXISTS idx_fee_transactions_school_paid_at ON public.fee_transactions(school_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_marks_exam_subject ON public.marks(exam_subject_id);
CREATE INDEX IF NOT EXISTS idx_marks_enrollment ON public.marks(student_enrollment_id);

CREATE INDEX IF NOT EXISTS idx_person_contacts_person_id ON public.person_contacts(person_id);

CREATE INDEX IF NOT EXISTS idx_receipt_items_transaction_id ON public.receipt_items(fee_transaction_id);
CREATE INDEX IF NOT EXISTS idx_receipt_items_receipt_id ON public.receipt_items(receipt_id);

CREATE INDEX IF NOT EXISTS idx_student_enrollments_class_section ON public.student_enrollments(class_section_id);

CREATE INDEX IF NOT EXISTS idx_student_fees_structure_id ON public.student_fees(fee_structure_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_status ON public.student_fees(status);
CREATE INDEX IF NOT EXISTS idx_student_fees_student ON public.student_fees(student_id);
CREATE INDEX IF NOT EXISTS idx_student_fees_school_status_due ON public.student_fees(school_id, status, due_date);

CREATE INDEX IF NOT EXISTS idx_students_status ON public.students(status_id);

-- 2. CREATE school_automation_rules TABLE
CREATE TABLE IF NOT EXISTS public.school_automation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    rule_key VARCHAR(60) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_triggered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_school_automation_rule_key UNIQUE (school_id, rule_key)
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_school ON public.school_automation_rules(school_id, is_enabled);

-- Defense-in-depth: RLS on school_automation_rules
ALTER TABLE public.school_automation_rules ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('school_automation_rules');
  END IF;
END $$;

-- 3. CREATE automation_execution_logs TABLE (Unified execution & reminder history)
CREATE TABLE IF NOT EXISTS public.automation_execution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    rule_key VARCHAR(60) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    attempt INT NOT NULL DEFAULT 1,
    stage VARCHAR(40),
    channel VARCHAR(20) NOT NULL DEFAULT 'push',
    recipient_user_ids JSONB DEFAULT '[]'::jsonb,
    payload JSONB DEFAULT '{}'::jsonb,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at TIMESTAMPTZ,
    error_summary TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_automation_exec_idempotency UNIQUE (school_id, idempotency_key),
    CONSTRAINT chk_automation_exec_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped'))
);

CREATE INDEX IF NOT EXISTS idx_auto_exec_school_status ON public.automation_execution_logs(school_id, status);
CREATE INDEX IF NOT EXISTS idx_auto_exec_entity ON public.automation_execution_logs(school_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_auto_exec_rule_date ON public.automation_execution_logs(school_id, rule_key, created_at DESC);

-- Defense-in-depth: RLS on automation_execution_logs
ALTER TABLE public.automation_execution_logs ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'create_tenant_rls_policy') THEN
    PERFORM create_tenant_rls_policy('automation_execution_logs');
  END IF;
END $$;
