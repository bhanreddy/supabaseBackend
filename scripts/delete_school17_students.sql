-- =====================================================================
--  HARD-DELETE: "student records only" for school_id = 17
--  (Geetanjali High School Maddur, code GHSM)
--
--  SCOPE (per operator decision):
--    DELETE : students + all rows that hang off a student (academic, fee,
--             transport, progress, complaints), the 1458 'Student'-role
--             user logins, and the student/parent persons + their contacts.
--    PRESERVE: staff, staff_payroll, RBAC (roles/permissions/role_permissions),
--             school_settings, classes/sections/class_sections, academic_years,
--             fee_structures/fee_types, financial_policy_rules,
--             financial_audit_logs, the schools row, and all staff/admin
--             persons + users.
--
--  SAFETY MODEL:
--    * Single transaction. Defaults to ROLLBACK at the bottom (dry run that
--      prints per-table counts and undoes itself). Change ROLLBACK -> COMMIT
--      ONLY after you have reviewed the printed counts and a backup exists.
--    * Aborts if school 17 has 0 students (typo / wrong-school guard).
--    * Aborts if any student-login user owns audit-trail rows that use a
--      blocking (NO ACTION) FK, to avoid silently orphaning the audit trail.
--    * Every DELETE is scoped to school 17 and/or the student id-set. There is
--      no bare DELETE. No other tenant's rows are reachable.
--    * Per-table deleted counts are written to public.tenant_student_deletion_audit
--      inside the same transaction.
--
--  RUN (dry run, prints counts, rolls back):
--    psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f delete_school17_students.sql
--  Then review counts, ensure backup, flip ROLLBACK->COMMIT, run again.
-- =====================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------
-- 0. Persistent audit log of what this operation removed.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tenant_student_deletion_audit (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       uuid        NOT NULL,
  school_id    integer     NOT NULL,
  table_name   text        NOT NULL,
  rows_deleted bigint      NOT NULL,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  deleted_by   text        NOT NULL
);

