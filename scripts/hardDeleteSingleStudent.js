/**
 * Hard-delete a single student and all dependent records.
 *
 * Usage:
 *   node scripts/hardDeleteSingleStudent.js --dry-run
 *   node scripts/hardDeleteSingleStudent.js --execute
 */

import 'dotenv/config';
import sql, { supabaseAdmin } from '../db.js';

const SCHOOL_ID = 17;
const EXPECTED_SCHOOL_NAME = 'Geetanjali High School Maddur';
const ADMISSION_NO = '#Dummy531';
const EMAIL = 'chakalirajudummy531@ghs.com';
const EXPECTED_FIRST_NAME = 'chakali';
const EXPECTED_LAST_NAME = 'raju';

const dryRun = process.argv.includes('--dry-run');
const execute = process.argv.includes('--execute');

class DryRunRollback extends Error {
  constructor(result) {
    super('DRY_RUN_ROLLBACK');
    this.result = result;
  }
}

async function findTargetStudent() {
  const rows = await sql`
    SELECT
      s.id AS student_id,
      s.admission_no,
      s.person_id,
      s.deleted_at AS student_deleted_at,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.display_name,
      pc.contact_value AS email,
      u.id AS user_id
    FROM students s
    JOIN persons p ON p.id = s.person_id
    LEFT JOIN person_contacts pc
      ON pc.person_id = p.id
      AND pc.contact_type = 'email'
      AND pc.is_primary = true
      AND pc.deleted_at IS NULL
    LEFT JOIN users u
      ON u.person_id = p.id
      AND u.school_id = s.school_id
      AND u.deleted_at IS NULL
    WHERE s.school_id = ${SCHOOL_ID}
      AND (
        s.admission_no = ${ADMISSION_NO}
        OR s.admission_no = ${ADMISSION_NO.replace('#', '')}
        OR lower(pc.contact_value) = lower(${EMAIL})
      )
  `;

  if (rows.length === 0) {
    throw new Error(
      `No student found for school_id=${SCHOOL_ID} with admission_no=${ADMISSION_NO} or email=${EMAIL}`
    );
  }

  if (rows.length > 1) {
    throw new Error(
      `Multiple students matched (${rows.length}). Refusing to continue without a unique target.`
    );
  }

  const student = rows[0];
  const fullName = [
    student.first_name,
    student.middle_name,
    student.last_name,
    student.display_name,
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();

  if (!fullName.includes(EXPECTED_FIRST_NAME) || !fullName.includes(EXPECTED_LAST_NAME)) {
    throw new Error(
      `Refusing to continue: matched student name is "${fullName}", expected to include "${EXPECTED_FIRST_NAME}" and "${EXPECTED_LAST_NAME}"`
    );
  }

  if (student.email && student.email.toLowerCase() !== EMAIL.toLowerCase()) {
    throw new Error(
      `Refusing to continue: matched email is "${student.email}", expected "${EMAIL}"`
    );
  }

  return student;
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

async function countTargets(tx, studentId) {
  const [row] = await tx`
    WITH target_students AS (
      SELECT id, person_id
      FROM public.students
      WHERE id = ${studentId}
        AND school_id = ${SCHOOL_ID}
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
    target_parents AS (
      SELECT sp.parent_id
      FROM public.student_parents sp
      JOIN target_students ts ON ts.id = sp.student_id
      WHERE sp.school_id = ${SCHOOL_ID}
    ),
    orphan_parents AS (
      SELECT p.id
      FROM public.parents p
      JOIN target_parents tp ON tp.parent_id = p.id
      WHERE p.school_id = ${SCHOOL_ID}
        AND NOT EXISTS (
          SELECT 1
          FROM public.student_parents sp
          WHERE sp.parent_id = p.id
            AND sp.student_id <> ${studentId}
            AND sp.school_id = ${SCHOOL_ID}
        )
    )
    SELECT
      (SELECT count(*)::int FROM target_students) AS students,
      (SELECT count(*)::int FROM target_enrollments) AS student_enrollments,
      (SELECT count(*)::int FROM public.daily_attendance da JOIN target_enrollments te ON te.id = da.student_enrollment_id WHERE da.school_id = ${SCHOOL_ID}) AS daily_attendance,
      (SELECT count(*)::int FROM public.marks m JOIN target_enrollments te ON te.id = m.student_enrollment_id WHERE m.school_id = ${SCHOOL_ID}) AS marks,
      (SELECT count(*)::int FROM target_fees) AS student_fees,
      (SELECT count(*)::int FROM public.fee_transactions ft JOIN target_fees tf ON tf.id = ft.student_fee_id WHERE ft.school_id = ${SCHOOL_ID}) AS fee_transactions,
      (SELECT count(*)::int FROM public.receipts r JOIN target_students ts ON ts.id = r.student_id WHERE r.school_id = ${SCHOOL_ID}) AS receipts,
      (SELECT count(*)::int FROM public.student_parents sp JOIN target_students ts ON ts.id = sp.student_id WHERE sp.school_id = ${SCHOOL_ID}) AS student_parents,
      (SELECT count(*)::int FROM orphan_parents) AS orphan_parents,
      (SELECT count(*)::int FROM target_users) AS users,
      (SELECT count(*)::int FROM public.audit_logs al JOIN target_users tu ON tu.id = al.user_id) AS audit_logs,
      (SELECT count(*)::int FROM public.person_contacts pc JOIN target_students ts ON ts.person_id = pc.person_id WHERE pc.school_id = ${SCHOOL_ID}) AS person_contacts
  `;

  return row;
}

async function runDeleteTransaction(tx, studentId) {
  await tx`
    CREATE TEMP TABLE target_students ON COMMIT DROP AS
    SELECT id, person_id
    FROM public.students
    WHERE id = ${studentId}
      AND school_id = ${SCHOOL_ID}
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

  await tx`
    CREATE TEMP TABLE target_parents ON COMMIT DROP AS
    SELECT sp.parent_id AS id
    FROM public.student_parents sp
    JOIN target_students ts ON ts.id = sp.student_id
    WHERE sp.school_id = ${SCHOOL_ID}
      AND NOT EXISTS (
        SELECT 1
        FROM public.student_parents sp2
        WHERE sp2.parent_id = sp.parent_id
          AND sp2.student_id <> ${studentId}
          AND sp2.school_id = ${SCHOOL_ID}
      )
  `;

  await tx`
    INSERT INTO target_persons (id)
    SELECT p.person_id
    FROM public.parents p
    JOIN target_parents tp ON tp.id = p.id
    WHERE p.school_id = ${SCHOOL_ID}
      AND p.person_id IS NOT NULL
    ON CONFLICT DO NOTHING
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

  stats.fee_transactions_refunds = await del(
    'fee_transactions_refunds',
    `
      WITH deleted AS (
        DELETE FROM public.fee_transactions ft
        USING public.student_fees sf,
              target_students ts
        WHERE ft.student_fee_id = sf.id
          AND sf.student_id = ts.id
          AND ft.school_id = ${SCHOOL_ID}
          AND ft.refund_of IS NOT NULL
        RETURNING ft.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

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

  stats.discipline_records = await del(
    'discipline_records',
    `
      WITH deleted AS (
        DELETE FROM public.discipline_records dr
        USING target_students ts
        WHERE dr.student_id = ts.id
          AND dr.school_id = ${SCHOOL_ID}
        RETURNING dr.id
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

  stats.student_life_values_progress = await del(
    'student_life_values_progress',
    `
      WITH deleted AS (
        DELETE FROM public.student_life_values_progress slvp
        USING target_students ts
        WHERE slvp.student_id = ts.id
          AND slvp.school_id = ${SCHOOL_ID}
        RETURNING slvp.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.student_money_science_progress = await del(
    'student_money_science_progress',
    `
      WITH deleted AS (
        DELETE FROM public.student_money_science_progress smsp
        USING target_students ts
        WHERE smsp.student_id = ts.id
          AND smsp.school_id = ${SCHOOL_ID}
        RETURNING smsp.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.student_science_projects = await del(
    'student_science_projects',
    `
      WITH deleted AS (
        DELETE FROM public.student_science_projects ssp
        USING target_students ts
        WHERE ssp.student_id = ts.id
          AND ssp.school_id = ${SCHOOL_ID}
        RETURNING ssp.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

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

  stats.transport_import_rows = await del(
    'transport_import_rows',
    `
      WITH deleted AS (
        DELETE FROM public.transport_import_rows tir
        USING target_students ts
        WHERE tir.student_id = ts.id
          AND tir.school_id = ${SCHOOL_ID}
        RETURNING tir.id
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

  stats.notification_dispatch_recipients = await del(
    'notification_dispatch_recipients',
    `
      WITH deleted AS (
        DELETE FROM public.notification_dispatch_recipients ndr
        USING target_users tu
        WHERE ndr.user_id = tu.id
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.notification_deliveries = await del(
    'notification_deliveries',
    `
      WITH deleted AS (
        DELETE FROM public.notification_deliveries nd
        USING public.notifications n,
              target_users tu
        WHERE nd.notification_id = n.id
          AND n.user_id = tu.id
          AND nd.school_id = ${SCHOOL_ID}
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.notifications = await del(
    'notifications',
    `
      WITH deleted AS (
        DELETE FROM public.notifications n
        USING target_users tu
        WHERE n.user_id = tu.id
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.notification_events = await del(
    'notification_events',
    `
      WITH deleted AS (
        DELETE FROM public.notification_events ne
        USING target_users tu
        WHERE ne.target_user_id = tu.id
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.notification_preferences = await del(
    'notification_preferences',
    `
      WITH deleted AS (
        DELETE FROM public.notification_preferences np
        USING target_users tu
        WHERE np.user_id = tu.id
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.notification_logs = await del(
    'notification_logs',
    `
      WITH deleted AS (
        DELETE FROM public.notification_logs nl
        USING target_users tu
        WHERE nl.user_id = tu.id
        RETURNING nl.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.user_settings = await del(
    'user_settings',
    `
      WITH deleted AS (
        DELETE FROM public.user_settings us
        USING target_users tu
        WHERE us.user_id = tu.id
        RETURNING us.user_id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.user_devices = await del(
    'user_devices',
    `
      WITH deleted AS (
        DELETE FROM public.user_devices ud
        USING target_users tu
        WHERE ud.user_id = tu.id
        RETURNING ud.id
      )
      SELECT count(*)::int AS count FROM deleted
    `
  );

  stats.user_roles = await del(
    'user_roles',
    `
      WITH deleted AS (
        DELETE FROM public.user_roles ur
        USING target_users tu
        WHERE ur.user_id = tu.id
        RETURNING ur.user_id
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

  stats.parents = await del(
    'parents',
    `
      WITH deleted AS (
        DELETE FROM public.parents p
        USING target_parents tp
        WHERE p.id = tp.id
          AND p.school_id = ${SCHOOL_ID}
        RETURNING p.id
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

async function verifyCleanup(studentId) {
  const [remainingStudent] = await sql`
    SELECT count(*)::int AS count
    FROM public.students
    WHERE id = ${studentId}
  `;

  const [remainingEmail] = await sql`
    SELECT count(*)::int AS count
    FROM public.person_contacts
    WHERE school_id = ${SCHOOL_ID}
      AND contact_type = 'email'
      AND lower(contact_value) = lower(${EMAIL})
  `;

  return {
    remainingStudent: remainingStudent.count,
    remainingEmail: remainingEmail.count,
  };
}

async function main() {
  if (!dryRun && !execute) {
    console.error('Usage: node scripts/hardDeleteSingleStudent.js --dry-run|--execute');
    process.exit(1);
  }

  const school = await validateSchool();
  const student = await findTargetStudent();
  const beforeCounts = await countTargets(sql, student.student_id);

  console.log(`Target school: ${school.id} - ${school.name}`);
  console.log('Target student:', {
    student_id: student.student_id,
    admission_no: student.admission_no,
    name: `${student.first_name} ${student.last_name}`,
    email: student.email,
    user_id: student.user_id,
    student_deleted_at: student.student_deleted_at,
  });
  console.log('Planned delete counts:', beforeCounts);

  let authUserIds = [];

  try {
    const result = await sql.begin(async (tx) => {
      const deleteResult = await runDeleteTransaction(tx, student.student_id);
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
      console.log('Simulated delete counts:', error.result.stats);
      process.exit(0);
    }
    throw error;
  }

  if (authUserIds.length > 0) {
    console.log(`Deleting ${authUserIds.length} Supabase Auth user(s)...`);
    const authFailures = await deleteAuthUsers(authUserIds);
    if (authFailures.length > 0) {
      console.error('Auth deletion failures:', authFailures);
    } else {
      console.log('All Supabase Auth users deleted successfully.');
    }
  } else {
    console.log('No linked auth users to delete.');
  }

  const verification = await verifyCleanup(student.student_id);
  console.log('Verification:', verification);

  if (verification.remainingStudent !== 0) {
    throw new Error(`Expected 0 remaining student rows, found ${verification.remainingStudent}`);
  }

  if (verification.remainingEmail !== 0) {
    throw new Error(`Expected 0 remaining email rows, found ${verification.remainingEmail}`);
  }

  process.exit(0);
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
