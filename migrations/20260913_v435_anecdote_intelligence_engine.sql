-- Migration: 20260913_v435_anecdote_intelligence_engine.sql
-- Production-Grade Multi-Tenant Anecdote & Explainable School Intelligence Engine

BEGIN;

-- ============================================================================
-- 1. ANECDOTE TAXONOMY TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.anecdote_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE, -- NULL indicates system-wide default category
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(50) NOT NULL DEFAULT 'bookmark-outline',
    color VARCHAR(20) NOT NULL DEFAULT '#4F46E5',
    is_system BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_anecdote_category_system_code
    ON public.anecdote_categories(code)
    WHERE school_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_anecdote_category_school_code
    ON public.anecdote_categories(school_id, code)
    WHERE school_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.anecdote_subcategories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES public.anecdote_categories(id) ON DELETE CASCADE,
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_anecdote_subcategory_code UNIQUE (category_id, code)
);

CREATE INDEX IF NOT EXISTS idx_anecdote_subcategories_category ON public.anecdote_subcategories(category_id, sort_order);

-- ============================================================================
-- 2. ANECDOTES CORE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.anecdotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    class_section_id UUID REFERENCES public.class_sections(id) ON DELETE SET NULL,
    title VARCHAR(200),
    observation_text TEXT NOT NULL,
    context VARCHAR(50) NOT NULL DEFAULT 'classroom',
    observation_type VARCHAR(30) NOT NULL DEFAULT 'OBSERVATION',
    category_id UUID REFERENCES public.anecdote_categories(id) ON DELETE SET NULL,
    subcategory_id UUID REFERENCES public.anecdote_subcategories(id) ON DELETE SET NULL,
    sentiment VARCHAR(20) NOT NULL DEFAULT 'NEUTRAL',
    severity VARCHAR(30) NOT NULL DEFAULT 'LEVEL_0_INFORMATIONAL',
    visibility VARCHAR(30) NOT NULL DEFAULT 'STAFF_ONLY',
    status VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED',
    inferred_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    client_generated_id UUID,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT chk_anecdote_context CHECK (
        context IN ('classroom', 'playground', 'laboratory', 'corridor', 'sports_field', 'bus', 'cafeteria', 'assembly', 'online', 'other')
    ),
    CONSTRAINT chk_anecdote_type CHECK (
        observation_type IN ('OBSERVATION', 'RECOGNITION', 'IMPROVEMENT', 'CONCERN', 'INCIDENT', 'ACHIEVEMENT')
    ),
    CONSTRAINT chk_anecdote_sentiment CHECK (
        sentiment IN ('POSITIVE', 'NEUTRAL', 'ATTENTION', 'CONCERN', 'ACHIEVEMENT')
    ),
    CONSTRAINT chk_anecdote_severity CHECK (
        severity IN ('LEVEL_0_INFORMATIONAL', 'LEVEL_1_POSITIVE', 'LEVEL_2_WATCH', 'LEVEL_3_ATTENTION', 'LEVEL_4_CRITICAL')
    ),
    CONSTRAINT chk_anecdote_visibility CHECK (
        visibility IN ('STAFF_ONLY', 'COORDINATOR_ONLY', 'SCHOOL_ADMIN', 'PARENT_VISIBLE', 'STUDENT_VISIBLE')
    ),
    CONSTRAINT chk_anecdote_status CHECK (
        status IN ('DRAFT', 'SUBMITTED', 'CLASSIFIED', 'PROCESSED', 'ACTIVE', 'FOLLOW_UP_REQUIRED', 'RESOLVED', 'ARCHIVED')
    )
);

