/**
 * Hard-delete all students for a single school, including dependent records
 * and linked student login/person/contact identities.
 *
 * Usage:
 *   node scripts/hardDeleteStudentsForSchool.js --dry-run
 *   node scripts/hardDeleteStudentsForSchool.js --execute
 */

import 'dotenv/config';
import sql, { supabaseAdmin } from '../db.js';

const SCHOOL_ID = 18;
const EXPECTED_SCHOOL_NAME = 'Bhashyam Vidhyanikethan School';

const dryRun = process.argv.includes('--dry-run');
const execute = process.argv.includes('--execute');

class DryRunRollback extends Error {
  constructor(stats) {
    super('DRY_RUN_ROLLBACK');
    this.stats = stats;
  }
}

async function validateSchool() {
  const [school] = await sql`
    SELECT id, name
    FROM public.schools
    WHERE id = ${SCHOOL_ID}
  `;

  if (!school) {
    throw new Error(`School id ${SCHOOL_ID} was not found`);
  }

  if (school.name !== EXPECTED_SCHOOL_NAME) {
    throw new Error(
      `Refusing to continue: school id ${SCHOOL_ID} is "${school.name}", expected "${EXPECTED_SCHOOL_NAME}"`
    );
  }

  return school;
}

async function countTargets(tx) {
  const [row] = await tx`
    WITH target_students AS (
      SELECT id, person_id
      FROM public.students
      WHERE school_id = ${SCHOOL_ID}
    ),
    target_users AS (
      SELECT u.id
      FROM public.users u
      JOIN target_students ts ON ts.person_id = u.person_id
      WHERE u.school_id = ${SCHOOL_ID}
    ),
    target_enrollments AS (
      SELECT se.id
      FROM public.student_enrollments se
      JOIN target_students ts ON ts.id = se.student_id
      WHERE se.school_id = ${SCHOOL_ID}
    ),
    target_fees AS (
      SELECT sf.id
      FROM public.student_fees sf
      JOIN target_students ts ON ts.id = sf.student_id
      WHERE sf.school_id = ${SCHOOL_ID}
    ),
    target_fee_tx AS (
      SELECT ft.id
      FROM public.fee_transactions ft
      JOIN target_fees tf ON tf.id = ft.student_fee_id
      WHERE ft.school_id = ${SCHOOL_ID}
    ),
    target_receipts AS (
      SELECT r.id
      FROM public.receipts r
      JOIN target_students ts ON ts.id = r.student_id
      WHERE r.school_id = ${SCHOOL_ID}
    ),
    target_dues AS (
      SELECT dd.id
      FROM public.defaulter_dues dd
      JOIN target_students ts ON ts.id = dd.student_id
      WHERE dd.school_id = ${SCHOOL_ID}
    )
    SELECT
      (SELECT count(*)::int FROM target_students) AS students,
      (SELECT count(*)::int FROM target_enrollments) AS student_enrollments,
      (SELECT count(*)::int FROM public.daily_attendance da JOIN target_enrollments te ON te.id = da.student_enrollment_id WHERE da.school_id = ${SCHOOL_ID}) AS daily_attendance,
      (SELECT count(*)::int FROM public.marks m JOIN target_enrollments te ON te.id = m.student_enrollment_id WHERE m.school_id = ${SCHOOL_ID}) AS marks,
      (SELECT count(*)::int FROM target_fees) AS student_fees,
      (SELECT count(*)::int FROM target_fee_tx) AS fee_transactions,
      (SELECT count(*)::int FROM public.receipt_items ri JOIN target_fee_tx tft ON tft.id = ri.fee_transaction_id WHERE ri.school_id = ${SCHOOL_ID}) AS receipt_items,
      (SELECT count(*)::int FROM target_receipts) AS receipts,
      (SELECT count(*)::int FROM public.defaulter_payments dp JOIN target_dues td ON td.id = dp.defaulter_due_id WHERE dp.school_id = ${SCHOOL_ID}) AS defaulter_payments,
      (SELECT count(*)::int FROM target_dues) AS defaulter_dues,
      (SELECT count(*)::int FROM public.student_parents sp JOIN target_students ts ON ts.id = sp.student_id WHERE sp.school_id = ${SCHOOL_ID}) AS student_parents,
      (SELECT count(*)::int FROM public.complaints c JOIN target_students ts ON ts.id = c.raised_for_student_id WHERE c.school_id = ${SCHOOL_ID}) AS complaints_linked,
      (SELECT count(*)::int FROM target_users) AS users,
      (SELECT count(*)::int FROM public.audit_logs al JOIN target_users tu ON tu.id = al.user_id) AS audit_logs,
      (SELECT count(*)::int FROM public.person_contacts pc JOIN target_students ts ON ts.person_id = pc.person_id WHERE pc.school_id = ${SCHOOL_ID}) AS person_contacts
  `;

  return row;
}

