\set ON_ERROR_STOP on

BEGIN;

-- Check each condition independently
SELECT 1 FROM events WHERE school_id = current_school_id() LIMIT 1;
SELECT 1 FROM events WHERE is_public = true LIMIT 1;
SELECT 1 FROM events WHERE created_by = auth.uid() LIMIT 1;
SELECT 1 FROM events WHERE target_audience = 'all'::notice_audience_enum LIMIT 1;
SELECT 1 FROM events WHERE auth.role() = 'authenticated' LIMIT 1;
SELECT 1 FROM events WHERE target_audience = 'staff'::notice_audience_enum LIMIT 1;
SELECT 1 FROM events WHERE auth_has_role(ARRAY['admin', 'teacher', 'staff', 'accounts']) LIMIT 1;

ROLLBACK;
