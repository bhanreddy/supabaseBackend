-- Migration: 20260912_v430_academic_planner_production.sql
-- Permissions, tenant RLS, diary linkage, planner settings, and conflict versions.

BEGIN;

ALTER TABLE public.academic_plan_items
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.curricula
    ADD COLUMN IF NOT EXISTS version_note TEXT;

ALTER TABLE public.diary_entries
    ADD COLUMN IF NOT EXISTS academic_plan_item_id UUID REFERENCES public.academic_plan_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_diary_entries_academic_plan_item
    ON public.diary_entries (school_id, academic_plan_item_id)
    WHERE academic_plan_item_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.academic_planner_settings (
    school_id INTEGER PRIMARY KEY REFERENCES public.schools(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    approval_mode VARCHAR(40) NOT NULL DEFAULT 'OFF'
        CHECK (approval_mode IN ('OFF', 'TEACHER_PRINCIPAL', 'TEACHER_HOD_PRINCIPAL', 'TEACHER_COORDINATOR')),
    on_track_variance NUMERIC(6, 2) NOT NULL DEFAULT -5.00,
    slight_delay_variance NUMERIC(6, 2) NOT NULL DEFAULT -15.00,
    at_risk_variance NUMERIC(6, 2) NOT NULL DEFAULT -25.00,
    delay_persist_days INTEGER NOT NULL DEFAULT 7,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.academic_planner_settings (school_id)
SELECT s.id FROM public.schools s
ON CONFLICT (school_id) DO NOTHING;

INSERT INTO public.school_settings (school_id, key, value)
SELECT s.id, 'academic_planner_enabled', 'true'
FROM public.schools s
WHERE NOT EXISTS (
    SELECT 1 FROM public.school_settings ss
    WHERE ss.school_id = s.id AND ss.key = 'academic_planner_enabled'
);

INSERT INTO public.permissions (school_id, code, name)
SELECT s.id, v.code, v.name
FROM public.schools s
CROSS JOIN (VALUES
    ('academic_planner.view', 'View Academic Planner'),
    ('academic_planner.curriculum', 'Manage Curriculum'),
    ('academic_planner.plan', 'Create and edit academic plans'),
    ('academic_planner.progress', 'Update teaching progress'),
    ('academic_planner.approve', 'Approve academic plans'),
    ('academic_planner.risk', 'View academic risks'),
    ('academic_planner.recovery', 'Manage recovery plans'),
    ('academic_planner.report', 'Export academic reports')
) AS v(code, name)
ON CONFLICT (school_id, code) DO UPDATE
SET name = EXCLUDED.name, deleted_at = NULL;

INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('admin', 'principal')
WHERE p.code LIKE 'academic_planner.%'
  AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('staff', 'teacher')
WHERE p.code IN (
    'academic_planner.view',
    'academic_planner.plan',
    'academic_planner.progress'
)
  AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

INSERT INTO public.role_permissions (school_id, role_id, permission_id)
SELECT p.school_id, r.id, p.id
FROM public.permissions p
JOIN public.roles r ON r.school_id = p.school_id AND r.code IN ('parent', 'student')
WHERE p.code = 'academic_planner.view'
  AND p.deleted_at IS NULL AND r.deleted_at IS NULL
ON CONFLICT (role_id, permission_id) DO UPDATE
SET school_id = EXCLUDED.school_id, deleted_at = NULL;

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'curricula',
        'curriculum_units',
        'curriculum_chapters',
        'curriculum_topics',
        'academic_plans',
        'academic_plan_items',
        'academic_progress_events',
        'lesson_plans',
        'academic_plan_metrics',
        'academic_risk_events',
        'academic_recovery_plans',
        'academic_plan_approvals',
        'academic_teacher_handovers',
        'academic_revision_items',
        'academic_planner_settings'
    ]
    LOOP
        IF to_regclass('public.' || tbl) IS NOT NULL THEN
            EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
            EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON public.%I', tbl, tbl);
            EXECUTE format(
                'CREATE POLICY tenant_isolation_%I ON public.%I USING (school_id = public.current_school_id()) WITH CHECK (school_id = public.current_school_id())',
                tbl, tbl
            );
        END IF;
    END LOOP;
END $$;

COMMIT;
