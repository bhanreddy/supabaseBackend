-- Hall-ticket download batches.
-- Tracks fee-filtered hall-ticket generation per exam, including a 15-minute
-- reservation that prevents two concurrent downloads from issuing the same
-- student twice when exclusion is enabled.
-- Idempotent: release upgrades re-apply this file.

CREATE TABLE IF NOT EXISTS public.exam_hall_ticket_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
    class_section_id UUID NOT NULL REFERENCES public.class_sections(id) ON DELETE RESTRICT,
    min_clearance_percent NUMERIC(5,2) NOT NULL,
    max_clearance_percent NUMERIC(5,2) NOT NULL,
    exclude_previously_downloaded BOOLEAN NOT NULL DEFAULT TRUE,
    tickets_per_page SMALLINT NOT NULL DEFAULT 4,
    show_roll_numbers BOOLEAN NOT NULL DEFAULT FALSE,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    student_count INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_eht_batch_range CHECK (
        min_clearance_percent >= 0
        AND min_clearance_percent <= 100
        AND max_clearance_percent >= 0
        AND max_clearance_percent <= 100
        AND min_clearance_percent <= max_clearance_percent
    ),
    CONSTRAINT chk_eht_batch_status CHECK (
        status IN ('prepared', 'completed', 'failed', 'expired')
    ),
    CONSTRAINT chk_eht_batch_student_count CHECK (student_count >= 0),
    CONSTRAINT chk_eht_batch_tickets_per_page CHECK (tickets_per_page IN (2, 3, 4))
);

ALTER TABLE public.exam_hall_ticket_batches
    ADD COLUMN IF NOT EXISTS tickets_per_page SMALLINT NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS show_roll_numbers BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.exam_hall_ticket_batch_students (
    batch_id UUID NOT NULL REFERENCES public.exam_hall_ticket_batches(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE RESTRICT,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    payable_amount NUMERIC(12,2) NOT NULL,
    paid_amount NUMERIC(12,2) NOT NULL,
    clearance_percent NUMERIC(5,2) NOT NULL,
    no_fee_record BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, student_id),
    CONSTRAINT chk_eht_batch_student_amounts CHECK (
        payable_amount >= 0
        AND paid_amount >= 0
        AND clearance_percent >= 0
        AND clearance_percent <= 100
    )
);

CREATE INDEX IF NOT EXISTS idx_eht_batches_exam_status
    ON public.exam_hall_ticket_batches (school_id, exam_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_eht_batches_recent_completed
    ON public.exam_hall_ticket_batches (school_id, exam_id, class_section_id, completed_at DESC)
    WHERE status = 'completed';

CREATE INDEX IF NOT EXISTS idx_eht_batch_students_history
    ON public.exam_hall_ticket_batch_students (school_id, student_id, batch_id);

DROP TRIGGER IF EXISTS trg_eht_batches_updated ON public.exam_hall_ticket_batches;
CREATE TRIGGER trg_eht_batches_updated
BEFORE UPDATE ON public.exam_hall_ticket_batches
FOR EACH ROW EXECUTE FUNCTION public.update_timestamp();

ALTER TABLE public.exam_hall_ticket_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_hall_ticket_batch_students ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE public.exam_hall_ticket_batches TO postgres;
GRANT ALL ON TABLE public.exam_hall_ticket_batch_students TO postgres;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT ALL ON TABLE public.exam_hall_ticket_batches TO service_role;
        GRANT ALL ON TABLE public.exam_hall_ticket_batch_students TO service_role;
    END IF;
END $$;

DROP POLICY IF EXISTS "Tenant isolation: read own school" ON public.exam_hall_ticket_batches;
CREATE POLICY "Tenant isolation: read own school" ON public.exam_hall_ticket_batches
FOR SELECT
USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (school_id = public.auth_school_id())
);

DROP POLICY IF EXISTS "Tenant isolation: admin manage own school" ON public.exam_hall_ticket_batches;
CREATE POLICY "Tenant isolation: admin manage own school" ON public.exam_hall_ticket_batches
FOR ALL
USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (school_id = public.auth_school_id() AND public.auth_has_role(ARRAY['admin']))
)
WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (school_id = public.auth_school_id() AND public.auth_has_role(ARRAY['admin']))
);

DROP POLICY IF EXISTS "Tenant isolation: read own school" ON public.exam_hall_ticket_batch_students;
CREATE POLICY "Tenant isolation: read own school" ON public.exam_hall_ticket_batch_students
FOR SELECT
USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (school_id = public.auth_school_id())
);

DROP POLICY IF EXISTS "Tenant isolation: admin manage own school" ON public.exam_hall_ticket_batch_students;
CREATE POLICY "Tenant isolation: admin manage own school" ON public.exam_hall_ticket_batch_students
FOR ALL
USING (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (school_id = public.auth_school_id() AND public.auth_has_role(ARRAY['admin']))
)
WITH CHECK (
    (auth.role() = 'service_role')
    OR public.is_super_admin()
    OR (school_id = public.auth_school_id() AND public.auth_has_role(ARRAY['admin']))
);
