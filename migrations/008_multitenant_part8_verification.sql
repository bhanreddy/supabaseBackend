-- ============================================================
-- MULTI-TENANT MIGRATION — PART 8: VERIFICATION QUERIES
-- Run these AFTER all migration parts to validate correctness.
-- ============================================================

-- ═══════════════════════════════════════════
-- 1. CHECK: All tables have school_id NOT NULL
-- Expected: 0 rows (no tables missing school_id)
-- ═══════════════════════════════════════════
SELECT
    t.table_name,
    CASE WHEN c.column_name IS NULL THEN '❌ MISSING'
         WHEN c.is_nullable = 'YES' THEN '⚠️ NULLABLE'
         ELSE '✅ OK'
    END AS school_id_status
FROM information_schema.tables t
LEFT JOIN information_schema.columns c
    ON t.table_name = c.table_name
    AND c.column_name = 'school_id'
    AND c.table_schema = 'public'
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND t.table_name NOT IN ('schools', 'schema_migrations', 'spatial_ref_sys')
ORDER BY school_id_status DESC, t.table_name;

-- ═══════════════════════════════════════════
-- 2. CHECK: All school_id FKs reference schools(id)
-- Expected: All FK constraints point to schools
-- ═══════════════════════════════════════════
SELECT
    tc.table_name,
    tc.constraint_name,
    ccu.table_name AS referenced_table,
    '✅ FK OK' AS status
FROM information_schema.table_constraints tc
JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
    AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.constraint_name LIKE '%school%'
ORDER BY tc.table_name;

-- ═══════════════════════════════════════════
-- 3. CHECK: No rows with NULL school_id
-- Expected: 0 rows
-- ═══════════════════════════════════════════
DO $$
DECLARE
    tbl TEXT;
    cnt BIGINT;
    tables TEXT[] := ARRAY[
        'persons', 'users', 'students', 'staff', 'parents',
        'classes', 'sections', 'class_sections', 'academic_years',
        'student_enrollments', 'daily_attendance', 'student_fees',
        'fee_transactions', 'receipts', 'exams', 'marks',
        'timetable_slots', 'expenses', 'notices', 'events',
        'complaints', 'lms_courses', 'buses', 'transport_routes',
        'roles', 'permissions', 'audit_logs'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('SELECT COUNT(*) FROM %I WHERE school_id IS NULL', tbl) INTO cnt;
        IF cnt > 0 THEN
            RAISE WARNING '❌ % has % rows with NULL school_id', tbl, cnt;
        ELSE
            RAISE NOTICE '✅ % — all rows have school_id', tbl;
        END IF;
    END LOOP;
END;
$$;

-- ═══════════════════════════════════════════
-- 4. CHECK: RLS is enabled on all tenant tables
-- Expected: All listed tables show relrowsecurity = true
-- ═══════════════════════════════════════════
SELECT
    c.relname AS table_name,
    CASE WHEN c.relrowsecurity THEN '✅ RLS ON' ELSE '❌ RLS OFF' END AS rls_status
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname NOT IN ('schools', 'schema_migrations', 'spatial_ref_sys')
ORDER BY rls_status, c.relname;

-- ═══════════════════════════════════════════
-- 5. CHECK: Tenant isolation test
-- Attempt cross-school data access (should return 0 rows)
-- ═══════════════════════════════════════════
-- Set context to school 999 (non-existent)
SET LOCAL app.current_school_id = '999';
-- These should all return 0 rows:
SELECT COUNT(*) AS should_be_zero_persons FROM persons;
SELECT COUNT(*) AS should_be_zero_users FROM users;
SELECT COUNT(*) AS should_be_zero_students FROM students;
-- Reset
RESET app.current_school_id;

-- ═══════════════════════════════════════════
-- 6. CHECK: Unique constraints are school-scoped
-- Expected: All unique indexes include school_id
-- ═══════════════════════════════════════════
SELECT
    indexrelid::regclass AS index_name,
    indrelid::regclass AS table_name,
    pg_get_indexdef(indexrelid) AS index_definition,
    CASE
        WHEN pg_get_indexdef(indexrelid) LIKE '%school_id%' THEN '✅ School-scoped'
        WHEN NOT indisunique THEN '— (not unique)'
        ELSE '⚠️ NOT school-scoped'
    END AS scope_status
FROM pg_index
JOIN pg_class ON pg_class.oid = pg_index.indrelid
JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
WHERE pg_namespace.nspname = 'public'
  AND indisunique
  AND pg_class.relname NOT IN ('schools', 'schema_migrations')
ORDER BY scope_status DESC, table_name;

-- ═══════════════════════════════════════════
-- 7. SUMMARY: Count of tables with school_id
-- ═══════════════════════════════════════════
SELECT
    COUNT(*) FILTER (WHERE c.column_name IS NOT NULL) AS tables_with_school_id,
    COUNT(*) FILTER (WHERE c.column_name IS NULL) AS tables_without_school_id,
    COUNT(*) AS total_tables
FROM information_schema.tables t
LEFT JOIN information_schema.columns c
    ON t.table_name = c.table_name
    AND c.column_name = 'school_id'
    AND c.table_schema = 'public'
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE';
