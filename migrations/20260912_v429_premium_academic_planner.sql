-- Migration: 20260912_v429_premium_academic_planner.sql
-- SchoolIMS Premium Academic Planner & Curriculum Execution System
-- Full multi-tenant schema with strict school_id isolation

BEGIN;

-- 1. Curricula (Curriculum Header: Class + Subject + Academic Year + Version)
CREATE TABLE IF NOT EXISTS public.curricula (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES public.academic_years(id) ON DELETE CASCADE,
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
    description TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_curricula_version
ON public.curricula(school_id, academic_year_id, class_id, subject_id, version)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_curricula_lookup
ON public.curricula(school_id, class_id, subject_id, status)
WHERE deleted_at IS NULL;

-- 2. Curriculum Units
CREATE TABLE IF NOT EXISTS public.curriculum_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    curriculum_id UUID NOT NULL REFERENCES public.curricula(id) ON DELETE CASCADE,
    term_id UUID REFERENCES public.academic_terms(id) ON DELETE SET NULL,
    title VARCHAR(250) NOT NULL,
    description TEXT,
    sequence INTEGER NOT NULL DEFAULT 1,
    estimated_periods INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_curriculum_units_order
ON public.curriculum_units(school_id, curriculum_id, sequence)
WHERE deleted_at IS NULL;

-- 3. Curriculum Chapters
CREATE TABLE IF NOT EXISTS public.curriculum_chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    curriculum_id UUID NOT NULL REFERENCES public.curricula(id) ON DELETE CASCADE,
    unit_id UUID REFERENCES public.curriculum_units(id) ON DELETE SET NULL,
    title VARCHAR(250) NOT NULL,
    description TEXT,
    sequence INTEGER NOT NULL DEFAULT 1,
    estimated_periods INTEGER NOT NULL DEFAULT 1,
    weight NUMERIC(6, 2) NOT NULL DEFAULT 1.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_curriculum_chapters_order
ON public.curriculum_chapters(school_id, curriculum_id, sequence)
WHERE deleted_at IS NULL;

-- 4. Curriculum Topics
CREATE TABLE IF NOT EXISTS public.curriculum_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    chapter_id UUID NOT NULL REFERENCES public.curriculum_chapters(id) ON DELETE CASCADE,
    title VARCHAR(250) NOT NULL,
    description TEXT,
    sequence INTEGER NOT NULL DEFAULT 1,
    estimated_periods INTEGER NOT NULL DEFAULT 1,
    weight NUMERIC(6, 2) NOT NULL DEFAULT 1.00,
    is_optional BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_curriculum_topics_order
ON public.curriculum_topics(school_id, chapter_id, sequence)
WHERE deleted_at IS NULL;

-- 5. Academic Plans (Teaching Execution Plan: Class + Section + Subject + Teacher)
CREATE TABLE IF NOT EXISTS public.academic_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_year_id UUID NOT NULL REFERENCES public.academic_years(id) ON DELETE CASCADE,
    term_id UUID REFERENCES public.academic_terms(id) ON DELETE SET NULL,
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    section_id UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    teacher_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    curriculum_id UUID NOT NULL REFERENCES public.curricula(id) ON DELETE RESTRICT,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'SUBMITTED', 'REVISION_REQUIRED', 'APPROVED', 'ACTIVE', 'COMPLETED', 'ARCHIVED')),
    planned_start_date DATE NOT NULL,
    planned_end_date DATE NOT NULL,
    target_completion_date DATE NOT NULL,
    revision_days INTEGER NOT NULL DEFAULT 0,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_plan_target_dates CHECK (target_completion_date >= planned_start_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_academic_plans_scope
ON public.academic_plans(school_id, academic_year_id, class_id, section_id, subject_id)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_academic_plans_teacher
ON public.academic_plans(school_id, teacher_id, status)
WHERE deleted_at IS NULL;

-- 6. Academic Plan Items (Topic-level Scheduled Items)
CREATE TABLE IF NOT EXISTS public.academic_plan_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    curriculum_topic_id UUID NOT NULL REFERENCES public.curriculum_topics(id) ON DELETE CASCADE,
    planned_start_date DATE,
    planned_end_date DATE,
    planned_periods INTEGER NOT NULL DEFAULT 1,
    sequence INTEGER NOT NULL DEFAULT 1,
    priority VARCHAR(20) NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'CRITICAL')),
    status VARCHAR(30) NOT NULL DEFAULT 'NOT_STARTED'
        CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'SKIPPED', 'DEFERRED')),
    actual_periods_consumed NUMERIC(6, 1) NOT NULL DEFAULT 0,
    completed_at DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_academic_plan_items_plan
