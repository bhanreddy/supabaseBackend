/**
 * Restore one hard-deleted historical fee payment onto the surviving duplicate
 * student record.
 *
 * Safety:
 *   - hard-scoped to school_id 17 and admission_no Dummy519
 *   - dry-run by default; pass --apply to write
 *   - exact student/class/section/fee/amount/audit preconditions
 *   - idempotent recovery reference and original receipt number checks
 *   - one database transaction with post-write assertions
 *
 * Run:
 *   node scripts/restore_school17_dummy519_fee.mjs
 *   node scripts/restore_school17_dummy519_fee.mjs --apply
 */
import sql from '../db.js';

const APPLY = process.argv.includes('--apply');

const SCHOOL_ID = 17;
const ADMISSION_NO = 'Dummy519';
const STUDENT_NAME = 'Mangali Rishik dev';
const CLASS_NAME = '2';
const SECTION_NAME = 'C';
const ACADEMIC_YEAR = '2026-2027';
const FEE_TYPE = '1st Term School Fee';
const AMOUNT = 8500;
const PAYMENT_METHOD = 'cash';

// The deleted receipt audit is the authoritative source for these values.
const ORIGINAL_RECEIPT_ID = '5edb8bfa-6bba-43e3-bf1d-9f600a845397';
const ORIGINAL_RECEIPT_NO = 'RCT-20260704-1091';
const ORIGINAL_DELETED_STUDENT_ID = '4176f518-929f-4c12-a0d8-d4f1e0ea1648';
const ORIGINAL_COLLECTED_AT = '2026-07-04T06:20:52.214446+00:00';
const ORIGINAL_COLLECTOR_ID = 'a824a913-ec98-4597-84ed-7b8577389949';

// The original cash transaction_ref was deleted and was not retained by the
// financial audit trigger. This stable reference makes the repair idempotent.
const RECOVERY_TRANSACTION_REF = 'RECOVERY-RCT-20260704-1091-DUMMY519';
const RECOVERY_REASON =
  'Restore hard-deleted historical fee payment from Dummy520 to surviving duplicate Dummy519';

function assert(condition, message) {
  if (!condition) throw new Error(`ABORT: ${message}`);
}

