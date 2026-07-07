import sql from '../db.js';

/**
 * Carry forward unpaid closing-year fee balances into defaulter_dues.
 * Uses ON CONFLICT DO NOTHING to respect existing manual_legacy rows.
 *
 * @param {object} tx - postgres.js transaction client
 * @param {object} params
 * @param {number|string} params.schoolId
 * @param {string} params.fromYearId - UUID of the year being closed
 * @param {string} params.fromYearCode - e.g. "2025-26"
 * @param {string|null} params.createdBy - user UUID
 */
export async function carryForwardUnpaidFees(tx, { schoolId, fromYearId, fromYearCode, createdBy }) {
  const unpaidByStudent = await tx`
    SELECT
      sf.student_id,
      SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0))::numeric AS total_balance
    FROM student_fees sf
    JOIN fee_structures fs ON sf.fee_structure_id = fs.id
    WHERE sf.school_id = ${schoolId}
      AND fs.academic_year_id = ${fromYearId}
      AND sf.deleted_at IS NULL
      AND GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0) > 0
    GROUP BY sf.student_id
  `;

  if (unpaidByStudent.length === 0) {
    return { carried_count: 0 };
  }

  let carriedCount = 0;

  for (const row of unpaidByStudent) {
    const balance = Number(row.total_balance);
    if (!Number.isFinite(balance) || balance <= 0) continue;

    const [inserted] = await tx`
      INSERT INTO defaulter_dues (
        school_id,
        student_id,
        due_academic_year,
        original_amount,
        paid_amount,
        source,
        created_by
      )
      VALUES (
        ${schoolId},
        ${row.student_id},
        ${fromYearCode},
        ${balance},
        0,
        'carried_forward',
        ${createdBy}
      )
      ON CONFLICT (school_id, student_id, due_academic_year) DO NOTHING
      RETURNING id
    `;

    if (inserted) carriedCount++;
  }

  return { carried_count: carriedCount, eligible_count: unpaidByStudent.length };
}

/**
 * Resolve the active academic year code for a school.
 */
export async function getActiveAcademicYearCode(schoolId, db = sql) {
  const [setting] = await db`
    SELECT value FROM school_settings
    WHERE school_id = ${schoolId} AND key = 'active_academic_year_id'
  `;

  if (setting?.value) {
    const [year] = await db`
      SELECT code FROM academic_years
      WHERE id = ${setting.value}
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
    `;
    if (year?.code) return year.code;
  }

  const [fallback] = await db`
    SELECT code FROM academic_years
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
    ORDER BY start_date DESC
    LIMIT 1
  `;

  return fallback?.code ?? null;
}