ON public.academic_plan_items(school_id, academic_plan_id, sequence)
WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_academic_plan_items_topic
ON public.academic_plan_items(school_id, curriculum_topic_id);

-- 7. Academic Progress Events (Immutable Execution Log)
CREATE TABLE IF NOT EXISTS public.academic_progress_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    academic_plan_item_id UUID NOT NULL REFERENCES public.academic_plan_items(id) ON DELETE CASCADE,
    teacher_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    class_id UUID NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
    section_id UUID NOT NULL REFERENCES public.sections(id) ON DELETE CASCADE,
    subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    status VARCHAR(30) NOT NULL CHECK (status IN ('COMPLETED', 'PARTIALLY_COMPLETED', 'CONTINUE_NEXT_PERIOD', 'SKIPPED')),
    completion_percentage NUMERIC(5, 2) NOT NULL DEFAULT 100.00,
    periods_consumed NUMERIC(4, 1) NOT NULL DEFAULT 1.0,
    notes TEXT,
    source VARCHAR(30) NOT NULL DEFAULT 'ACADEMIC_APP'
        CHECK (source IN ('ACADEMIC_APP', 'TIMETABLE', 'DIARY', 'LESSON_PLAN', 'MANAGEMENT_OVERRIDE', 'OFFLINE_SYNC')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_academic_progress_events_plan_date
ON public.academic_progress_events(school_id, academic_plan_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_academic_progress_events_teacher_date
ON public.academic_progress_events(school_id, teacher_id, date DESC);

-- 8. Lesson Plans (Granular preparation details per plan item)
CREATE TABLE IF NOT EXISTS public.lesson_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_item_id UUID NOT NULL REFERENCES public.academic_plan_items(id) ON DELETE CASCADE,
    teacher_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    learning_objective TEXT,
    teaching_method TEXT,
    activity TEXT,
    resources TEXT,
    assessment TEXT,
    homework TEXT,
    teacher_notes TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lesson_plans_item
ON public.lesson_plans(school_id, academic_plan_item_id);

-- 9. Academic Plan Metrics (Materialized Fast Query Cache)
CREATE TABLE IF NOT EXISTS public.academic_plan_metrics (
    academic_plan_id UUID PRIMARY KEY REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    total_topics INTEGER NOT NULL DEFAULT 0,
    completed_topics INTEGER NOT NULL DEFAULT 0,
    total_estimated_periods INTEGER NOT NULL DEFAULT 0,
    consumed_periods NUMERIC(6, 1) NOT NULL DEFAULT 0,
    expected_progress NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    actual_progress NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    variance NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    current_velocity NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    required_velocity NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
    projected_completion_date DATE,
    projected_delay_days INTEGER NOT NULL DEFAULT 0,
    projected_delay_periods NUMERIC(6, 1) NOT NULL DEFAULT 0,
    health_status VARCHAR(30) NOT NULL DEFAULT 'ON_TRACK'
        CHECK (health_status IN ('AHEAD', 'ON_TRACK', 'SLIGHT_DELAY', 'AT_RISK', 'CRITICAL', 'COMPLETED')),
    last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_academic_plan_metrics_school_health
ON public.academic_plan_metrics(school_id, health_status);

-- 10. Academic Risk Events (Persistent Delay & Risk Engine)
CREATE TABLE IF NOT EXISTS public.academic_risk_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    risk_type VARCHAR(50) NOT NULL
        CHECK (risk_type IN ('SYLLABUS_DELAY', 'LOW_TEACHING_VELOCITY', 'INSUFFICIENT_REMAINING_PERIODS', 'EXAM_PROXIMITY', 'HIGH_ABSENCE_IMPACT', 'REPEATED_TOPIC_DELAY')),
    severity VARCHAR(20) NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    expected_progress NUMERIC(6, 2),
    actual_progress NUMERIC(6, 2),
    variance NUMERIC(6, 2),
    projected_completion_date DATE,
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RESOLVED', 'DISMISSED')),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_academic_risk_events_school_status
ON public.academic_risk_events(school_id, academic_plan_id, status);

-- 11. Academic Recovery Plans
CREATE TABLE IF NOT EXISTS public.academic_recovery_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    risk_event_id UUID REFERENCES public.academic_risk_events(id) ON DELETE SET NULL,
    strategy JSONB NOT NULL DEFAULT '{}'::jsonb,
    selected_option VARCHAR(50),
    expected_recovery_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'APPLIED')),
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_academic_recovery_plans_plan
ON public.academic_recovery_plans(school_id, academic_plan_id, status);

-- 12. Academic Plan Approvals
CREATE TABLE IF NOT EXISTS public.academic_plan_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUIRED')),
    remarks TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_academic_plan_approvals_plan
ON public.academic_plan_approvals(school_id, academic_plan_id, status);

-- 13. Academic Teacher Handovers (Teacher Reassignment Trail)
CREATE TABLE IF NOT EXISTS public.academic_teacher_handovers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    previous_teacher_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
    new_teacher_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
    transfer_date DATE NOT NULL DEFAULT CURRENT_DATE,
    reason TEXT,
    transferred_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_academic_teacher_handovers_plan
ON public.academic_teacher_handovers(school_id, academic_plan_id);

-- 14. Academic Revision Items (Post-completion Revision Rounds & Exam Prep)
CREATE TABLE IF NOT EXISTS public.academic_revision_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    academic_plan_id UUID NOT NULL REFERENCES public.academic_plans(id) ON DELETE CASCADE,
    curriculum_topic_id UUID REFERENCES public.curriculum_topics(id) ON DELETE SET NULL,
    revision_round INTEGER NOT NULL DEFAULT 1,
    title VARCHAR(250) NOT NULL,
    planned_periods INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'SKIPPED')),
    source VARCHAR(30) NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL', 'EXAM_RECOMMENDATION')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_academic_revision_items_plan