async function resolveState(db, { lock = false } = {}) {
  if (lock) {
    await db`SELECT pg_advisory_xact_lock(${SCHOOL_ID}, ${1091})`;
  }

  const school = await db`
    SELECT id, name, code
    FROM schools
    WHERE id = ${SCHOOL_ID}
  `;
  assert(school.length === 1, `expected school_id ${SCHOOL_ID} to exist exactly once`);

  const students = await db`
    SELECT
      s.id AS student_id,
      s.admission_no,
      p.display_name,
      c.name AS class_name,
      sec.name AS section_name,
      ay.code AS academic_year
    FROM students s
    JOIN persons p
      ON p.id = s.person_id
     AND p.school_id = ${SCHOOL_ID}
    JOIN student_enrollments se
      ON se.student_id = s.id
     AND se.school_id = ${SCHOOL_ID}
     AND se.status = ${'active'}
     AND se.deleted_at IS NULL
    JOIN academic_years ay
      ON ay.id = se.academic_year_id
     AND ay.school_id = ${SCHOOL_ID}
    JOIN class_sections cs
      ON cs.id = se.class_section_id
     AND cs.school_id = ${SCHOOL_ID}
    JOIN classes c
      ON c.id = cs.class_id
     AND c.school_id = ${SCHOOL_ID}
    JOIN sections sec
      ON sec.id = cs.section_id
     AND sec.school_id = ${SCHOOL_ID}
    WHERE s.school_id = ${SCHOOL_ID}
      AND s.deleted_at IS NULL
      AND s.admission_no = ${ADMISSION_NO}
      AND lower(p.display_name) = lower(${STUDENT_NAME})
      AND c.name = ${CLASS_NAME}
      AND sec.name = ${SECTION_NAME}
      AND ay.code = ${ACADEMIC_YEAR}
    ${lock ? sql`FOR UPDATE OF s` : sql``}
  `;
  assert(
    students.length === 1,
    `expected exactly one active ${ADMISSION_NO} / ${STUDENT_NAME} in Class ${CLASS_NAME}-${SECTION_NAME}`,
  );
  const student = students[0];

  const fees = await db`
    SELECT
      sf.id AS student_fee_id,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      sf.status,
      sf.deleted_at,
      ft.name AS fee_type,
      ay.code AS academic_year
    FROM student_fees sf
    JOIN fee_structures fs
      ON fs.id = sf.fee_structure_id
     AND fs.school_id = ${SCHOOL_ID}
     AND fs.deleted_at IS NULL
    JOIN fee_types ft
      ON ft.id = fs.fee_type_id
     AND ft.school_id = ${SCHOOL_ID}
    JOIN academic_years ay
      ON ay.id = fs.academic_year_id
     AND ay.school_id = ${SCHOOL_ID}
    WHERE sf.school_id = ${SCHOOL_ID}
      AND sf.student_id = ${student.student_id}
      AND sf.deleted_at IS NULL
      AND ft.name = ${FEE_TYPE}
      AND ay.code = ${ACADEMIC_YEAR}
    ${lock ? sql`FOR UPDATE OF sf` : sql``}
  `;
  assert(fees.length === 1, `expected exactly one active ${FEE_TYPE} fee row`);
  const fee = fees[0];

  const receiptAudit = await db`
    SELECT id, record_id, old_data, performed_at
    FROM financial_audit_logs
    WHERE school_id = ${SCHOOL_ID}
      AND table_name = ${'receipts'}
      AND action_type = ${'DELETE'}
      AND record_id = ${ORIGINAL_RECEIPT_ID}
  `;
  assert(receiptAudit.length === 1, 'expected exactly one original deleted receipt audit row');
  const auditedReceipt = receiptAudit[0].old_data;
  assert(auditedReceipt?.receipt_no === ORIGINAL_RECEIPT_NO, 'audited receipt number differs');
  assert(
    auditedReceipt?.student_id === ORIGINAL_DELETED_STUDENT_ID,
    'audited deleted student differs',
  );
  assert(Number(auditedReceipt?.total_amount) === AMOUNT, 'audited receipt amount differs');
  assert(auditedReceipt?.issued_by === ORIGINAL_COLLECTOR_ID, 'audited collector differs');
  assert(
    new Date(auditedReceipt?.issued_at).getTime() === new Date(ORIGINAL_COLLECTED_AT).getTime(),
    'audited collection timestamp differs',
  );

  const collector = await db`
    SELECT u.id, u.account_status, p.display_name
    FROM users u
    JOIN persons p
      ON p.id = u.person_id
     AND p.school_id = ${SCHOOL_ID}
    WHERE u.id = ${ORIGINAL_COLLECTOR_ID}
      AND u.school_id = ${SCHOOL_ID}
      AND u.deleted_at IS NULL
  `;
  assert(collector.length === 1, 'original fee collector is not an active school-17 user row');

  const receiptCollision = await db`
    SELECT id, school_id, student_id, total_amount, issued_at
    FROM receipts
    WHERE receipt_no = ${ORIGINAL_RECEIPT_NO}
  `;

  const recoveryTransactions = await db`
    SELECT
      t.id,
      t.student_fee_id,
      t.amount,
      t.payment_method,
      t.transaction_ref,
      t.paid_at,
      t.created_at,
      r.id AS receipt_id,
      r.receipt_no,
      r.student_id AS receipt_student_id,
      r.total_amount,
      r.issued_at,
      r.created_at AS receipt_created_at
    FROM fee_transactions t
    LEFT JOIN receipt_items ri
      ON ri.fee_transaction_id = t.id
     AND ri.school_id = ${SCHOOL_ID}
    LEFT JOIN receipts r
      ON r.id = ri.receipt_id
     AND r.school_id = ${SCHOOL_ID}
    WHERE t.school_id = ${SCHOOL_ID}
      AND (
        t.transaction_ref = ${RECOVERY_TRANSACTION_REF}
        OR (
          t.student_fee_id = ${fee.student_fee_id}
          AND t.amount = ${AMOUNT}
          AND t.paid_at = ${ORIGINAL_COLLECTED_AT}::timestamptz
        )
      )
    ORDER BY t.created_at
  `;

  const collectionPlacement = await db`
    SELECT
      count(*) FILTER (
        WHERE (t.paid_at AT TIME ZONE ${'Asia/Kolkata'})::date =
              (now() AT TIME ZONE ${'Asia/Kolkata'})::date
      )::int AS today_count,
      count(*) FILTER (
        WHERE (t.paid_at AT TIME ZONE ${'Asia/Kolkata'})::date = ${'2026-07-04'}::date
      )::int AS historical_day_count,
      min(to_char(
        t.paid_at AT TIME ZONE ${'Asia/Kolkata'},
        ${'YYYY-MM-DD HH24:MI:SS.US'}
      )) AS paid_at_ist_exact,
      min(to_char(
        r.issued_at AT TIME ZONE ${'Asia/Kolkata'},
        ${'YYYY-MM-DD HH24:MI:SS.US'}
      )) AS issued_at_ist_exact
    FROM fee_transactions t
    LEFT JOIN receipt_items ri
      ON ri.fee_transaction_id = t.id
     AND ri.school_id = ${SCHOOL_ID}
    LEFT JOIN receipts r
      ON r.id = ri.receipt_id
     AND r.school_id = ${SCHOOL_ID}
    WHERE t.school_id = ${SCHOOL_ID}
      AND t.transaction_ref = ${RECOVERY_TRANSACTION_REF}
  `;

  return {
    school: school[0],
    student,
    fee,
    collector: collector[0],
    receiptCollision,
    recoveryTransactions,
    collectionPlacement: collectionPlacement[0],
  };
}