-- ---------------------------------------------------------------------
-- 1. Helper: delete by predicate, count rows, log to audit, notify.
--    p_where is a fixed string authored below (no user input -> safe).
-- ---------------------------------------------------------------------
CREATE FUNCTION pg_temp.zap(p_run uuid, p_school int, p_table text, p_where text, p_actor text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN
  EXECUTE format('DELETE FROM public.%I WHERE %s', p_table, p_where);
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.tenant_student_deletion_audit(run_id, school_id, table_name, rows_deleted, deleted_by)
  VALUES (p_run, p_school, p_table, n, p_actor);
  RAISE NOTICE '  % -> % rows', rpad(p_table, 34), n;
  RETURN n;
END $f$;

-- ---------------------------------------------------------------------
-- 2. The operation.
-- ---------------------------------------------------------------------
DO $do$
DECLARE
  v_school   int  := 17;
  v_run      uuid := gen_random_uuid();
  v_actor    text := current_user;
  v_students int;
BEGIN
  -- 2a. SANITY: refuse to run against an empty / mistyped school.
  SELECT count(*) INTO v_students FROM public.students WHERE school_id = v_school;
  IF v_students = 0 THEN
    RAISE EXCEPTION 'ABORT: school_id=% has 0 students. Refusing (wrong/empty school?).', v_school;
  END IF;
  RAISE NOTICE 'run_id=%  school_id=%  students=%', v_run, v_school, v_students;

  -- 2b. Build the immutable id-sets ONCE (so later deletes do not shrink them mid-flight).
  CREATE TEMP TABLE _stu  ON COMMIT DROP AS
    SELECT id, person_id, auth_user_id FROM public.students WHERE school_id = v_school;
  CREATE TEMP TABLE _sfee ON COMMIT DROP AS
    SELECT id FROM public.student_fees WHERE school_id = v_school;
  CREATE TEMP TABLE _senr ON COMMIT DROP AS
    SELECT id FROM public.student_enrollments WHERE school_id = v_school;

  -- Student-login users = 'Student'-role users, explicitly excluding anyone
  -- who ALSO holds a staff/admin role (defensive; there is no overlap today).
  CREATE TEMP TABLE _suser ON COMMIT DROP AS
    SELECT DISTINCT ur.user_id AS id
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.school_id = v_school AND r.name = 'Student'
      AND ur.user_id NOT IN (
        SELECT ur2.user_id FROM public.user_roles ur2
        JOIN public.roles r2 ON r2.id = ur2.role_id
        WHERE ur2.school_id = v_school AND r2.name <> 'Student');

  -- Persons to delete = student persons + parent persons,
  -- MINUS any person still referenced by a surviving staff row or surviving user.
  CREATE TEMP TABLE _pers ON COMMIT DROP AS
    SELECT person_id AS id FROM public.students WHERE school_id = v_school AND person_id IS NOT NULL
    UNION
    SELECT person_id     FROM public.parents  WHERE school_id = v_school AND person_id IS NOT NULL;
  DELETE FROM _pers WHERE id IN (SELECT person_id FROM public.staff WHERE school_id = v_school)
     OR id IN (SELECT u.person_id FROM public.users u
               WHERE u.school_id = v_school AND u.person_id IS NOT NULL
                 AND u.id NOT IN (SELECT id FROM _suser));

  CREATE TEMP TABLE _run ON COMMIT DROP AS SELECT v_run AS run_id;

  RAISE NOTICE 'id-sets: students=%, student_fees=%, enrollments=%, student_users=%, persons_to_delete=%',
    (SELECT count(*) FROM _stu), (SELECT count(*) FROM _sfee), (SELECT count(*) FROM _senr),
    (SELECT count(*) FROM _suser), (SELECT count(*) FROM _pers);

  -- 2c. BLOCKING-FK guard: financial_audit_logs (NO ACTION) are staff financial
  --     actions and are NOT deleted; abort if a student login somehow owns one.
  --     (audit_logs login-activity rows ARE student data and are deleted below.)
  PERFORM 1 FROM public.financial_audit_logs WHERE performed_by IN (SELECT id FROM _suser) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ABORT: a Student-role user owns financial_audit_logs rows (performed_by). Resolve before deleting.';
  END IF;

  -- 2d. DELETE in dependency order (grandchildren -> children -> students -> shared).
  RAISE NOTICE 'deleting (child -> parent order):';

  -- enrollment grandchildren
  PERFORM pg_temp.zap(v_run,v_school,'marks',                          'school_id=17 AND student_enrollment_id IN (SELECT id FROM _senr)',                                                                                          v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'daily_attendance',               'school_id=17 AND student_enrollment_id IN (SELECT id FROM _senr)',                                                                                          v_actor);

  -- fee / receipt subtree (receipt_items before fee_transactions before student_fees)
  PERFORM pg_temp.zap(v_run,v_school,'receipt_items',                  'school_id=17 AND (receipt_id IN (SELECT id FROM public.receipts WHERE student_id IN (SELECT id FROM _stu)) OR fee_transaction_id IN (SELECT id FROM public.fee_transactions WHERE student_fee_id IN (SELECT id FROM _sfee)))', v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'fee_transactions',               'student_fee_id IN (SELECT id FROM _sfee) AND refund_of IS NOT NULL',                                                                                        v_actor); -- refunds first (self-FK RESTRICT)
  PERFORM pg_temp.zap(v_run,v_school,'fee_transactions',               'student_fee_id IN (SELECT id FROM _sfee)',                                                                                                                 v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'fee_adjustments',                'school_id=17 AND (student_id IN (SELECT id FROM _stu) OR student_fee_id IN (SELECT id FROM _sfee))',                                                       v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'defaulter_payments',             'school_id=17 AND defaulter_due_id IN (SELECT id FROM public.defaulter_dues WHERE student_id IN (SELECT id FROM _stu))',                                   v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'receipts',                       'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'defaulter_dues',                 'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);

  -- welfare / discipline / certificates / hostel
  PERFORM pg_temp.zap(v_run,v_school,'girl_safety_complaint_threads',  'school_id=17 AND complaint_id IN (SELECT id FROM public.girl_safety_complaints WHERE student_id IN (SELECT id FROM _stu))',                              v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'girl_safety_complaints',         'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'discipline_records',             'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'hostel_allocations',             'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'issued_certificates',            'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'complaints',                     'school_id=17 AND raised_for_student_id IN (SELECT id FROM _stu)',                                                                                           v_actor); -- only student-raised-for complaints

  -- value-education / projects progress
  PERFORM pg_temp.zap(v_run,v_school,'student_life_values_progress',   'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'student_money_science_progress', 'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'student_science_projects',       'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);

  -- transport (student-scoped only; routes/stops/buses are infra and PRESERVED)
  PERFORM pg_temp.zap(v_run,v_school,'student_transport',              'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'transport_fee_payments',         'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'transport_import_rows',          'school_id=17 AND student_id IN (SELECT id FROM _stu)',                                                                                                      v_actor);

  -- direct student children (whole-table student-scoped)
  PERFORM pg_temp.zap(v_run,v_school,'student_fees',                   'school_id=17',                                                                                                                                             v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'student_enrollments',            'school_id=17',                                                                                                                                             v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'student_parents',                'school_id=17',                                                                                                                                             v_actor);

  -- user-children of the 1458 student logins (most are CASCADE; explicit for the audit count)
  PERFORM pg_temp.zap(v_run,v_school,'notification_dispatch_recipients','user_id IN (SELECT id FROM _suser)',                                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'notifications',                  'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'notification_events',            'target_user_id IN (SELECT id FROM _suser)',                                                                                                                v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'notification_preferences',       'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'notification_logs',              'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'user_settings',                  'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'user_devices',                   'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'user_roles',                     'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);
  -- student-login activity logs (school_id NULL; NO-ACTION FK on user_id -> must precede users)
  PERFORM pg_temp.zap(v_run,v_school,'audit_logs',                     'user_id IN (SELECT id FROM _suser)',                                                                                                                       v_actor);

  -- parents (entity rows), then the students, then the logins
  PERFORM pg_temp.zap(v_run,v_school,'students',                       'school_id=17',                                                                                                                                             v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'parents',                        'school_id=17',                                                                                                                                             v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'users',                          'id IN (SELECT id FROM _suser)',                                                                                                                            v_actor);

  -- shared persons LAST (contacts before persons; both restricted to _pers set)
  PERFORM pg_temp.zap(v_run,v_school,'person_contacts',                'person_id IN (SELECT id FROM _pers)',                                                                                                                      v_actor);
  PERFORM pg_temp.zap(v_run,v_school,'persons',                        'id IN (SELECT id FROM _pers)',                                                                                                                             v_actor);

  RAISE NOTICE 'done. total rows logged: %', (SELECT sum(rows_deleted) FROM public.tenant_student_deletion_audit WHERE run_id = v_run);
END
$do$;

-- ---------------------------------------------------------------------
-- 3. REVIEW: per-table deletion counts for this run.
-- ---------------------------------------------------------------------
SELECT table_name, rows_deleted
FROM public.tenant_student_deletion_audit
WHERE run_id = (SELECT run_id FROM _run)
ORDER BY id;

-- ---------------------------------------------------------------------
-- 4. DECISION POINT.
--    Default is ROLLBACK = dry run (prints counts above, changes nothing).
--    After review + backup, change the next line to: COMMIT;
-- ---------------------------------------------------------------------
ROLLBACK;
-- COMMIT;
