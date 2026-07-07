-- ============================================================
-- MULTI-TENANT MIGRATION — PART 7: ROW LEVEL SECURITY (RLS)
-- School-scoped RLS policies for all tenant tables using
-- current_setting('app.current_school_id')::INTEGER
-- ============================================================
-- PREREQUISITE: Your app/API must set the GUC before each request:
--   SET LOCAL app.current_school_id = '<school_id>';
-- or via Supabase:
--   await supabase.rpc('set_school_context', { school_id: 1 })

BEGIN;

-- ═══════════════════════════════════════════
-- Helper function to get current school_id from session context
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION current_school_id()
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_school_id', true), '')::INTEGER;
END;
$$;

-- ═══════════════════════════════════════════
-- Helper RPC for clients to set school context
-- ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION set_school_context(p_school_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM set_config('app.current_school_id', p_school_id::TEXT, true);
END;
$$;

GRANT EXECUTE ON FUNCTION current_school_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION set_school_context(INTEGER) TO authenticated, service_role;

-- ═══════════════════════════════════════════
-- Macro: Create standard tenant isolation policy
-- For each table, we create:
--   1. SELECT: school_id = current_school_id()
--   2. INSERT: school_id = current_school_id()
--   3. UPDATE: school_id = current_school_id()
--   4. DELETE: school_id = current_school_id()
-- Service role bypasses RLS automatically.
-- ═══════════════════════════════════════════

-- Helper to create tenant policies on a table
CREATE OR REPLACE FUNCTION create_tenant_rls_policy(p_table TEXT)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    policy_name TEXT;
BEGIN
    -- Enable RLS
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);

    -- SELECT
    policy_name := 'tenant_isolation_select_' || p_table;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, p_table);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT USING (school_id = current_school_id())',
        policy_name, p_table
    );

    -- INSERT
    policy_name := 'tenant_isolation_insert_' || p_table;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, p_table);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (school_id = current_school_id())',
        policy_name, p_table
    );

    -- UPDATE
    policy_name := 'tenant_isolation_update_' || p_table;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, p_table);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE USING (school_id = current_school_id())',
        policy_name, p_table
    );

    -- DELETE
    policy_name := 'tenant_isolation_delete_' || p_table;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, p_table);
    EXECUTE format(
        'CREATE POLICY %I ON %I FOR DELETE USING (school_id = current_school_id())',
        policy_name, p_table
    );
END;
$$;

-- ═══════════════════════════════════════════
-- Apply tenant RLS to ALL tables with school_id
-- ═══════════════════════════════════════════
DO $$
DECLARE
    tbl TEXT;
    tables TEXT[] := ARRAY[
        -- Reference
        'countries', 'genders', 'student_categories', 'religions',
        'blood_groups', 'relationship_types', 'staff_designations',
        -- Core
        'persons', 'person_contacts', 'roles', 'permissions',
        'role_permissions', 'users', 'user_settings', 'user_roles',
        -- Students & Academics
        'student_statuses', 'students', 'parents', 'student_parents',
        'academic_years', 'classes', 'sections', 'class_sections',
        'student_enrollments', 'daily_attendance',
        -- Staff
        'staff_statuses', 'staff', 'staff_attendance',
        -- Subjects & Timetable
        'subjects', 'class_subjects', 'periods',
        'timetable_slots', 'timetable_entries',
        -- Fees
        'fee_structures', 'student_fees', 'fee_transactions',
        'receipts', 'receipt_items',
        -- Exams
        'exams', 'exam_subjects', 'marks', 'grading_scales',
        -- Transport
        'transport_routes', 'transport_stops', 'buses', 'bus_locations',
        'trips', 'trip_stops', 'trip_stop_status',
        'bus_trip_history', 'driver_devices', 'driver_heartbeat',
        -- Hostel
        'hostel_rooms', 'hostel_allocations',
        -- Communication
        'events', 'notices', 'diary_entries', 'complaints',
        -- HR
        'leave_applications', 'staff_payroll', 'discipline_records', 'expenses',
        -- LMS
        'lms_courses', 'lms_lessons', 'lms_progress',
        'money_science_modules', 'life_values_modules', 'science_projects',
        -- Notifications
        'notification_templates', 'notification_preferences',
        'notification_events', 'notifications', 'notification_deliveries',
        'notification_audit_logs', 'notification_config',
        'notification_batches', 'notification_logs', 'user_devices',
        -- Audit & Config
        'audit_logs', 'financial_audit_logs', 'financial_policy_rules',
        'girl_safety_complaints', 'girl_safety_complaint_threads',
        'school_settings', 'admin_notifications',
        'access_requests', 'temp_access_grants',
        'feature_flags', 'ui_route_permissions'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        BEGIN
            PERFORM create_tenant_rls_policy(tbl);
            RAISE NOTICE 'Applied tenant RLS to: %', tbl;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'SKIPPED RLS for % — %', tbl, SQLERRM;
        END;
    END LOOP;
END;
$$;

-- Clean up the helper (optional — keep if you add future tables)
-- DROP FUNCTION IF EXISTS create_tenant_rls_policy(TEXT);

COMMIT;