function assertAlreadyRestored(state) {
  assert(state.recoveryTransactions.length === 1, 'recovery state is ambiguous');
  const row = state.recoveryTransactions[0];
  assert(row.student_fee_id === state.fee.student_fee_id, 'recovery transaction points to the wrong fee');
  assert(Number(row.amount) === AMOUNT, 'recovery transaction has the wrong amount');
  assert(row.payment_method === PAYMENT_METHOD, 'recovery transaction has the wrong payment method');
  assert(row.receipt_no === ORIGINAL_RECEIPT_NO, 'recovery receipt number is wrong');
  assert(row.receipt_student_id === state.student.student_id, 'recovery receipt points to the wrong student');
  assert(Number(row.total_amount) === AMOUNT, 'recovery receipt total is wrong');
  assert(Number(state.fee.amount_paid) === AMOUNT, 'target first-term paid balance is wrong');
  assert(state.collectionPlacement.today_count === 0, 'recovered payment appears in today’s collection');
  assert(
    state.collectionPlacement.historical_day_count === 1,
    'recovered payment is not present exactly once on 04 July 2026',
  );
  assert(
    state.collectionPlacement.paid_at_ist_exact === '2026-07-04 11:50:52.214000',
    `recovered payment timestamp is not exact (${state.collectionPlacement.paid_at_ist_exact})`,
  );
  assert(
    state.collectionPlacement.issued_at_ist_exact === state.collectionPlacement.paid_at_ist_exact,
    `recovered receipt timestamp is not exact (${state.collectionPlacement.issued_at_ist_exact})`,
  );
}

function summary(state, status) {
  return {
    status,
    mode: APPLY ? 'apply' : 'dry-run',
    school: state.school,
    student: state.student,
    fee: state.fee,
    collector: state.collector,
    payment: {
      amount: AMOUNT,
      payment_method: PAYMENT_METHOD,
      collected_at_utc: ORIGINAL_COLLECTED_AT,
      collected_at_ist: '2026-07-04 11:50:52.214446+05:30',
      receipt_no: ORIGINAL_RECEIPT_NO,
      recovery_transaction_ref: RECOVERY_TRANSACTION_REF,
    },
    recoveryTransactions: state.recoveryTransactions,
    collectionPlacement: state.collectionPlacement,
  };
}

