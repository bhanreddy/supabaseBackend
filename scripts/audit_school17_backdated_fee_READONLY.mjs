/**
 * Read-only audit for the school_id=17 backdated Term 1 fee recovery.
 *
 * This script intentionally contains SELECT statements only. It does not lock,
 * insert, update, delete, alter, or advance any sequence.
 *
 * Run:
 *   node scripts/audit_school17_backdated_fee_READONLY.mjs
 */
import sql from '../db.js';

const SCHOOL_ID = 17;
const ADMISSION_NO = 'Dummy519';
const STUDENT_NAME = 'Mangali Rishik dev';
const AMOUNT_RUPEES = 8500;
const EXPECTED_COLLECTION_UTC = '2026-07-04T06:20:00Z';
const COLLECTION_MATCH_START_UTC = '2026-07-04T06:15:00Z';
const COLLECTION_MATCH_END_UTC = '2026-07-04T06:25:00Z';
const RECEIPT_WINDOW_START_UTC = '2026-07-04T00:00:00Z';
const RECEIPT_WINDOW_END_UTC = '2026-07-30T00:00:00Z';

async function main() {
  const session = await sql`
    SELECT
      current_setting(${'TimeZone'}) AS timezone,
      now() AS db_now,
      current_date AS db_date,
      current_database() AS database_name
  `;

  const relevantTablePresence = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = ${'public'}
      AND table_name IN (
        ${'fee_payments'},
        ${'school_pg_credentials'},
        ${'financial_audit_logs'},
        ${'audit_logs'},
        ${'tenant_student_deletion_audit'}
      )
    ORDER BY table_name
  `;

  const columns = await sql`
    SELECT
      table_name,
      ordinal_position,
      column_name,
      data_type,
      udt_name,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = ${'public'}
      AND table_name IN (
        ${'student_fees'},
        ${'fee_transactions'},
        ${'receipts'},
        ${'receipt_items'},
        ${'fee_payments'},
        ${'financial_audit_logs'},
        ${'audit_logs'},
        ${'tenant_student_deletion_audit'}
      )
    ORDER BY table_name, ordinal_position
  `;

  const triggers = await sql`
    SELECT
      event_object_table AS table_name,
      trigger_name,
      action_timing,
      event_manipulation,
      action_statement
    FROM information_schema.triggers
    WHERE trigger_schema = ${'public'}
      AND event_object_table IN (
        ${'student_fees'},
        ${'fee_transactions'},
        ${'receipts'},
        ${'receipt_items'},
        ${'fee_payments'}
      )
    ORDER BY event_object_table, trigger_name, event_manipulation
  `;

  const school = await sql`
    SELECT
      id,
      name,
      code,
      fee_mode
    FROM schools
    WHERE id = ${SCHOOL_ID}
  `;

  const students = await sql`
    SELECT
      s.id AS student_id,
      s.person_id,
      s.admission_no,
      p.display_name,
      s.created_at AS student_created_at,
      s.updated_at AS student_updated_at,
      se.id AS enrollment_id,
      se.created_at AS enrollment_created_at,
      ay.id AS academic_year_id,
      ay.code AS academic_year,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name
    FROM students s
    JOIN persons p
      ON p.id = s.person_id
     AND p.school_id = ${SCHOOL_ID}
    LEFT JOIN student_enrollments se
      ON se.student_id = s.id
     AND se.school_id = ${SCHOOL_ID}
     AND se.status = ${'active'}
     AND se.deleted_at IS NULL
    LEFT JOIN academic_years ay
      ON ay.id = se.academic_year_id
     AND ay.school_id = ${SCHOOL_ID}
    LEFT JOIN class_sections cs
      ON cs.id = se.class_section_id
     AND cs.school_id = ${SCHOOL_ID}
    LEFT JOIN classes c
      ON c.id = cs.class_id
     AND c.school_id = ${SCHOOL_ID}
    LEFT JOIN sections sec
      ON sec.id = cs.section_id
     AND sec.school_id = ${SCHOOL_ID}
    WHERE s.school_id = ${SCHOOL_ID}
      AND s.deleted_at IS NULL
      AND (
        s.admission_no ILIKE ${ADMISSION_NO}
        OR p.display_name ILIKE ${`%${STUDENT_NAME}%`}
      )
    ORDER BY s.created_at DESC
  `;

  const exactStudentCount = await sql`
    SELECT COUNT(*)::int AS count
    FROM students s
    JOIN persons p
      ON p.id = s.person_id
     AND p.school_id = ${SCHOOL_ID}
    WHERE s.school_id = ${SCHOOL_ID}
      AND s.deleted_at IS NULL
      AND s.admission_no = ${ADMISSION_NO}
      AND lower(p.display_name) = lower(${STUDENT_NAME})
  `;

  const resolvedStudentIds = students.map((row) => row.student_id);

  const studentFees = resolvedStudentIds.length === 0
    ? []
    : await sql`
    SELECT
      sf.id AS student_fee_id,
      sf.student_id,
      sf.fee_structure_id,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      sf.status,
      sf.due_date,
      sf.created_at,
      sf.updated_at,
      sf.deleted_at,
      fs.amount AS structure_amount,
      fs.section_id AS structure_section_id,
      fs.deleted_at AS structure_deleted_at,
      ft.id AS fee_type_id,
      ft.name AS fee_type,
      ay.id AS academic_year_id,
      ay.code AS academic_year,
      c.id AS class_id,
      c.name AS class_name,
      sec.name AS structure_section_name
    FROM students s
    JOIN persons p
      ON p.id = s.person_id
     AND p.school_id = ${SCHOOL_ID}
    JOIN student_fees sf
      ON sf.student_id = s.id
     AND sf.school_id = ${SCHOOL_ID}
    JOIN fee_structures fs
      ON fs.id = sf.fee_structure_id
     AND fs.school_id = ${SCHOOL_ID}
    JOIN fee_types ft
      ON ft.id = fs.fee_type_id
     AND ft.school_id = ${SCHOOL_ID}
    JOIN academic_years ay
      ON ay.id = fs.academic_year_id
     AND ay.school_id = ${SCHOOL_ID}
    JOIN classes c
      ON c.id = fs.class_id
     AND c.school_id = ${SCHOOL_ID}
    LEFT JOIN sections sec
      ON sec.id = fs.section_id
     AND sec.school_id = ${SCHOOL_ID}
    WHERE s.school_id = ${SCHOOL_ID}
      AND s.deleted_at IS NULL
      AND s.id = ANY(${resolvedStudentIds})
    ORDER BY ay.start_date DESC, ft.sort_order, ft.name
  `;

  const matchingStructures = resolvedStudentIds.length === 0
    ? []
    : await sql`
    SELECT
      fs.id AS fee_structure_id,
      fs.amount,
      fs.due_date,
      fs.frequency,
      fs.section_id,
      fs.mode_deactivated,
      fs.deleted_at,
      ft.id AS fee_type_id,
      ft.name AS fee_type,
      ft.code AS fee_code,
      ay.id AS academic_year_id,
      ay.code AS academic_year,
      ay.start_date,
      ay.end_date,
      c.id AS class_id,
      c.name AS class_name,
      sec.name AS section_name
    FROM students s
    JOIN student_enrollments se
      ON se.student_id = s.id
     AND se.school_id = ${SCHOOL_ID}
     AND se.status = ${'active'}
     AND se.deleted_at IS NULL
    JOIN class_sections cs
      ON cs.id = se.class_section_id
     AND cs.school_id = ${SCHOOL_ID}
    JOIN fee_structures fs
      ON fs.school_id = ${SCHOOL_ID}
     AND fs.class_id = cs.class_id
     AND fs.academic_year_id = se.academic_year_id
    JOIN fee_types ft
      ON ft.id = fs.fee_type_id
     AND ft.school_id = ${SCHOOL_ID}
    JOIN academic_years ay
      ON ay.id = fs.academic_year_id
     AND ay.school_id = ${SCHOOL_ID}
    JOIN classes c
      ON c.id = fs.class_id
     AND c.school_id = ${SCHOOL_ID}
    LEFT JOIN sections sec
      ON sec.id = fs.section_id
     AND sec.school_id = ${SCHOOL_ID}
    WHERE s.school_id = ${SCHOOL_ID}
      AND s.id = ANY(${resolvedStudentIds})
      AND (
        lower(ft.name) LIKE ${'%term 1%'}
        OR lower(ft.name) LIKE ${'%term-1%'}
        OR lower(ft.name) LIKE ${'%1st term%'}
        OR lower(ft.code) LIKE ${'%term1%'}
        OR lower(ft.code) LIKE ${'%1st_term%'}
      )
    ORDER BY ay.start_date DESC, fs.created_at DESC
  `;

  const deletionRuns = await sql`
    SELECT
      run_id,
      min(deleted_at) AS deleted_at,
      sum(rows_deleted)::bigint AS total_rows,
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'table_name', table_name,
          'rows_deleted', rows_deleted
        )
        ORDER BY id
      ) AS counts
    FROM tenant_student_deletion_audit
    WHERE school_id = ${SCHOOL_ID}
    GROUP BY run_id
    ORDER BY min(deleted_at) DESC
    LIMIT 10
  `;

  const receiptAudit = await sql`
    SELECT
      id,
      record_id,
      action_type,
      old_data,
      reason,
      performed_by,
      performed_at,
      metadata
    FROM financial_audit_logs
    WHERE school_id = ${SCHOOL_ID}
      AND table_name = ${'receipts'}
      AND action_type = ${'DELETE'}
      AND (old_data->>${'total_amount'})::numeric = ${AMOUNT_RUPEES}
      AND (old_data->>${'issued_at'})::timestamptz >= ${COLLECTION_MATCH_START_UTC}::timestamptz
      AND (old_data->>${'issued_at'})::timestamptz < ${COLLECTION_MATCH_END_UTC}::timestamptz
    ORDER BY (old_data->>${'issued_at'})::timestamptz
  `;

  const receiptStudentIds = receiptAudit
    .map((row) => row.old_data?.student_id)
    .filter(Boolean);

  const deletedStudentFees = receiptStudentIds.length === 0
    ? []
    : await sql`
        SELECT
          id,
          record_id,
          old_data,
          reason,
          performed_by,
          performed_at
        FROM financial_audit_logs
        WHERE school_id = ${SCHOOL_ID}
          AND table_name = ${'student_fees'}
          AND action_type = ${'DELETE'}
          AND old_data->>${'student_id'} = ANY(${receiptStudentIds})
        ORDER BY performed_at, record_id
      `;

  const auditedFeeStructureIds = deletedStudentFees
    .map((row) => row.old_data?.fee_structure_id)
    .filter(Boolean);

  const auditedFeeStructures = auditedFeeStructureIds.length === 0
    ? []
    : await sql`
        SELECT
          fs.id AS fee_structure_id,
          fs.amount,
          fs.due_date,
          fs.frequency,
          fs.section_id,
          fs.mode_deactivated,
          fs.deleted_at,
          ft.id AS fee_type_id,
          ft.name AS fee_type,
          ft.code AS fee_code,
          ay.id AS academic_year_id,
          ay.code AS academic_year,
          ay.start_date,
          ay.end_date,
          c.id AS class_id,
          c.name AS class_name,
          sec.name AS section_name
        FROM fee_structures fs
        JOIN fee_types ft
          ON ft.id = fs.fee_type_id
         AND ft.school_id = ${SCHOOL_ID}
        JOIN academic_years ay
          ON ay.id = fs.academic_year_id
         AND ay.school_id = ${SCHOOL_ID}
        JOIN classes c
          ON c.id = fs.class_id
         AND c.school_id = ${SCHOOL_ID}
        LEFT JOIN sections sec
          ON sec.id = fs.section_id
         AND sec.school_id = ${SCHOOL_ID}
        WHERE fs.school_id = ${SCHOOL_ID}
          AND fs.id = ANY(${auditedFeeStructureIds})
        ORDER BY ft.sort_order, ft.name
      `;

  const issuedByIds = receiptAudit
    .map((row) => row.old_data?.issued_by)
    .filter(Boolean);

  const originalCollectors = issuedByIds.length === 0
    ? []
    : await sql`
        SELECT
          u.id AS user_id,
          p.display_name,
          u.account_status,
          array_agg(DISTINCT r.code ORDER BY r.code) AS role_codes
        FROM users u
        JOIN persons p
          ON p.id = u.person_id
         AND p.school_id = ${SCHOOL_ID}
        LEFT JOIN user_roles ur
          ON ur.user_id = u.id
         AND ur.school_id = ${SCHOOL_ID}
        LEFT JOIN roles r
          ON r.id = ur.role_id
        WHERE u.school_id = ${SCHOOL_ID}
          AND u.id = ANY(${issuedByIds})
        GROUP BY u.id, p.display_name, u.account_status
        ORDER BY p.display_name
      `;

  const currentRowsForAuditedStudentIds = receiptStudentIds.length === 0
    ? []
    : await sql`
        SELECT
          s.id AS student_id,
          s.admission_no,
          p.display_name,
          c.name AS class_name,
          sec.name AS section_name
        FROM students s
        JOIN persons p
          ON p.id = s.person_id
         AND p.school_id = ${SCHOOL_ID}
        LEFT JOIN student_enrollments se
          ON se.student_id = s.id
         AND se.school_id = ${SCHOOL_ID}
         AND se.status = ${'active'}
         AND se.deleted_at IS NULL
        LEFT JOIN class_sections cs
          ON cs.id = se.class_section_id
         AND cs.school_id = ${SCHOOL_ID}
        LEFT JOIN classes c
          ON c.id = cs.class_id
         AND c.school_id = ${SCHOOL_ID}
        LEFT JOIN sections sec
          ON sec.id = cs.section_id
         AND sec.school_id = ${SCHOOL_ID}
        WHERE s.school_id = ${SCHOOL_ID}
          AND s.id = ANY(${receiptStudentIds})
        ORDER BY s.id
      `;

  const auditLogMatches = await sql`
    SELECT
      id,
      user_id,
      action,
      entity,
      entity_id,
      details,
      created_at
    FROM audit_logs
    WHERE school_id = ${SCHOOL_ID}
      AND (
        details::text ILIKE ${`%${ADMISSION_NO}%`}
        OR details::text ILIKE ${`%${STUDENT_NAME}%`}
        OR entity_id = ANY(${receiptStudentIds.length > 0 ? receiptStudentIds : ['00000000-0000-0000-0000-000000000000']})
      )
    ORDER BY created_at
  `;

  const sequence = await sql`
    SELECT last_value, is_called
    FROM receipt_no_seq
  `;

  const recoveredReceiptNumbers = receiptAudit
    .map((row) => row.old_data?.receipt_no)
    .filter(Boolean);

  const recoveredReceiptNumberCollisions = recoveredReceiptNumbers.length === 0
    ? []
    : await sql`
        SELECT
          id,
          receipt_no,
          student_id,
          total_amount,
          issued_at,
          created_at
        FROM receipts
        WHERE school_id = ${SCHOOL_ID}
          AND receipt_no = ANY(${recoveredReceiptNumbers})
        ORDER BY receipt_no
      `;

  const receiptWindowSummary = await sql`
    SELECT
      COUNT(*)::int AS receipt_count,
      MIN(issued_at) AS first_issued_at,
      MAX(issued_at) AS last_issued_at,
      MIN(receipt_no) AS lowest_receipt_no,
      MAX(receipt_no) AS highest_receipt_no
    FROM receipts
    WHERE school_id = ${SCHOOL_ID}
      AND issued_at >= ${RECEIPT_WINDOW_START_UTC}::timestamptz
      AND issued_at < ${RECEIPT_WINDOW_END_UTC}::timestamptz
  `;

  const feeTransactionWindow = await sql`
    SELECT
      id,
      student_fee_id,
      amount,
      payment_method,
      transaction_ref,
      paid_at,
      received_by,
      remarks,
      created_at,
      receipt_group
    FROM fee_transactions
    WHERE school_id = ${SCHOOL_ID}
      AND amount = ${AMOUNT_RUPEES}
      AND paid_at >= ${COLLECTION_MATCH_START_UTC}::timestamptz
      AND paid_at < ${COLLECTION_MATCH_END_UTC}::timestamptz
    ORDER BY paid_at, id
  `;

  const collectorDayTransactions = issuedByIds.length === 0
    ? []
    : await sql`
        SELECT
          t.id,
          t.amount,
          t.payment_method,
          t.transaction_ref,
          t.paid_at,
          t.received_by,
          t.remarks,
          r.receipt_no
        FROM fee_transactions t
        LEFT JOIN receipt_items ri
          ON ri.fee_transaction_id = t.id
         AND ri.school_id = ${SCHOOL_ID}
        LEFT JOIN receipts r
          ON r.id = ri.receipt_id
         AND r.school_id = ${SCHOOL_ID}
        WHERE t.school_id = ${SCHOOL_ID}
          AND t.received_by = ANY(${issuedByIds})
          AND t.paid_at >= ${RECEIPT_WINDOW_START_UTC}::timestamptz
          AND t.paid_at < ${'2026-07-05T00:00:00Z'}::timestamptz
        ORDER BY t.paid_at
      `;

  const result = {
    constants: {
      schoolId: SCHOOL_ID,
      admissionNo: ADMISSION_NO,
      studentName: STUDENT_NAME,
      amountRupees: AMOUNT_RUPEES,
      expectedCollectionUtc: EXPECTED_COLLECTION_UTC,
      collectionMatchStartUtc: COLLECTION_MATCH_START_UTC,
      collectionMatchEndUtc: COLLECTION_MATCH_END_UTC,
    },
    session,
    relevantTablePresence,
    columns,
    triggers,
    school,
    students,
    exactStudentCount,
    studentFees,
    matchingStructures,
    deletionRuns,
    receiptAudit,
    deletedStudentFees,
    auditedFeeStructures,
    originalCollectors,
    currentRowsForAuditedStudentIds,
    auditLogMatches,
    sequence,
    recoveredReceiptNumberCollisions,
    receiptWindowSummary,
    feeTransactionWindow,
    collectorDayTransactions,
  };

  const output = process.argv.includes('--payment-context')
    ? {
        receiptAudit: result.receiptAudit,
        originalCollectors: result.originalCollectors,
        feeTransactionWindow: result.feeTransactionWindow,
        collectorDayTransactions: result.collectorDayTransactions,
      }
    : result;

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end();
  });