CREATE INDEX IF NOT EXISTS idx_anecdotes_school_student ON public.anecdotes(school_id, student_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_anecdotes_school_observed ON public.anecdotes(school_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_anecdotes_school_severity ON public.anecdotes(school_id, severity) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anecdotes_school_status ON public.anecdotes(school_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anecdotes_school_category ON public.anecdotes(school_id, category_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_anecdotes_active ON public.anecdotes(id) WHERE deleted_at IS NULL;

-- Offline Idempotency Index
CREATE UNIQUE INDEX IF NOT EXISTS uq_anecdotes_client_id 
    ON public.anecdotes(school_id, client_generated_id)
    WHERE client_generated_id IS NOT NULL AND deleted_at IS NULL;

-- ============================================================================
-- 3. ANECDOTE ASSOCIATIONS & ATTACHMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.anecdote_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    anecdote_id UUID NOT NULL REFERENCES public.anecdotes(id) ON DELETE CASCADE,
    tag_name VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_anecdote_tag UNIQUE (anecdote_id, tag_name)
);

CREATE INDEX IF NOT EXISTS idx_anecdote_tags_school_tag ON public.anecdote_tags(school_id, tag_name);

CREATE TABLE IF NOT EXISTS public.anecdote_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    anecdote_id UUID NOT NULL REFERENCES public.anecdotes(id) ON DELETE CASCADE,
    evidence_type VARCHAR(30) NOT NULL, -- 'photo', 'document', 'note', 'url', 'record_reference'
    file_url TEXT,
    storage_path TEXT,
    file_name VARCHAR(255),
    file_size INTEGER,
    mime_type VARCHAR(100),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_anecdote_evidence_type CHECK (
        evidence_type IN ('photo', 'document', 'note', 'url', 'record_reference')
    )
);

CREATE INDEX IF NOT EXISTS idx_anecdote_evidence_anecdote ON public.anecdote_evidence(anecdote_id);

CREATE TABLE IF NOT EXISTS public.anecdote_followups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    anecdote_id UUID NOT NULL REFERENCES public.anecdotes(id) ON DELETE CASCADE,
    assigned_to_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    due_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    notes TEXT,
    completed_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_anecdote_followup_status CHECK (
        status IN ('PENDING', 'COMPLETED', 'CANCELLED')
    )
);

CREATE INDEX IF NOT EXISTS idx_anecdote_followups_due ON public.anecdote_followups(school_id, due_date, status);

CREATE TABLE IF NOT EXISTS public.anecdote_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    anecdote_id UUID NOT NULL REFERENCES public.anecdotes(id) ON DELETE CASCADE,
    action_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
    due_date DATE,
    completed_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.anecdote_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    anecdote_id UUID NOT NULL REFERENCES public.anecdotes(id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL,
    changed_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    new_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    performed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anecdote_audit_logs_anecdote ON public.anecdote_audit_logs(anecdote_id, created_at DESC);

-- ============================================================================
-- 4. INTELLIGENCE RULES ENGINE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE, -- NULL indicates global standard rule
    rule_code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50) NOT NULL,
    conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
    threshold JSONB NOT NULL DEFAULT '{}'::jsonb,
    severity VARCHAR(30) NOT NULL DEFAULT 'LEVEL_2_WATCH',
    enabled BOOLEAN NOT NULL DEFAULT true,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_rule_system_code
    ON public.intelligence_rules(rule_code)
    WHERE school_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intelligence_rule_school_code
    ON public.intelligence_rules(school_id, rule_code)
    WHERE school_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.intelligence_rule_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id UUID NOT NULL REFERENCES public.intelligence_rules(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    conditions JSONB NOT NULL,
    changes_summary TEXT,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_rule_version UNIQUE (rule_id, version)
);

-- ============================================================================
-- 5. SIGNALS, PATTERNS & EXPLAINABLE INSIGHTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intelligence_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    signal_type VARCHAR(50) NOT NULL,
    source_module VARCHAR(30) NOT NULL,
    severity VARCHAR(30) NOT NULL DEFAULT 'LEVEL_0_INFORMATIONAL',
    confidence VARCHAR(20) NOT NULL DEFAULT 'MODERATE',
    value_numeric NUMERIC(8,2),
    baseline_value NUMERIC(8,2),
    delta_percentage NUMERIC(8,2),
    window_days INTEGER NOT NULL DEFAULT 30,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_signals_student_time ON public.intelligence_signals(school_id, student_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_type ON public.intelligence_signals(school_id, signal_type, detected_at DESC);

CREATE TABLE IF NOT EXISTS public.intelligence_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    pattern_type VARCHAR(50) NOT NULL,
    name VARCHAR(150) NOT NULL,
    description TEXT NOT NULL,
    supporting_signal_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    frequency_count INTEGER NOT NULL DEFAULT 1,
    window_start TIMESTAMPTZ,
    window_end TIMESTAMPTZ,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_patterns_student ON public.intelligence_patterns(school_id, student_id, detected_at DESC);

CREATE TABLE IF NOT EXISTS public.intelligence_insights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    class_section_id UUID REFERENCES public.class_sections(id) ON DELETE SET NULL,
    title VARCHAR(200) NOT NULL,
    summary TEXT NOT NULL,
    insight_type VARCHAR(30) NOT NULL,
    confidence VARCHAR(20) NOT NULL DEFAULT 'MODERATE',
    rule_id UUID REFERENCES public.intelligence_rules(id) ON DELETE SET NULL,
    rule_code VARCHAR(50),
    rule_version INTEGER NOT NULL DEFAULT 1,
    supporting_signal_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    supporting_anecdote_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    parent_visible BOOLEAN NOT NULL DEFAULT false,
    review_due_date DATE,
    reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    dismissed_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_insight_type CHECK (
        insight_type IN ('GROWTH', 'STRENGTH', 'WATCH', 'ATTENTION', 'CRITICAL_REVIEW')
    ),
    CONSTRAINT chk_insight_confidence CHECK (
        confidence IN ('LOW', 'MODERATE', 'HIGH')
    ),
    CONSTRAINT chk_insight_status CHECK (
        status IN ('ACTIVE', 'ACKNOWLEDGED', 'INTERVENTION_IN_PROGRESS', 'RESOLVED', 'DISMISSED')
    )
);

CREATE INDEX IF NOT EXISTS idx_insights_student_status ON public.intelligence_insights(school_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_insights_class ON public.intelligence_insights(school_id, class_section_id, status);
CREATE INDEX IF NOT EXISTS idx_insights_school_type ON public.intelligence_insights(school_id, insight_type, status);

CREATE TABLE IF NOT EXISTS public.intelligence_explanations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_id UUID NOT NULL REFERENCES public.intelligence_insights(id) ON DELETE CASCADE,
    explanation_text TEXT NOT NULL,
    bullet_points JSONB NOT NULL DEFAULT '[]'::jsonb,
    baseline_comparison JSONB NOT NULL DEFAULT '{}'::jsonb,
    data_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_explanations_insight ON public.intelligence_explanations(insight_id);

-- ============================================================================
-- 6. STUDENT INTELLIGENCE PROFILES & ROLLING BASELINES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.student_intelligence_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    status_tier VARCHAR(20) NOT NULL DEFAULT 'STABLE',
    attendance_rate_30d NUMERIC(5,2),
    assessment_avg_recent NUMERIC(5,2),
    homework_completion_rate NUMERIC(5,2),
    total_anecdotes_positive INTEGER NOT NULL DEFAULT 0,
    total_anecdotes_concern INTEGER NOT NULL DEFAULT 0,
    active_insights_count INTEGER NOT NULL DEFAULT 0,
    active_interventions_count INTEGER NOT NULL DEFAULT 0,
    last_evaluated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_student_intelligence_profile UNIQUE (school_id, student_id),
    CONSTRAINT chk_profile_status_tier CHECK (
        status_tier IN ('STABLE', 'WATCH', 'ATTENTION', 'GROWTH')
    )
);

CREATE INDEX IF NOT EXISTS idx_profiles_school_tier ON public.student_intelligence_profiles(school_id, status_tier);

CREATE TABLE IF NOT EXISTS public.student_intelligence_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    metric_key VARCHAR(50) NOT NULL,
    metric_value NUMERIC(8,2) NOT NULL,
    period_type VARCHAR(20) NOT NULL DEFAULT '30d',
    calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_student_metric_period UNIQUE (school_id, student_id, metric_key, period_type)
);