async function applyRecovery() {
  return sql.begin(async (tx) => {
    const before = await resolveState(tx, { lock: true });

    if (before.recoveryTransactions.length > 0) {
      assertAlreadyRestored(before);
      return summary(before, 'already_restored');
    }

    assert(before.receiptCollision.length === 0, `${ORIGINAL_RECEIPT_NO} is already in use`);
    assert(Number(before.fee.amount_due) === AMOUNT, 'target fee amount_due is not ₹8,500');
    assert(Number(before.fee.discount) === 0, 'target fee has a non-zero discount');
    assert(Number(before.fee.amount_paid) === 0, 'target fee is not fully unpaid');

    const [transaction] = await tx`
      INSERT INTO fee_transactions (
        student_fee_id,
        amount,
        payment_method,
        transaction_ref,
        paid_at,
        received_by,
        remarks,
        created_at,
        school_id,
        receipt_group
      )
      VALUES (
        ${before.fee.student_fee_id},
        ${AMOUNT},
        ${PAYMENT_METHOD},
        ${RECOVERY_TRANSACTION_REF},
        ${ORIGINAL_COLLECTED_AT}::timestamptz,
        ${ORIGINAL_COLLECTOR_ID},
        ${null},
        ${ORIGINAL_COLLECTED_AT}::timestamptz,
        ${SCHOOL_ID},
        ${null}
      )
      RETURNING id
    `;
    assert(transaction, 'fee transaction insert returned no row');

    const generatedReceipts = await tx`
      SELECT r.id
      FROM receipt_items ri
      JOIN receipts r
        ON r.id = ri.receipt_id
       AND r.school_id = ${SCHOOL_ID}
      WHERE ri.school_id = ${SCHOOL_ID}
        AND ri.fee_transaction_id = ${transaction.id}
      FOR UPDATE OF r
    `;
    assert(generatedReceipts.length === 1, 'auto-receipt trigger did not create exactly one receipt');

    const [receipt] = await tx`
      UPDATE receipts
      SET
        receipt_no = ${ORIGINAL_RECEIPT_NO},
        student_id = ${before.student.student_id},
        total_amount = ${AMOUNT},
        issued_at = ${ORIGINAL_COLLECTED_AT}::timestamptz,
        issued_by = ${ORIGINAL_COLLECTOR_ID},
        remarks = ${'System Generated'},
        created_at = ${ORIGINAL_COLLECTED_AT}::timestamptz
      WHERE id = ${generatedReceipts[0].id}
        AND school_id = ${SCHOOL_ID}
      RETURNING id, receipt_no
    `;
    assert(receipt?.receipt_no === ORIGINAL_RECEIPT_NO, 'receipt restoration failed');

    await tx`
      INSERT INTO financial_audit_logs (
        school_id,
        table_name,
        record_id,
        action_type,
        old_data,
        new_data,
        reason,
        performed_by,
        metadata
      )
      SELECT
        ${SCHOOL_ID},
        ${'fee_transactions'},
        t.id::text,
        ${'CREATE'},
        NULL,
        to_jsonb(t),
        ${RECOVERY_REASON},
        NULL,
        jsonb_build_object(
          'repair_type', ${'hard_deleted_duplicate_student_fee_recovery'}::text,
          'source_deleted_student_id', ${ORIGINAL_DELETED_STUDENT_ID}::text,
          'source_deleted_receipt_id', ${ORIGINAL_RECEIPT_ID}::text,
          'source_deleted_receipt_audit_id',
            ${'0f308f9f-4847-4417-9279-3aac0ebf727d'}::text,
          'target_admission_no', ${ADMISSION_NO}::text,
          'restored_receipt_id', ${receipt.id}::text,
          'restored_receipt_no', ${ORIGINAL_RECEIPT_NO}::text
        )
      FROM fee_transactions t
      WHERE t.id = ${transaction.id}
        AND t.school_id = ${SCHOOL_ID}
    `;

    const after = await resolveState(tx);
    assertAlreadyRestored(after);
    assert(after.receiptCollision.length === 1, 'restored receipt number is not unique');

    const todayTargetCollections = await tx`
      SELECT count(*)::int AS count
      FROM fee_transactions t
      WHERE t.school_id = ${SCHOOL_ID}
        AND t.student_fee_id = ${after.fee.student_fee_id}
        AND (t.paid_at AT TIME ZONE ${'Asia/Kolkata'})::date =
            (now() AT TIME ZONE ${'Asia/Kolkata'})::date
    `;
    assert(todayTargetCollections[0].count === 0, 'restored payment appears in today’s collection');

    return summary(after, 'restored');
  });
}

async function main() {
  if (!APPLY) {
    const state = await resolveState(sql);
    if (state.recoveryTransactions.length > 0) {
      assertAlreadyRestored(state);
      console.log(JSON.stringify(summary(state, 'already_restored'), null, 2));
      return;
    }

    assert(state.receiptCollision.length === 0, `${ORIGINAL_RECEIPT_NO} is already in use`);
    assert(Number(state.fee.amount_due) === AMOUNT, 'target fee amount_due is not ₹8,500');
    assert(Number(state.fee.discount) === 0, 'target fee has a non-zero discount');
    assert(Number(state.fee.amount_paid) === 0, 'target fee is not fully unpaid');
    console.log(JSON.stringify(summary(state, 'ready_to_restore'), null, 2));
    return;
  }

  console.log(JSON.stringify(await applyRecovery(), null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
