-- Migration: 20260914_v442_enable_school1_omr_override.sql
-- Description: Grant School 1 (Geethanjali High School / Default School) active override entitlement for OMR scanner.

INSERT INTO public.school_feature_overrides (school_id, feature_key, enabled, reason)
VALUES (1, 'omr_scanner', true, 'Full access to OMR Evaluation for School 1')
ON CONFLICT (school_id, feature_key) DO UPDATE SET enabled = true, reason = 'Full access to OMR Evaluation for School 1';
