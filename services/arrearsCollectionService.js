// Arrears have their own ledger. Read it directly so historical recoveries are
// visible without duplicating them into current-year student fee payments.
function paymentFilter(sql, { schoolId, receivedBy, paymentMethod, date, fromDate, toDate, today, dateOnly }) {
  return sql`
    dp.school_id = ${schoolId}
    ${receivedBy ? sql`AND dp.received_by = ${receivedBy}` : sql``}
    ${paymentMethod ? sql`AND dp.payment_method = ${paymentMethod}` : sql``}
    ${today ? sql`AND dp.paid_at >= CURRENT_DATE AND dp.paid_at < CURRENT_DATE + INTERVAL '1 day'` : sql``}
    ${date ? sql`AND DATE(dp.paid_at) = ${date}::date` : sql``}
    ${fromDate ? (dateOnly ? sql`AND DATE(dp.paid_at) >= ${fromDate}::date` : sql`AND dp.paid_at >= ${fromDate}`) : sql``}
    ${toDate ? (dateOnly ? sql`AND DATE(dp.paid_at) <= ${toDate}::date` : sql`AND dp.paid_at <= ${toDate}`) : sql``}
  `;
}

export async function getArrearsTransactions(sql, options) {
  const { schoolId, limit } = options;
  return sql`
    SELECT
      dp.id, dp.amount, dp.payment_method, dp.transaction_ref, dp.paid_at, dp.remarks,
      dp.received_by AS received_by_id,
      NULL::uuid AS student_fee_id,
      'arrears'::text AS transaction_source,
      'arrears'::text AS payment_type,
      FALSE AS can_delete,
      NULL::uuid AS deletion_approval_id, NULL::text AS deletion_status,
      dd.student_id, dd.id AS defaulter_due_id,
      s.admission_no, p.display_name AS student_name,
      enroll.class_name, enroll.section_name,
      father_info.father_name, father_info.father_mobile,
      r.receipt_no,
      'Arrears — ' || dd.due_academic_year AS fee_type,
      NULL::text AS fee_type_te, dd.due_academic_year AS academic_year,
      receiver.display_name AS received_by,
      dd.original_amount AS amount_due, dd.paid_amount AS total_paid,
      0::numeric AS discount, dd.balance AS balance_due
    FROM defaulter_payments dp
    JOIN defaulter_dues dd ON dd.id = dp.defaulter_due_id AND dd.school_id = ${schoolId}
    JOIN students s ON s.id = dd.student_id AND s.school_id = ${schoolId}
    JOIN persons p ON p.id = s.person_id
    LEFT JOIN LATERAL (
      SELECT receipt_no FROM receipts
      WHERE defaulter_payment_id = dp.id AND school_id = ${schoolId}
      ORDER BY issued_at DESC, id DESC
      LIMIT 1
    ) r ON true
    LEFT JOIN users u ON u.id = dp.received_by AND u.school_id = ${schoolId}
    LEFT JOIN persons receiver ON receiver.id = u.person_id
    LEFT JOIN LATERAL (
      SELECT c.name AS class_name, sec.name AS section_name
      FROM student_enrollments se
      JOIN class_sections cs ON cs.id = se.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections sec ON sec.id = cs.section_id
      WHERE se.student_id = s.id AND se.school_id = ${schoolId}
        AND se.status = 'active' AND se.deleted_at IS NULL
      ORDER BY se.created_at DESC
      LIMIT 1
    ) enroll ON true
    LEFT JOIN LATERAL (
      SELECT pp.display_name AS father_name,
        (SELECT pc.contact_value FROM person_contacts pc
         WHERE pc.person_id = pp.id AND pc.school_id = ${schoolId}
           AND pc.contact_type = 'phone' AND pc.deleted_at IS NULL
         ORDER BY pc.is_primary DESC, pc.created_at LIMIT 1) AS father_mobile
      FROM student_parents sp
      JOIN parents par ON par.id = sp.parent_id AND par.school_id = ${schoolId} AND par.deleted_at IS NULL
      JOIN persons pp ON pp.id = par.person_id
      LEFT JOIN relationship_types rt ON rt.id = sp.relationship_id
      WHERE sp.student_id = s.id AND sp.school_id = ${schoolId} AND sp.deleted_at IS NULL
      ORDER BY CASE WHEN rt.name = 'Father' THEN 0 WHEN COALESCE(sp.is_primary_contact, true) THEN 1 ELSE 2 END, sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE ${paymentFilter(sql, options)}
    ORDER BY dp.paid_at DESC, dp.id DESC
    ${limit != null ? sql`LIMIT ${limit}` : sql``}
  `;
}

export async function getArrearsCollectionSummary(sql, options) {
  const period = options.groupBy === 'month'
    ? sql`DATE_TRUNC('month', dp.paid_at)`
    : sql`DATE(dp.paid_at)`;
  const rows = await sql`
    SELECT ${period} AS period, dp.payment_method,
      COUNT(*)::int AS transaction_count, COALESCE(SUM(dp.amount), 0) AS total_amount
    FROM defaulter_payments dp
    WHERE ${paymentFilter(sql, options)}
    GROUP BY ${period}, dp.payment_method
    ORDER BY period
  `;
  return {
    rows,
    total_transactions: rows.reduce((sum, row) => sum + Number(row.transaction_count), 0),
    total_collected: rows.reduce((sum, row) => sum + Number(row.total_amount), 0),
  };
}

export async function getArrearsReceiptItems(sql, schoolId, paymentId) {
  return sql`
    SELECT dp.amount, 'Arrears — ' || dd.due_academic_year AS fee_type,
      dp.payment_method, dp.transaction_ref, dp.paid_at,
      dd.due_academic_year AS academic_year
    FROM defaulter_payments dp
    JOIN defaulter_dues dd ON dd.id = dp.defaulter_due_id AND dd.school_id = ${schoolId}
    WHERE dp.id = ${paymentId} AND dp.school_id = ${schoolId}
  `;
}