async function runDeleteTransaction(tx) {
  await tx`
    CREATE TEMP TABLE target_students ON COMMIT DROP AS
    SELECT id, person_id
    FROM public.students
    WHERE school_id = ${SCHOOL_ID}
  `;

  await tx`
    CREATE TEMP TABLE target_users ON COMMIT DROP AS
    SELECT u.id, u.person_id
    FROM public.users u
    JOIN target_students ts ON ts.person_id = u.person_id
    WHERE u.school_id = ${SCHOOL_ID}
  `;

  await tx`
    CREATE TEMP TABLE target_persons ON COMMIT DROP AS
    SELECT person_id AS id
    FROM target_students
  `;

  const stats = {};

  const del = async (label, query) => {
    const rows = await tx.unsafe(query);
    stats[label] = Number(rows[0]?.count ?? 0);
    return stats[label];
  };

  stats.receipt_items_fee_tx = await del(
    'receipt_items_fee_tx',
    `
      WITH deleted AS (
        DELETE FROM public.receipt_items ri
        USING public.fee_transactions ft,
              public.student_fees sf,
              target_students ts
        WHERE ri.fee_transaction_id = ft.id
          AND ft.student_fee_id = sf.id
          AND sf.student_id = ts.id
          AND ri.school_id = ${SCHOOL_ID}
        RETURNING ri.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.receipt_items_receipts = await del(
    'receipt_items_receipts',
    `
      WITH deleted AS (
        DELETE FROM public.receipt_items ri
        USING public.receipts r,
              target_students ts
        WHERE ri.receipt_id = r.id
          AND r.student_id = ts.id
          AND ri.school_id = ${SCHOOL_ID}
        RETURNING ri.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  await tx`ALTER TABLE public.fee_transactions DISABLE TRIGGER trg_guard_fee_txn`;

  stats.fee_transactions = await del(
    'fee_transactions',
    `
      WITH deleted AS (
        DELETE FROM public.fee_transactions ft
        USING public.student_fees sf,
              target_students ts
        WHERE ft.student_fee_id = sf.id
          AND sf.student_id = ts.id
          AND ft.school_id = ${SCHOOL_ID}
        RETURNING ft.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  await tx`ALTER TABLE public.fee_transactions ENABLE TRIGGER trg_guard_fee_txn`;

  stats.receipts = await del(
    'receipts',
    `
      WITH deleted AS (
        DELETE FROM public.receipts r
        USING target_students ts
        WHERE r.student_id = ts.id
          AND r.school_id = ${SCHOOL_ID}
        RETURNING r.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.defaulter_payments = await del(
    'defaulter_payments',
    `
      WITH deleted AS (
        DELETE FROM public.defaulter_payments dp
        USING public.defaulter_dues dd,
              target_students ts
        WHERE dp.defaulter_due_id = dd.id
          AND dd.student_id = ts.id
          AND dp.school_id = ${SCHOOL_ID}
        RETURNING dp.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.defaulter_dues = await del(
    'defaulter_dues',
    `
      WITH deleted AS (
        DELETE FROM public.defaulter_dues dd
        USING target_students ts
        WHERE dd.student_id = ts.id
          AND dd.school_id = ${SCHOOL_ID}
        RETURNING dd.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.fee_adjustments = await del(
    'fee_adjustments',
    `
      WITH deleted AS (
        DELETE FROM public.fee_adjustments fa
        USING target_students ts
        WHERE fa.student_id = ts.id
          AND fa.school_id = ${SCHOOL_ID}
        RETURNING fa.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.student_fees = await del(
    'student_fees',
    `
      WITH deleted AS (
        DELETE FROM public.student_fees sf
        USING target_students ts
        WHERE sf.student_id = ts.id
          AND sf.school_id = ${SCHOOL_ID}
        RETURNING sf.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.transport_fee_payments = await del(
    'transport_fee_payments',
    `
      WITH deleted AS (
        DELETE FROM public.transport_fee_payments tfp
        USING target_students ts
        WHERE tfp.student_id = ts.id
          AND tfp.school_id = ${SCHOOL_ID}
        RETURNING tfp.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.daily_attendance = await del(
    'daily_attendance',
    `
      WITH deleted AS (
        DELETE FROM public.daily_attendance da
        USING public.student_enrollments se,
              target_students ts
        WHERE da.student_enrollment_id = se.id
          AND se.student_id = ts.id
          AND da.school_id = ${SCHOOL_ID}
        RETURNING da.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.marks = await del(
    'marks',
    `
      WITH deleted AS (
        DELETE FROM public.marks m
        USING public.student_enrollments se,
              target_students ts
        WHERE m.student_enrollment_id = se.id
          AND se.student_id = ts.id
          AND m.school_id = ${SCHOOL_ID}
        RETURNING m.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.student_enrollments = await del(
    'student_enrollments',
    `
      WITH deleted AS (
        DELETE FROM public.student_enrollments se
        USING target_students ts
        WHERE se.student_id = ts.id
          AND se.school_id = ${SCHOOL_ID}
        RETURNING se.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.student_parents = await del(
    'student_parents',
    `
      WITH deleted AS (
        DELETE FROM public.student_parents sp
        USING target_students ts
        WHERE sp.student_id = ts.id
          AND sp.school_id = ${SCHOOL_ID}
        RETURNING sp.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.hostel_allocations = await del(
    'hostel_allocations',
    `
      WITH deleted AS (
        DELETE FROM public.hostel_allocations ha
        USING target_students ts
        WHERE ha.student_id = ts.id
          AND ha.school_id = ${SCHOOL_ID}
        RETURNING ha.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.issued_certificates = await del(
    'issued_certificates',
    `
      WITH deleted AS (
        DELETE FROM public.issued_certificates ic
        USING target_students ts
        WHERE ic.student_id = ts.id
          AND ic.school_id = ${SCHOOL_ID}
        RETURNING ic.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  const complaintUpdates = await tx`
    UPDATE public.complaints c
    SET raised_for_student_id = NULL
    FROM target_students ts
    WHERE c.raised_for_student_id = ts.id
      AND c.school_id = ${SCHOOL_ID}
    RETURNING c.id
  `;
  stats.complaints_unlinked = complaintUpdates.length;

  stats.student_transport = await del(
    'student_transport',
    `
      WITH deleted AS (
        DELETE FROM public.student_transport st
        USING target_students ts
        WHERE st.student_id = ts.id
          AND st.school_id = ${SCHOOL_ID}
        RETURNING st.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.students = await del(
    'students',
    `
      WITH deleted AS (
        DELETE FROM public.students s
        USING target_students ts
        WHERE s.id = ts.id
          AND s.school_id = ${SCHOOL_ID}
        RETURNING s.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.audit_logs = await del(
    'audit_logs',
    `
      WITH deleted AS (
        DELETE FROM public.audit_logs al
        USING target_users tu
        WHERE al.user_id = tu.id
        RETURNING al.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  const deletedUsers = await tx`
    DELETE FROM public.users u
    USING target_users tu
    WHERE u.id = tu.id
      AND u.school_id = ${SCHOOL_ID}
    RETURNING u.id
  `;
  stats.users = deletedUsers.length;

  stats.person_contacts = await del(
    'person_contacts',
    `
      WITH deleted AS (
        DELETE FROM public.person_contacts pc
        USING target_persons tp
        WHERE pc.person_id = tp.id
          AND pc.school_id = ${SCHOOL_ID}
        RETURNING pc.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.persons = await del(
    'persons',
    `
      WITH deleted AS (
        DELETE FROM public.persons p
        USING target_persons tp
        WHERE p.id = tp.id
          AND p.school_id = ${SCHOOL_ID}
        RETURNING p.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  return {
    stats,
    authUserIds: deletedUsers.map((row) => row.id),
  };
}

async function verifyCleanup() {
  const [remainingStudents] = await sql`
    SELECT count(*)::int AS count
    FROM public.students
    WHERE school_id = ${SCHOOL_ID}
  `;

  const [school] = await sql`
    SELECT id, name
    FROM public.schools
    WHERE id = ${SCHOOL_ID}
  `;

  return {
    remainingStudents: remainingStudents.count,
    school,
  };
}

async function deleteAuthUsers(authUserIds) {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured');
  }

  const failures = [];
  for (const userId of authUserIds) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) {
      failures.push({ userId, error: error.message });
    }
  }

  return failures;
}

async function main() {
  if (!dryRun && !execute) {
    console.error('Usage: node scripts/hardDeleteStudentsForSchool.js --dry-run|--execute');
    process.exit(1);
  }

  const school = await validateSchool();
  const beforeCounts = await countTargets(sql);

  console.log(`Target school: ${school.id} - ${school.name}`);
  console.log('Planned delete counts:', beforeCounts);

  if (beforeCounts.students === 0) {
    console.log('No students found for this school. Nothing to delete.');
    process.exit(0);
  }

  let authUserIds = [];

  try {
    const result = await sql.begin(async (tx) => {
      const deleteResult = await runDeleteTransaction(tx);
      if (dryRun) {
        throw new DryRunRollback(deleteResult);
      }
      return deleteResult;
    });
    authUserIds = result.authUserIds;
    console.log('Database delete committed:', result.stats);
  } catch (error) {
    if (error instanceof DryRunRollback) {
      console.log('Dry run completed successfully. Transaction rolled back.');
      console.log('Simulated delete counts:', error.stats.stats);
      process.exit(0);
    }
    throw error;
  }

  console.log(`Deleting ${authUserIds.length} Supabase Auth user(s)...`);
  const authFailures = await deleteAuthUsers(authUserIds);
  if (authFailures.length > 0) {
    console.error('Auth deletion failures:', authFailures);
  } else {
    console.log('All Supabase Auth users deleted successfully.');
  }

  const verification = await verifyCleanup();
  console.log('Verification:', verification);

  if (verification.remainingStudents !== 0) {
    throw new Error(`Expected 0 remaining students, found ${verification.remainingStudents}`);
  }

  process.exit(authFailures.length > 0 ? 1 : 0);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
