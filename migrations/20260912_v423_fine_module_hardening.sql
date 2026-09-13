-- Migration: 20260912_v423_fine_module_hardening.sql
-- Completes Fine, Penalty & Adjustment RBAC, adjustments, warning idempotency, and RLS.

BEGIN;

-- 1. Immutable posted-amount adjustments (late-fee growth, corrections)
CREATE TABLE IF NOT EXISTS public.fine_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    fine_id UUID NOT NULL REFERENCES public.fines(id) ON DELETE RESTRICT,
    amount DECIMAL(12,2) NOT NULL,
    reason TEXT NOT NULL,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_fine_adjustments_amount CHECK (amount <> 0)
);

CREATE INDEX IF NOT EXISTS idx_fine_adjustments_school_fine
    ON public.fine_adjustments(school_id, fine_id, created_at DESC);

-- 2. Idempotent late-fee warnings (one warning per invoice per calendar day)
CREATE TABLE IF NOT EXISTS public.fine_warning_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    student_fee_id UUID NOT NULL,
    policy_id UUID REFERENCES public.fine_policies(id) ON DELETE SET NULL,
    warning_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fine_warning_events_day
    ON public.fine_warning_events(school_id, student_fee_id, warning_date);

-- 3. Deduplicate default policies then enforce uniqueness
DELETE FROM public.fine_policies a
USING public.fine_policies b
WHERE a.ctid > b.ctid
  AND a.school_id = b.school_id
  AND a.category_id = b.category_id
  AND LOWER(a.name) = LOWER(b.name);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fine_policies_school_category_name
    ON public.fine_policies(school_id, category_id, LOWER(name));

-- 4. RBAC permissions
INSERT INTO permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM schools s
CROSS JOIN (VALUES
    ('fine.view', 'View fines, penalties and adjustments'),
    ('fine.create', 'Create and post fines'),
    ('fine.request', 'Request a fine for approval'),
    ('fine.approve', 'Approve or reject fine requests'),
    ('fine.waive', 'Waive fines in full or part'),
    ('fine.cancel', 'Cancel invalid fines'),
    ('fine.collect', 'Collect fine payments'),
    ('fine.dispute_review', 'Review parent fine disputes'),
    ('fine.policy_manage', 'Manage fine categories and policies'),
    ('fine.report_view', 'View fine reports and analytics'),
    ('fine.export', 'Export fine reports')
) AS v(code, name)
ON CONFLICT (school_id, code) DO UPDATE
SET name = EXCLUDED.name, deleted_at = NULL;

-- Teachers / staff: request only. Own requests are readable via requested_by scope.
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('teacher', 'staff')
 AND r.deleted_at IS NULL
WHERE p.code = 'fine.request'
  AND p.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- Accounts
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('accounts', 'accountant')
 AND r.deleted_at IS NULL
WHERE p.code IN (
    'fine.view', 'fine.create', 'fine.approve', 'fine.collect',
    'fine.report_view', 'fine.export', 'fine.dispute_review'
  )
  AND p.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- Admin / principal / management
INSERT INTO role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM permissions p
JOIN roles r
  ON r.school_id = p.school_id
 AND r.code IN ('admin', 'principal', 'management')
 AND r.deleted_at IS NULL
WHERE p.code LIKE 'fine.%'
  AND p.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

-- 5. Row-level security
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fine_categories',
    'fine_policies',
    'fines',
    'fine_waivers',
    'fine_disputes',
    'fine_payments',
    'fine_attachments',
    'fine_adjustments',
    'fine_warning_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant_all ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_tenant_all ON public.%I
         FOR ALL TO authenticated
         USING (
           auth.role() = ''service_role''
           OR public.is_super_admin()
           OR school_id = public.auth_school_id()
         )
         WITH CHECK (
           auth.role() = ''service_role''
           OR public.is_super_admin()
           OR school_id = public.auth_school_id()
         )',
      t, t
    );
  END LOOP;
END $$;

COMMIT;