-- ============================================================================
-- 7. INTERVENTIONS & OUTCOMES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.student_interventions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
    insight_id UUID REFERENCES public.intelligence_insights(id) ON DELETE SET NULL,
    signal_id UUID REFERENCES public.intelligence_signals(id) ON DELETE SET NULL,
    created_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action_type VARCHAR(50) NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    start_date DATE NOT NULL DEFAULT current_date,
    target_date DATE,
    follow_up_date DATE,
    status VARCHAR(30) NOT NULL DEFAULT 'RECOMMENDED',
    outcome_status VARCHAR(30),
    outcome_notes TEXT,
    baseline_metric JSONB NOT NULL DEFAULT '{}'::jsonb,
    outcome_metric JSONB NOT NULL DEFAULT '{}'::jsonb,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_intervention_action_type CHECK (
        action_type IN ('TEACHER_REVIEW', 'ADDITIONAL_PRACTICE', 'PARENT_COMMUNICATION', 'COUNSELING_SUPPORT', 'PEER_MENTORING', 'SEATING_CHANGE', 'BEHAVIOUR_CONTRACT', 'CUSTOM')
    ),
    CONSTRAINT chk_intervention_status CHECK (
        status IN ('RECOMMENDED', 'ACCEPTED', 'IN_PROGRESS', 'FOLLOW_UP', 'COMPLETED', 'OUTCOME_RECORDED', 'CANCELLED')
    ),
    CONSTRAINT chk_intervention_outcome_status CHECK (
        outcome_status IS NULL OR outcome_status IN ('EFFECTIVE', 'PARTIALLY_EFFECTIVE', 'INEFFECTIVE', 'INCONCLUSIVE')
    )
);

