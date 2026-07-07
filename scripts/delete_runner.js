// Executes the school-17 "student records only" hard-delete as ONE transaction
// via postgres.js (psql/pg_dump unavailable; pooler is transaction-mode).
//   node scripts/delete_runner.js            -> DRY RUN (rolls back, prints counts)
//   node scripts/delete_runner.js --commit   -> REAL DELETE (commits)
import sql from '../db.js';
import crypto from 'crypto';

const COMMIT = process.argv.includes('--commit');
const S = 17;
const ROLLBACK_SENTINEL = '__DRYRUN_ROLLBACK__';

// (table, where) in child -> parent dependency order. Identical to delete_school17_students.sql.
const STEPS = [
  ['marks',                          `school_id=${S} AND student_enrollment_id IN (SELECT id FROM _senr)`],
  ['daily_attendance',               `school_id=${S} AND student_enrollment_id IN (SELECT id FROM _senr)`],
  ['receipt_items',                  `school_id=${S} AND (receipt_id IN (SELECT id FROM receipts WHERE student_id IN (SELECT id FROM _stu)) OR fee_transaction_id IN (SELECT id FROM fee_transactions WHERE student_fee_id IN (SELECT id FROM _sfee)))`],
  ['fee_transactions',               `student_fee_id IN (SELECT id FROM _sfee) AND refund_of IS NOT NULL`],
  ['fee_transactions',               `student_fee_id IN (SELECT id FROM _sfee)`],
  ['fee_adjustments',                `school_id=${S} AND (student_id IN (SELECT id FROM _stu) OR student_fee_id IN (SELECT id FROM _sfee))`],
  ['defaulter_payments',             `school_id=${S} AND defaulter_due_id IN (SELECT id FROM defaulter_dues WHERE student_id IN (SELECT id FROM _stu))`],
  ['receipts',                       `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['defaulter_dues',                 `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['girl_safety_complaint_threads',  `school_id=${S} AND complaint_id IN (SELECT id FROM girl_safety_complaints WHERE student_id IN (SELECT id FROM _stu))`],
  ['girl_safety_complaints',         `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['discipline_records',             `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['hostel_allocations',             `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['issued_certificates',            `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['complaints',                     `school_id=${S} AND raised_for_student_id IN (SELECT id FROM _stu)`],
  ['student_life_values_progress',   `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['student_money_science_progress', `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['student_science_projects',       `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['student_transport',              `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['transport_fee_payments',         `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['transport_import_rows',          `school_id=${S} AND student_id IN (SELECT id FROM _stu)`],
  ['student_fees',                   `school_id=${S}`],
  ['student_enrollments',            `school_id=${S}`],
  ['student_parents',                `school_id=${S}`],
  ['notification_dispatch_recipients',`user_id IN (SELECT id FROM _suser)`],
  ['notifications',                  `user_id IN (SELECT id FROM _suser)`],
  ['notification_events',            `target_user_id IN (SELECT id FROM _suser)`],
  ['notification_preferences',       `user_id IN (SELECT id FROM _suser)`],
  ['notification_logs',              `user_id IN (SELECT id FROM _suser)`],
  ['user_settings',                  `user_id IN (SELECT id FROM _suser)`],
  ['user_devices',                   `user_id IN (SELECT id FROM _suser)`],
  ['user_roles',                     `user_id IN (SELECT id FROM _suser)`],
  ['audit_logs',                     `user_id IN (SELECT id FROM _suser)`], // student-login activity logs (school_id NULL); NO-ACTION FK, must precede users
  ['students',                       `school_id=${S}`],
  ['parents',                        `school_id=${S}`],
  ['users',                          `id IN (SELECT id FROM _suser)`],
  ['person_contacts',                `person_id IN (SELECT id FROM _pers)`],
  ['persons',                        `id IN (SELECT id FROM _pers)`],
];

async function main() {
  const run_id = crypto.randomUUID();
  const counts = [];
  console.log(`\n=== ${COMMIT ? 'COMMIT (REAL DELETE)' : 'DRY RUN (will ROLLBACK)'} | school_id=${S} | run_id=${run_id} ===\n`);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS public.tenant_student_deletion_audit (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id uuid NOT NULL, school_id integer NOT NULL,
        table_name text NOT NULL, rows_deleted bigint NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(), deleted_by text NOT NULL)`);

      const [{ n: students }] = await tx.unsafe(`SELECT count(*)::int n FROM students WHERE school_id=${S}`);
      if (!students) throw new Error(`ABORT: school_id=${S} has 0 students`);

      await tx.unsafe(`CREATE TEMP TABLE _stu  ON COMMIT DROP AS SELECT id FROM students WHERE school_id=${S}`);
      await tx.unsafe(`CREATE TEMP TABLE _sfee ON COMMIT DROP AS SELECT id FROM student_fees WHERE school_id=${S}`);
      await tx.unsafe(`CREATE TEMP TABLE _senr ON COMMIT DROP AS SELECT id FROM student_enrollments WHERE school_id=${S}`);
      await tx.unsafe(`CREATE TEMP TABLE _suser ON COMMIT DROP AS
        SELECT DISTINCT ur.user_id AS id FROM user_roles ur JOIN roles r ON r.id=ur.role_id
        WHERE ur.school_id=${S} AND r.name='Student'
          AND ur.user_id NOT IN (SELECT ur2.user_id FROM user_roles ur2 JOIN roles r2 ON r2.id=ur2.role_id
                                 WHERE ur2.school_id=${S} AND r2.name<>'Student')`);
      await tx.unsafe(`CREATE TEMP TABLE _pers ON COMMIT DROP AS
        SELECT person_id AS id FROM students WHERE school_id=${S} AND person_id IS NOT NULL
        UNION SELECT person_id FROM parents WHERE school_id=${S} AND person_id IS NOT NULL`);
      await tx.unsafe(`DELETE FROM _pers WHERE id IN (SELECT person_id FROM staff WHERE school_id=${S})
        OR id IN (SELECT u.person_id FROM users u WHERE u.school_id=${S} AND u.person_id IS NOT NULL AND u.id NOT IN (SELECT id FROM _suser))`);

      // Guard the one NO-ACTION audit FK we do NOT delete from: financial_audit_logs
      // are financial actions (staff). audit_logs (student-login activity) ARE deleted below.
      const g1 = await tx.unsafe(`SELECT 1 FROM financial_audit_logs WHERE performed_by IN (SELECT id FROM _suser) LIMIT 1`);
      if (g1.length) throw new Error('ABORT: a Student-role user owns financial_audit_logs rows');

      // Authorized ledger purge: tag the destruction reason, then disable ONLY the
      // append-only guard on fee_transactions. FK enforcement + financial_audit_logs
      // logging stay ON. Re-enabled before commit.
      await tx.unsafe(`SET LOCAL app.delete_reason = 'school 17 student purge (authorized hard-delete for re-import)'`);
      await tx.unsafe(`ALTER TABLE public.fee_transactions DISABLE TRIGGER trg_guard_fee_txn`);

      for (const [t, w] of STEPS) {
        const r = await tx.unsafe(`DELETE FROM public.${t} WHERE ${w}`);
        counts.push({ table_name: t, rows_deleted: r.count });
        await tx.unsafe(`INSERT INTO public.tenant_student_deletion_audit(run_id,school_id,table_name,rows_deleted,deleted_by)
          VALUES ('${run_id}',${S},'${t}',${r.count}, current_user)`);
      }

      // Restore the append-only guard before the transaction ends.
      await tx.unsafe(`ALTER TABLE public.fee_transactions ENABLE TRIGGER trg_guard_fee_txn`);

      const total = counts.reduce((a, b) => a + b.rows_deleted, 0);
      console.table(counts.filter(c => c.rows_deleted > 0));
      console.log('TOTAL rows deleted:', total);
      // leftover sanity inside the tx
      const [{ n: left }] = await tx.unsafe(`SELECT count(*)::int n FROM students WHERE school_id=${S}`);
      console.log('students remaining for school 17 (in-tx):', left);

      if (!COMMIT) throw new Error(ROLLBACK_SENTINEL);
    });
    console.log(`\n✅ COMMITTED. ${counts.reduce((a, b) => a + b.rows_deleted, 0)} rows permanently deleted. run_id=${run_id}`);
  } catch (e) {
    if (e.message === ROLLBACK_SENTINEL) {
      console.log('\n↩️  DRY RUN complete — transaction ROLLED BACK. Nothing changed. Re-run with --commit to apply.');
    } else {
      console.error('\n❌ ROLLED BACK due to error:', e.message);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}
main();