ON public.academic_revision_items(school_id, academic_plan_id, revision_round);

-- 15. Safe triggers for updated_at
CREATE OR REPLACE FUNCTION update_academic_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_curricula_updated ON public.curricula;
CREATE TRIGGER trg_curricula_updated BEFORE UPDATE ON public.curricula
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

DROP TRIGGER IF EXISTS trg_curriculum_units_updated ON public.curriculum_units;
CREATE TRIGGER trg_curriculum_units_updated BEFORE UPDATE ON public.curriculum_units
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

DROP TRIGGER IF EXISTS trg_curriculum_chapters_updated ON public.curriculum_chapters;
CREATE TRIGGER trg_curriculum_chapters_updated BEFORE UPDATE ON public.curriculum_chapters
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

DROP TRIGGER IF EXISTS trg_curriculum_topics_updated ON public.curriculum_topics;
CREATE TRIGGER trg_curriculum_topics_updated BEFORE UPDATE ON public.curriculum_topics
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

DROP TRIGGER IF EXISTS trg_academic_plans_updated ON public.academic_plans;
CREATE TRIGGER trg_academic_plans_updated BEFORE UPDATE ON public.academic_plans
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

DROP TRIGGER IF EXISTS trg_academic_plan_items_updated ON public.academic_plan_items;
CREATE TRIGGER trg_academic_plan_items_updated BEFORE UPDATE ON public.academic_plan_items
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

DROP TRIGGER IF EXISTS trg_academic_recovery_plans_updated ON public.academic_recovery_plans;
CREATE TRIGGER trg_academic_recovery_plans_updated BEFORE UPDATE ON public.academic_recovery_plans
FOR EACH ROW EXECUTE FUNCTION update_academic_timestamp();

COMMIT;