CREATE INDEX IF NOT EXISTS idx_interventions_student ON public.student_interventions(school_id, student_id, status);
CREATE INDEX IF NOT EXISTS idx_interventions_followup ON public.student_interventions(school_id, follow_up_date, status);

CREATE TABLE IF NOT EXISTS public.anecdote_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    school_id INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    anecdote_id UUID REFERENCES public.anecdotes(id) ON DELETE CASCADE,
    intervention_id UUID REFERENCES public.student_interventions(id) ON DELETE CASCADE,
    before_metric JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_metric JSONB NOT NULL DEFAULT '{}'::jsonb,
    outcome_status VARCHAR(30) NOT NULL DEFAULT 'INCONCLUSIVE',
    notes TEXT,
    recorded_by UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_anecdote_outcome_status CHECK (
        outcome_status IN ('EFFECTIVE', 'PARTIALLY_EFFECTIVE', 'INEFFECTIVE', 'INCONCLUSIVE')
    )
);

CREATE INDEX IF NOT EXISTS idx_anecdote_outcomes_school ON public.anecdote_outcomes(school_id, recorded_at DESC);

-- ============================================================================
-- 8. SEED SYSTEM TAXONOMY (ACADEMIC, BEHAVIOUR, SOCIAL, ACHIEVEMENT, ATTENDANCE, PARTICIPATION)
-- ============================================================================

INSERT INTO public.anecdote_categories (id, school_id, code, name, description, icon, color, is_system, sort_order)
VALUES
    ('c1111111-0001-4000-8000-000000000001', NULL, 'ACADEMIC', 'Academic', 'Classwork, concept mastery, homework, and learning progress', 'book-outline', '#2563EB', true, 1),
    ('c1111111-0002-4000-8000-000000000002', NULL, 'BEHAVIOUR', 'Behaviour', 'Discipline, responsibility, respect, and classroom conduct', 'shield-outline', '#EA580C', true, 2),
    ('c1111111-0003-4000-8000-000000000003', NULL, 'SOCIAL', 'Social & Emotional', 'Peer support, collaboration, empathy, and leadership', 'heart-outline', '#0D9488', true, 3),
    ('c1111111-0004-4000-8000-000000000004', NULL, 'ACHIEVEMENT', 'Achievement', 'Competitions, arts, sports, and school representation', 'trophy-outline', '#F59E0B', true, 4),
    ('c1111111-0005-4000-8000-000000000005', NULL, 'ATTENDANCE', 'Attendance', 'Punctuality, absences, and attendance patterns', 'calendar-outline', '#9333EA', true, 5),
    ('c1111111-0006-4000-8000-000000000006', NULL, 'PARTICIPATION', 'Participation', 'Class engagement, school events, and co-curriculars', 'sparkles-outline', '#0284C7', true, 6)
ON CONFLICT (code) WHERE school_id IS NULL DO NOTHING;

