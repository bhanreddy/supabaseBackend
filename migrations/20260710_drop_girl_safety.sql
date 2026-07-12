-- ============================================================================
-- 20260710_drop_girl_safety.sql
-- Remove the Girl Safety feature completely.
--   • Drops the girl_safety_complaints / girl_safety_complaint_threads tables
--     (CASCADE also removes their indexes, FKs and RLS policies).
--   • Clears any per-school feature-flag overrides for 'menu.girl_safety'.
-- Historical notification_logs rows (event_type GIRL_SAFETY_*) are intentionally
-- left untouched as an immutable audit trail.
-- ============================================================================

-- Threads reference complaints; drop child first (CASCADE makes order moot).
DROP TABLE IF EXISTS public.girl_safety_complaint_threads CASCADE;
DROP TABLE IF EXISTS public.girl_safety_complaints CASCADE;

-- Remove feature-flag overrides so the retired key stops appearing in admin UIs.
DELETE FROM public.school_feature_flags WHERE feature_key = 'menu.girl_safety';
