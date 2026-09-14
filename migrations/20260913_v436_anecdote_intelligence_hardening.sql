-- Additive hardening for Anecdote Intelligence: extra taxonomy, homework rule, outcome indexes.
BEGIN;

INSERT INTO public.anecdote_subcategories (category_id, code, name, description, is_system, sort_order)
VALUES
    ('c1111111-0004-4000-8000-000000000004', 'AWARDS', 'Awards', 'Certificates, medals, and formal awards', true, 7)
ON CONFLICT (category_id, code) DO NOTHING;

INSERT INTO public.intelligence_rules (id, school_id, rule_code, name, description, category, conditions, threshold, severity, enabled, version)
VALUES
    (
        'b1111111-0007-4000-8000-000000000007', NULL, 'HOMEWORK_CONCERN_001',
        'Repeated Homework Completion Concern',
        'Detects two or more homework-related concern observations within 30 days',
        'ACADEMIC',
        '{"category": "ACADEMIC", "subcategories": ["HOMEWORK"], "window_days": 30, "min_count": 2}'::jsonb,
        '{"count": 2, "window_days": 30}'::jsonb,
        'LEVEL_2_WATCH', true, 1
    )
ON CONFLICT (rule_code) WHERE school_id IS NULL DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_anecdote_actions_anecdote
    ON public.anecdote_actions(anecdote_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_intelligence_signals_student_type_day
    ON public.intelligence_signals(school_id, student_id, signal_type, detected_at DESC);

COMMIT;