-- Seed Subcategories
INSERT INTO public.anecdote_subcategories (category_id, code, name, description, is_system, sort_order)
VALUES
    -- Academic
    ('c1111111-0001-4000-8000-000000000001', 'ACAD_PERFORMANCE', 'Academic Performance', 'Assessment and test results performance', true, 1),
    ('c1111111-0001-4000-8000-000000000001', 'LEARNING_PROGRESS', 'Learning Progress', 'Growth in understanding complex concepts', true, 2),
    ('c1111111-0001-4000-8000-000000000001', 'HOMEWORK', 'Homework', 'Homework completion, timeliness, and effort', true, 3),
    ('c1111111-0001-4000-8000-000000000001', 'CLASSWORK', 'Classwork', 'Daily notes, notebook maintenance, and exercise completion', true, 4),
    ('c1111111-0001-4000-8000-000000000001', 'SUBJECT_ENGAGEMENT', 'Subject Engagement', 'Enthusiasm and active interest in specific subjects', true, 5),
    ('c1111111-0001-4000-8000-000000000001', 'CONCEPT_MASTERY', 'Concept Mastery', 'Exemplary grasp of core fundamentals', true, 6),
    ('c1111111-0001-4000-8000-000000000001', 'ACAD_IMPROVEMENT', 'Academic Improvement', 'Measurable improvement after feedback or extra help', true, 7),
    ('c1111111-0001-4000-8000-000000000001', 'ACAD_CONCERN', 'Academic Concern', 'Struggling with subject matter or consecutive difficulties', true, 8),

    -- Behaviour
    ('c1111111-0002-4000-8000-000000000002', 'DISCIPLINE', 'Discipline', 'Following school rules and maintaining order', true, 1),
    ('c1111111-0002-4000-8000-000000000002', 'RESPONSIBILITY', 'Responsibility', 'Taking ownership of assigned duties and belongings', true, 2),
    ('c1111111-0002-4000-8000-000000000002', 'RESPECT', 'Respect', 'Courteous interaction with staff and peers', true, 3),
    ('c1111111-0002-4000-8000-000000000002', 'CLASSROOM_CONDUCT', 'Classroom Conduct', 'Focus, listening, and maintaining decorum in class', true, 4),
    ('c1111111-0002-4000-8000-000000000002', 'RULE_COMPLIANCE', 'Rule Compliance', 'Adherence to uniform, schedule, and school policies', true, 5),
    ('c1111111-0002-4000-8000-000000000002', 'CONFLICT', 'Conflict', 'Interpersonal dispute or disagreement', true, 6),
    ('c1111111-0002-4000-8000-000000000002', 'DISRUPTION', 'Disruption', 'Distracting others or interrupting instruction', true, 7),
    ('c1111111-0002-4000-8000-000000000002', 'COOPERATION', 'Cooperation', 'Willingness to work with instructions and class group', true, 8),

    -- Social & Emotional
    ('c1111111-0003-4000-8000-000000000003', 'LEADERSHIP', 'Leadership', 'Guiding peers and demonstrating positive initiative', true, 1),
    ('c1111111-0003-4000-8000-000000000003', 'TEAMWORK', 'Teamwork', 'Effective collaboration during group assignments', true, 2),
    ('c1111111-0003-4000-8000-000000000003', 'COMMUNICATION', 'Communication', 'Clear expression of ideas and active listening', true, 3),
    ('c1111111-0003-4000-8000-000000000003', 'PEER_SUPPORT', 'Peer Support', 'Assisting classmates with studies or emotional encouragement', true, 4),
    ('c1111111-0003-4000-8000-000000000003', 'COLLABORATION', 'Collaboration', 'Productive co-creation with fellow students', true, 5),
    ('c1111111-0003-4000-8000-000000000003', 'INCLUSIVENESS', 'Inclusiveness', 'Welcoming diverse peers and promoting belonging', true, 6),

    -- Achievement
    ('c1111111-0004-4000-8000-000000000004', 'COMPETITION', 'Competition', 'Olympiads, quizzes, and inter-school contests', true, 1),
    ('c1111111-0004-4000-8000-000000000004', 'SPORTS', 'Sports & Athletics', 'Outstanding performance in games and sports meets', true, 2),
    ('c1111111-0004-4000-8000-000000000004', 'ARTS', 'Arts & Culture', 'Excellence in drawing, music, dance, or drama', true, 3),
    ('c1111111-0004-4000-8000-000000000004', 'ACAD_ACHIEVEMENT', 'Academic Achievement', 'Top rank or distinction in exams', true, 4),
    ('c1111111-0004-4000-8000-000000000004', 'SCHOOL_REPRESENTATION', 'School Representation', 'Representing school at district/state/national level', true, 5),
    ('c1111111-0004-4000-8000-000000000004', 'SPECIAL_RECOGNITION', 'Special Recognition', 'Principal badge or formal commendation', true, 6),

    -- Attendance
    ('c1111111-0005-4000-8000-000000000005', 'ABSENCE', 'Absence', 'Single or occasional unplanned absence', true, 1),
    ('c1111111-0005-4000-8000-000000000005', 'LATE_ARRIVAL', 'Late Arrival', 'Arriving past morning reporting time', true, 2),
    ('c1111111-0005-4000-8000-000000000005', 'REPEATED_ABSENCE', 'Repeated Absence', 'Multiple absences impacting learning continuity', true, 3),
    ('c1111111-0005-4000-8000-000000000005', 'ATTENDANCE_IMPROVEMENT', 'Attendance Improvement', 'Noticeable improvement in daily consistency', true, 4),
    ('c1111111-0005-4000-8000-000000000005', 'ATTENDANCE_CONCERN', 'Attendance Concern', 'Attendance falling below required academic threshold', true, 5),

    -- Participation
    ('c1111111-0006-4000-8000-000000000006', 'CLASS_PARTICIPATION', 'Class Participation', 'Raising hand, answering questions, joining discussions', true, 1),
    ('c1111111-0006-4000-8000-000000000006', 'EVENT_PARTICIPATION', 'Event Participation', 'Taking part in school annual day, science fair, etc.', true, 2),
    ('c1111111-0006-4000-8000-000000000006', 'ACTIVITY_PARTICIPATION', 'Activity Participation', 'Participation in club and house activities', true, 3),
    ('c1111111-0006-4000-8000-000000000006', 'LEADERSHIP_PARTICIPATION', 'Leadership Participation', 'Class monitor or event coordinator role', true, 4)
ON CONFLICT (category_id, code) DO NOTHING;

-- ============================================================================
-- 9. SEED CORE SYSTEM INTELLIGENCE RULES
-- ============================================================================

INSERT INTO public.intelligence_rules (id, school_id, rule_code, name, description, category, conditions, threshold, severity, enabled, version)
VALUES
    (
        'b1111111-0001-4000-8000-000000000001', NULL, 'BEHAVIOUR_RECURRENCE_001',
        'Recurring Behaviour Pattern',
        'Detects repeated behaviour observations within a 21-day sliding window',
        'BEHAVIOUR',
        '{"category": "BEHAVIOUR", "window_days": 21, "min_count": 3}'::jsonb,
        '{"count": 3, "window_days": 21}'::jsonb,
        'LEVEL_2_WATCH', true, 1
    ),
    (
        'b1111111-0002-4000-8000-000000000002', NULL, 'ACADEMIC_DECLINE_001',
        'Consecutive Academic Assessment Decline',
        'Detects score decline across 3 consecutive assessments or > 12% drop below personal baseline',
        'ACADEMIC',
        '{"consecutive_drops": 3, "baseline_drop_pct": 12, "window_days": 60}'::jsonb,
        '{"consecutive_drops": 3, "percentage": 12}'::jsonb,
        'LEVEL_3_ATTENTION', true, 1
    ),
    (
        'b1111111-0003-4000-8000-000000000003', NULL, 'POSITIVE_LEADERSHIP_001',
        'Emerging Leadership & Social Strength',
        'Identifies students with 3 or more positive leadership or peer support observations within 60 days',
        'SOCIAL',
        '{"category": "SOCIAL", "subcategories": ["LEADERSHIP", "PEER_SUPPORT"], "window_days": 60, "min_count": 3}'::jsonb,
        '{"count": 3, "window_days": 60}'::jsonb,
        'LEVEL_1_POSITIVE', true, 1
    ),
    (
        'b1111111-0004-4000-8000-000000000004', NULL, 'ATTENDANCE_DROP_001',
        'Meaningful Attendance Deviation',
        'Detects attendance rate dropping 10% or more below student personal baseline over 14 days',
        'ATTENDANCE',
        '{"baseline_drop_pct": 10, "window_days": 14}'::jsonb,
        '{"percentage": 10, "window_days": 14}'::jsonb,
        'LEVEL_2_WATCH', true, 1
    ),
    (
        'b1111111-0005-4000-8000-000000000005', NULL, 'ACADEMIC_GROWTH_001',
        'Positive Academic Acceleration',
        'Recognizes score improvement across 3 consecutive assessments or > 10% rise above personal baseline',
        'ACADEMIC',
        '{"consecutive_gains": 3, "baseline_gain_pct": 10, "window_days": 60}'::jsonb,
        '{"consecutive_gains": 3, "percentage": 10}'::jsonb,
        'LEVEL_1_POSITIVE', true, 1
    ),
    (
        'b1111111-0006-4000-8000-000000000006', NULL, 'CROSS_MODULE_CONCERN_001',
        'Multi-Domain Convergence Signal',
        'Correlates attendance drop, homework incomplete pattern, and academic score decrease within the same 30-day window',
        'CROSS_MODULE',
        '{"required_modules": ["ATTENDANCE", "ACADEMIC"], "secondary_modules": ["DIARY", "ANECDOTE"], "window_days": 30}'::jsonb,
        '{"modules_count": 2, "window_days": 30}'::jsonb,
        'LEVEL_3_ATTENTION', true, 1
    )
ON CONFLICT (rule_code) WHERE school_id IS NULL DO NOTHING;

COMMIT;
