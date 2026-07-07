import sql from '../db.js';

/** Partial unique indexes on fee_structures (see schema.sql). */
const FEE_STRUCTURE_CLASS_UNIQUE =
  '(school_id, academic_year_id, class_id, fee_type_id) WHERE (deleted_at IS NULL AND section_id IS NULL)';
const FEE_STRUCTURE_SECTION_UNIQUE =
  '(school_id, academic_year_id, class_id, section_id, fee_type_id) WHERE (deleted_at IS NULL AND section_id IS NOT NULL)';

function logFeeModeDbError(context, err) {
  console.error(`[feeModeService] ${context}`, {
    code: err.code,
    detail: err.detail,
    constraint: err.constraint,
    table: err.table,
    message: err.message,
  });
}

/**
 * Map PostgreSQL errors from fee-mode migration to user-facing HTTP errors.
 * Always logs the raw DB payload first — never swallow constraint details.
 */
export function rethrowFeeModeDbError(err, context = 'fee mode change') {
  if (err?.status) {
    throw err;
  }

  logFeeModeDbError(context, err);

  if (err.code === '23505') {
    const constraint = err.constraint || '';
    const detail = err.detail || '';
    const isSectionLevel =
      constraint === 'idx_fee_structures_section_level_active' ||
      detail.includes('section_id IS NOT NULL');
    const isClassLevel =
      constraint === 'idx_fee_structures_class_level_active' ||
      detail.includes('section_id IS NULL');
    const isStudentFeeAssignment =
      constraint === 'idx_student_fees_unique_assignment' ||
      detail.includes('student_id, fee_structure_id');

    let message =
      'A fee record already exists for this class, fee type, and academic year. Edit the existing fee instead of creating a new one.';
    if (isStudentFeeAssignment) {
      message =
        'Could not migrate student fee records during the mode switch because of overlapping assignments. Please contact support if this persists.';
    } else if (isSectionLevel) {
      message =
        'A per-section fee is already set for this class, section, fee type, and academic year. Edit the existing fee instead of creating a new one.';
    } else if (isClassLevel) {
      message =
        'A class-level fee is already set for this class, fee type, and academic year. Edit the existing fee instead of creating a new one.';
    }

    const userErr = new Error(message);
    userErr.status = 409;
    userErr.dbCode = err.code;
    userErr.constraint = err.constraint;
    userErr.detail = err.detail;
    throw userErr;
  }

  throw err;
}

/**
 * Fee mode helpers — mutually exclusive structure types per school.
 *
 * per_class  → only fee_structures with section_id IS NULL
 * per_section → only fee_structures with section_id IS NOT NULL
 *
 * Toggling between modes is NON-DESTRUCTIVE:
 *   - The inactive mode's structures are hidden (deleted_at + mode_deactivated
 *     marker) instead of being deleted, and restored on toggle-back.
 *   - Each student's existing student_fee is re-pointed to the active mode's
 *     structure with amount_paid / discount preserved; pending is recalculated
 *     against the new amount. No fee record is ever dropped on a mode switch.
 */

export async function getSchoolFeeMode(schoolId) {
  const [row] = await sql`
    SELECT fee_mode FROM schools WHERE id = ${schoolId} LIMIT 1
  `;
  return row?.fee_mode === 'per_section' ? 'per_section' : 'per_class';
}

/** SQL fragment: filter a joined fee_structures alias to the active mode. */
export function activeStructureFilter(feeMode, alias = 'fs') {
  const col = alias ? `${alias}.section_id` : 'section_id';
  return feeMode === 'per_section'
    ? sql`AND ${sql.unsafe(col)} IS NOT NULL`
    : sql`AND ${sql.unsafe(col)} IS NULL`;
}

/** Distinct sections that appear in active student enrollments for this school. */
export async function countEnrolledSections(schoolId) {
  const [row] = await sql`
    SELECT COUNT(DISTINCT cs.section_id)::int AS cnt
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    WHERE se.school_id = ${schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
  `;
  return row?.cnt ?? 0;
}

/**
 * Soft-delete student_fees whose fee structure has been removed.
 * Payment history in fee_transactions is preserved.
 */
export async function cleanupOrphanStudentFees(schoolId) {
  const rows = await sql`
    UPDATE student_fees sf
    SET deleted_at = NOW(), updated_at = NOW()
    FROM fee_structures fs
    WHERE sf.fee_structure_id = fs.id
      AND sf.school_id = ${schoolId}
      AND sf.deleted_at IS NULL
      AND fs.deleted_at IS NOT NULL
    RETURNING sf.id
  `;
  return rows.length;
}

/**
 * Idempotent seed: duplicate each class-level fee row for every section
 * that has at least one active enrollment in that class + academic year.
 *
 * `db` lets the caller run this inside an open transaction.
 */
export async function seedPerSectionFeesFromClassLevel(schoolId, db = sql) {
  // per_class → per_section: split each active class-level row into one row per
  // enrolled section. Existing section rows (restored or manual) are left as-is.
  const inserted = await db`
    INSERT INTO fee_structures (
      school_id, academic_year_id, class_id, section_id, fee_type_id, amount, due_date, frequency
    )
    SELECT DISTINCT
      fs.school_id,
      fs.academic_year_id,
      fs.class_id,
      sec.section_id,
      fs.fee_type_id,
      fs.amount,
      fs.due_date,
      fs.frequency
    FROM fee_structures fs
    JOIN (
      SELECT DISTINCT cs.class_id, cs.academic_year_id, cs.section_id
      FROM student_enrollments se
      JOIN class_sections cs ON se.class_section_id = cs.id
      WHERE se.school_id = ${schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
    ) sec
      ON sec.class_id = fs.class_id
     AND sec.academic_year_id = fs.academic_year_id
    WHERE fs.school_id = ${schoolId}
      AND fs.section_id IS NULL
      AND fs.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM fee_structures existing
        WHERE existing.school_id = fs.school_id
          AND existing.academic_year_id = fs.academic_year_id
          AND existing.class_id = fs.class_id
          AND existing.section_id = sec.section_id
          AND existing.fee_type_id = fs.fee_type_id
          AND existing.deleted_at IS NULL
      )
    ON CONFLICT ${sql.unsafe(FEE_STRUCTURE_SECTION_UNIQUE)} DO NOTHING
    RETURNING id
  `;
  return inserted.length;
}

/**
 * Idempotent seed: collapse section-level fee rows back into one class-level
 * row per (class, fee_type, academic_year). Used when switching to per_class
 * for a school that only ever had section structures. When sections disagree
 * on amount the highest is kept, so nobody is silently undercharged.
 */
export async function seedClassLevelFeesFromSections(schoolId, db = sql) {
  // per_section → per_class: collapse section rows into one class-level row per
  // (class, fee_type, academic_year). When sections disagree, keep the highest
  // amount so nobody is silently undercharged.
  const inserted = await db`
    INSERT INTO fee_structures (
      school_id, academic_year_id, class_id, section_id, fee_type_id, amount, due_date, frequency
    )
    SELECT DISTINCT ON (fs.school_id, fs.academic_year_id, fs.class_id, fs.fee_type_id)
      fs.school_id,
      fs.academic_year_id,
      fs.class_id,
      NULL,
      fs.fee_type_id,
      fs.amount,
      fs.due_date,
      fs.frequency
    FROM fee_structures fs
    WHERE fs.school_id = ${schoolId}
      AND fs.section_id IS NOT NULL
      AND fs.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM fee_structures existing
        WHERE existing.school_id = fs.school_id
          AND existing.academic_year_id = fs.academic_year_id
          AND existing.class_id = fs.class_id
          AND existing.section_id IS NULL
          AND existing.fee_type_id = fs.fee_type_id
          AND existing.deleted_at IS NULL
      )
    ORDER BY fs.school_id, fs.academic_year_id, fs.class_id, fs.fee_type_id, fs.amount DESC
    ON CONFLICT ${sql.unsafe(FEE_STRUCTURE_CLASS_UNIQUE)} DO NOTHING
    RETURNING id
  `;
  return inserted.length;
}

/**
 * Fee-mode repointing updates fee_structure_id in place. Merge steps soft-delete
 * the source row but leave it in the table; the assignment unique index must
 * ignore deleted rows (see 003_student_fees_partial_unique.sql).
 */
export async function ensureStudentFeePartialUniqueIndex(db = sql) {
  await db.unsafe(`
    DROP INDEX IF EXISTS idx_student_fees_unique_assignment;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_student_fees_unique_assignment
    ON student_fees (student_id, fee_structure_id)
    WHERE deleted_at IS NULL;
  `);
}

/** Prevent auto_assign from racing with explicit merge/repoint during mode switch. */
export async function setFeeStructureAutoAssignEnabled(db, enabled) {
  await db.unsafe(`
    ALTER TABLE fee_structures ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER trg_auto_assign_fees_structure;
  `);
}

/**
 * When section structures are seeded, auto_assign may create fresh section
 * student_fees while class-level rows still exist. Merge paid/discount into the
 * section row and hide the class row before repointing the remainder.
 */
export async function mergeClassFeesIntoSectionFees(schoolId, db = sql) {
  const merged = await db`
    UPDATE student_fees sf_sec
    SET
      amount_paid = sf_sec.amount_paid + sf_class.amount_paid,
      discount = sf_sec.discount + sf_class.discount,
      amount_due = GREATEST(
        tgt.amount,
        sf_sec.amount_paid + sf_class.amount_paid + sf_sec.discount + sf_class.discount
      ),
      due_date = tgt.due_date,
      updated_at = NOW()
    FROM student_fees sf_class
    JOIN fee_structures src
      ON sf_class.fee_structure_id = src.id
    JOIN student_enrollments se
      ON se.student_id = sf_class.student_id
     AND se.academic_year_id = src.academic_year_id
     AND se.status = 'active'
     AND se.deleted_at IS NULL
     AND se.school_id = ${schoolId}
    JOIN class_sections cs
      ON se.class_section_id = cs.id
     AND cs.class_id = src.class_id
    JOIN fee_structures tgt
      ON tgt.school_id = src.school_id
     AND tgt.academic_year_id = src.academic_year_id
     AND tgt.class_id = src.class_id
     AND tgt.section_id = cs.section_id
     AND tgt.fee_type_id = src.fee_type_id
     AND tgt.deleted_at IS NULL
    WHERE sf_sec.fee_structure_id = tgt.id
      AND sf_sec.student_id = sf_class.student_id
      AND sf_sec.school_id = ${schoolId}
      AND sf_sec.deleted_at IS NULL
      AND sf_class.school_id = ${schoolId}
      AND sf_class.deleted_at IS NULL
      AND src.school_id = ${schoolId}
      AND src.section_id IS NULL
      AND src.deleted_at IS NULL
    RETURNING sf_class.id AS class_fee_id
  `;

  if (merged.length > 0) {
    const classFeeIds = [...new Set(merged.map((row) => row.class_fee_id))];
    await db`
      UPDATE student_fees
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE school_id = ${schoolId}
        AND id IN ${db(classFeeIds)}
        AND deleted_at IS NULL
    `;
  }

  return merged.length;
}

/**
 * Aggregate section-level student_fees onto the matching class-level structure.
 * Handles multiple section rows for the same student/fee type (section transfers)
 * without bulk-repoint unique-index collisions.
 */
export async function mergeSectionFeesIntoClassFees(schoolId, db = sql) {
  const merged = await db`
    WITH section_groups AS (
      SELECT
        sf_sec.student_id,
        tgt.id AS tgt_structure_id,
        tgt.amount AS tgt_amount,
        tgt.due_date AS tgt_due_date,
        SUM(sf_sec.amount_paid)::numeric AS total_paid,
        SUM(sf_sec.discount)::numeric AS total_discount,
        array_agg(sf_sec.id) AS section_fee_ids
      FROM student_fees sf_sec
      JOIN fee_structures src
        ON sf_sec.fee_structure_id = src.id
      JOIN fee_structures tgt
        ON tgt.school_id = src.school_id
       AND tgt.academic_year_id = src.academic_year_id
       AND tgt.class_id = src.class_id
       AND tgt.fee_type_id = src.fee_type_id
       AND tgt.section_id IS NULL
       AND tgt.deleted_at IS NULL
      WHERE sf_sec.school_id = ${schoolId}
        AND sf_sec.deleted_at IS NULL
        AND src.school_id = ${schoolId}
        AND src.section_id IS NOT NULL
        AND src.deleted_at IS NULL
      GROUP BY sf_sec.student_id, tgt.id, tgt.amount, tgt.due_date
    ),
    merged_rows AS (
      UPDATE student_fees sf_class
      SET
        amount_paid = sf_class.amount_paid + sg.total_paid,
        discount = sf_class.discount + sg.total_discount,
        amount_due = GREATEST(
          sg.tgt_amount,
          sf_class.amount_paid + sg.total_paid + sf_class.discount + sg.total_discount
        ),
        due_date = sg.tgt_due_date,
        updated_at = NOW()
      FROM section_groups sg
      WHERE sf_class.student_id = sg.student_id
        AND sf_class.fee_structure_id = sg.tgt_structure_id
        AND sf_class.school_id = ${schoolId}
        AND sf_class.deleted_at IS NULL
      RETURNING sg.section_fee_ids
    )
    SELECT unnest(section_fee_ids) AS section_fee_id FROM merged_rows
  `;

  if (merged.length > 0) {
    const sectionFeeIds = [...new Set(merged.map((row) => row.section_fee_id))];
    await db`
      UPDATE student_fees
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE school_id = ${schoolId}
        AND id IN ${db(sectionFeeIds)}
        AND deleted_at IS NULL
    `;
  }

  return merged.length;
}

/**
 * For section fees with no class-level row yet: pick one keeper per
 * (student, class structure), roll up siblings, repoint once, hide extras.
 */
export async function repointOrphanSectionFeesToClass(schoolId, db = sql) {
  const groups = await db`
    WITH section_groups AS (
      SELECT
        sf_sec.student_id,
        tgt.id AS tgt_structure_id,
        tgt.amount AS tgt_amount,
        tgt.due_date AS tgt_due_date,
        SUM(sf_sec.amount_paid)::numeric AS total_paid,
        SUM(sf_sec.discount)::numeric AS total_discount,
        (array_agg(sf_sec.id ORDER BY sf_sec.amount_paid DESC, sf_sec.created_at))[1] AS keeper_id,
        array_agg(sf_sec.id) AS section_fee_ids
      FROM student_fees sf_sec
      JOIN fee_structures src
        ON sf_sec.fee_structure_id = src.id
      JOIN fee_structures tgt
        ON tgt.school_id = src.school_id
       AND tgt.academic_year_id = src.academic_year_id
       AND tgt.class_id = src.class_id
       AND tgt.fee_type_id = src.fee_type_id
       AND tgt.section_id IS NULL
       AND tgt.deleted_at IS NULL
      WHERE sf_sec.school_id = ${schoolId}
        AND sf_sec.deleted_at IS NULL
        AND src.school_id = ${schoolId}
        AND src.section_id IS NOT NULL
        AND src.deleted_at IS NULL
      GROUP BY sf_sec.student_id, tgt.id, tgt.amount, tgt.due_date
      HAVING NOT EXISTS (
        SELECT 1 FROM student_fees sf_class
        WHERE sf_class.student_id = sf_sec.student_id
          AND sf_class.fee_structure_id = tgt.id
          AND sf_class.deleted_at IS NULL
      )
    ),
    repointed AS (
      UPDATE student_fees sf
      SET
        fee_structure_id = sg.tgt_structure_id,
        amount_paid = sg.total_paid,
        discount = sg.total_discount,
        amount_due = GREATEST(sg.tgt_amount, sg.total_paid + sg.total_discount),
        due_date = sg.tgt_due_date,
        updated_at = NOW()
      FROM section_groups sg
      WHERE sf.id = sg.keeper_id
      RETURNING sg.keeper_id, sg.section_fee_ids
    )
    SELECT keeper_id, section_fee_ids FROM repointed
  `;

  const toHide = [];
  for (const group of groups) {
    for (const feeId of group.section_fee_ids) {
      if (feeId !== group.keeper_id) {
        toHide.push(feeId);
      }
    }
  }

  if (toHide.length > 0) {
    await db`
      UPDATE student_fees
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE school_id = ${schoolId}
        AND id IN ${db(toHide)}
        AND deleted_at IS NULL
    `;
  }

  return groups.length;
}

/**
 * Re-point class-level student_fees onto the matching section-level structure
 * (each student's own section), preserving amount_paid + discount. amount_due
 * is set to the section structure's amount but never below what is already
 * paid (keeps the chk_paid_not_exceed constraint happy); the status trigger
 * recalculates pending/paid. Rows already linked to the target structure are
 * merged first — never updated in place (avoids unique-index collisions).
 */
export async function repointFeesToSection(schoolId, db = sql) {
  const merged = await mergeClassFeesIntoSectionFees(schoolId, db);

  const moved = await db`
    UPDATE student_fees sf
    SET fee_structure_id = tgt.id,
        amount_due = GREATEST(tgt.amount, sf.amount_paid + sf.discount),
        due_date = tgt.due_date,
        updated_at = NOW()
    FROM fee_structures src
    JOIN student_enrollments se
      ON se.academic_year_id = src.academic_year_id
     AND se.status = 'active'
     AND se.deleted_at IS NULL
    JOIN class_sections cs
      ON se.class_section_id = cs.id
     AND cs.class_id = src.class_id
    JOIN fee_structures tgt
      ON tgt.school_id = src.school_id
     AND tgt.academic_year_id = src.academic_year_id
     AND tgt.class_id = src.class_id
     AND tgt.section_id = cs.section_id
     AND tgt.fee_type_id = src.fee_type_id
     AND tgt.deleted_at IS NULL
    WHERE sf.fee_structure_id = src.id
      AND sf.school_id = ${schoolId}
      AND sf.deleted_at IS NULL
      AND se.student_id = sf.student_id
      AND se.school_id = ${schoolId}
      AND src.school_id = ${schoolId}
      AND src.section_id IS NULL
      AND src.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM student_fees sf_existing
        WHERE sf_existing.student_id = sf.student_id
          AND sf_existing.fee_structure_id = tgt.id
          AND sf_existing.deleted_at IS NULL
          AND sf_existing.id <> sf.id
      )
    RETURNING sf.id
  `;
  return merged + moved.length;
}

/**
 * Re-point section-level student_fees onto the matching class-level structure,
 * preserving amount_paid + discount. Inverse of repointFeesToSection.
 */
export async function repointFeesToClass(schoolId, db = sql) {
  const merged = await mergeSectionFeesIntoClassFees(schoolId, db);
  const moved = await repointOrphanSectionFeesToClass(schoolId, db);
  return merged + moved;
}

/**
 * Backstop: give every actively-enrolled student a (zero-paid) student_fee for
 * each active-mode structure they are still missing. Re-pointing handles
 * students who already had a fee; this covers students who never had one (e.g.
 * enrolled while the other mode was active). Mirrors the auto-assign triggers'
 * de-dup so it never double-charges a fee type.
 */
export async function ensureStudentFeesForActiveMode(schoolId, feeMode, db = sql) {
  const sectionMatch = feeMode === 'per_section'
    ? sql`AND fs.section_id = cs.section_id`
    : sql`AND fs.section_id IS NULL`;

  const inserted = await db`
    INSERT INTO student_fees (school_id, student_id, fee_structure_id, amount_due, amount_paid, status, due_date)
    SELECT DISTINCT fs.school_id, se.student_id, fs.id, fs.amount, 0, 'pending'::fee_status_enum, fs.due_date
    FROM fee_structures fs
    JOIN class_sections cs
      ON cs.class_id = fs.class_id
     AND cs.academic_year_id = fs.academic_year_id
    JOIN student_enrollments se
      ON se.class_section_id = cs.id
     AND se.academic_year_id = fs.academic_year_id
     AND se.status = 'active'
     AND se.deleted_at IS NULL
    WHERE fs.school_id = ${schoolId}
      AND fs.deleted_at IS NULL
      ${sectionMatch}
      AND NOT EXISTS (
        SELECT 1 FROM student_fees sf
        WHERE sf.student_id = se.student_id
          AND sf.fee_structure_id = fs.id
          AND sf.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM student_fees sf2
        JOIN fee_structures fs2 ON sf2.fee_structure_id = fs2.id
        WHERE sf2.student_id = se.student_id
          AND sf2.deleted_at IS NULL
          AND fs2.deleted_at IS NULL
          AND fs2.fee_type_id = fs.fee_type_id
          AND fs2.academic_year_id = fs.academic_year_id
          AND fs2.class_id = fs.class_id
      )
    ON CONFLICT (student_id, fee_structure_id) WHERE deleted_at IS NULL DO NOTHING
    RETURNING id
  `;
  return inserted.length;
}

/**
 * Sections with active enrollments that lack a per-section fee row (per_section mode only).
 */
export async function getMissingSectionFeeWarnings(schoolId, academicYearId = null) {
  const feeMode = await getSchoolFeeMode(schoolId);
  if (feeMode !== 'per_section') {
    return [];
  }

  const yearFilter = academicYearId
    ? sql`AND cs.academic_year_id = ${academicYearId}`
    : sql``;

  const rows = await sql`
    SELECT
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      ay.id AS academic_year_id,
      ay.code AS academic_year,
      ft.id AS fee_type_id,
      ft.name AS fee_type
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN academic_years ay ON cs.academic_year_id = ay.id
    JOIN fee_structures fs_ref
      ON fs_ref.school_id = se.school_id
     AND fs_ref.class_id = cs.class_id
     AND fs_ref.academic_year_id = cs.academic_year_id
     AND fs_ref.deleted_at IS NULL
     AND fs_ref.section_id IS NOT NULL
    JOIN fee_types ft ON fs_ref.fee_type_id = ft.id AND ft.deleted_at IS NULL
    WHERE se.school_id = ${schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      ${yearFilter}
      AND NOT EXISTS (
        SELECT 1 FROM fee_structures fs_sec
        WHERE fs_sec.school_id = se.school_id
          AND fs_sec.class_id = cs.class_id
          AND fs_sec.academic_year_id = cs.academic_year_id
          AND fs_sec.section_id = cs.section_id
          AND fs_sec.fee_type_id = fs_ref.fee_type_id
          AND fs_sec.deleted_at IS NULL
      )
    GROUP BY c.id, c.name, sec.id, sec.name, ay.id, ay.code, ft.id, ft.name
    ORDER BY ay.start_date DESC, c.name, sec.name, ft.name
  `;

  return rows;
}

/**
 * Switch a school between per_class and per_section fee modes WITHOUT losing
 * any fee structure or fee record:
 *   - the inactive mode's structures are hidden (deleted_at + mode_deactivated)
 *     so they can be restored on toggle-back;
 *   - the target mode's previously-hidden structures are restored;
 *   - each student's fee is re-pointed onto the active structure with paid
 *     amounts preserved and pending recalculated;
 *   - any student still missing the active-mode fee gets a fresh zero-paid one.
 * Runs in a single transaction so a failure leaves the school untouched.
 */
export async function setSchoolFeeMode(schoolId, feeMode) {
  if (feeMode !== 'per_class' && feeMode !== 'per_section') {
    const err = new Error("fee_mode must be 'per_class' or 'per_section'");
    err.status = 400;
    throw err;
  }

  const currentMode = await getSchoolFeeMode(schoolId);
  if (currentMode === feeMode) {
    return {
      fee_mode: feeMode,
      seeded_count: 0,
      restored_count: 0,
      migrated_count: 0,
      assigned_count: 0,
      deactivated_count: 0,
      message: 'Fee mode unchanged',
    };
  }

  if (feeMode === 'per_section') {
    const sectionCount = await countEnrolledSections(schoolId);
    if (sectionCount === 0) {
      const err = new Error(
        'No sections found. Please assign students to sections before switching to per-section fee mode.'
      );
      err.status = 400;
      throw err;
    }
  }

  try {
    return await sql.begin(async (tx) => {
      try {
        // Idempotent: older DBs still had a non-partial unique index that blocked repointing.
        await ensureStudentFeePartialUniqueIndex(tx);
        await setFeeStructureAutoAssignEnabled(tx, false);

        // Set the mode first so the validate trigger permits the target mode's rows.
        await tx`UPDATE schools SET fee_mode = ${feeMode} WHERE id = ${schoolId}`;

        if (feeMode === 'per_section') {
          // Restore section structures hidden by a previous toggle.
          const restored = await tx`
            UPDATE fee_structures
            SET deleted_at = NULL, mode_deactivated = FALSE, updated_at = NOW()
            WHERE school_id = ${schoolId}
              AND section_id IS NOT NULL
              AND mode_deactivated = TRUE
            RETURNING id
          `;

          // Split class-level rows into per-section rows (skips sections that already have one).
          const seeded = await seedPerSectionFeesFromClassLevel(schoolId, tx);

          // Move existing (paid) fees from class structures onto section structures.
          const migrated = await repointFeesToSection(schoolId, tx);

          // Hide the now-inactive class structures (kept for restore, not deleted).
          const deactivated = await tx`
            UPDATE fee_structures
            SET deleted_at = NOW(), mode_deactivated = TRUE, updated_at = NOW()
            WHERE school_id = ${schoolId}
              AND section_id IS NULL
              AND deleted_at IS NULL
            RETURNING id
          `;

          // Give any remaining enrolled students their section fee.
          const assigned = await ensureStudentFeesForActiveMode(schoolId, 'per_section', tx);

          return {
            fee_mode: 'per_section',
            seeded_count: seeded,
            restored_count: restored.length,
            migrated_count: migrated,
            assigned_count: assigned,
            deactivated_count: deactivated.length,
            migration: 'Class-level fees were split into per-section rows; paid amounts were preserved.',
          };
        }

        // per_class
        const restored = await tx`
          UPDATE fee_structures
          SET deleted_at = NULL, mode_deactivated = FALSE, updated_at = NOW()
          WHERE school_id = ${schoolId}
            AND section_id IS NULL
            AND mode_deactivated = TRUE
          RETURNING id
        `;

        const seeded = await seedClassLevelFeesFromSections(schoolId, tx);

        const migrated = await repointFeesToClass(schoolId, tx);

        const deactivated = await tx`
          UPDATE fee_structures
          SET deleted_at = NOW(), mode_deactivated = TRUE, updated_at = NOW()
          WHERE school_id = ${schoolId}
            AND section_id IS NOT NULL
            AND deleted_at IS NULL
          RETURNING id
        `;

        const assigned = await ensureStudentFeesForActiveMode(schoolId, 'per_class', tx);

        return {
          fee_mode: 'per_class',
          seeded_count: seeded,
          restored_count: restored.length,
          migrated_count: migrated,
          assigned_count: assigned,
          deactivated_count: deactivated.length,
          migration: 'Section-level fees were merged into one class-level row per fee type; paid amounts were preserved.',
        };
      } finally {
        await setFeeStructureAutoAssignEnabled(tx, true);
      }
    });
  } catch (err) {
    rethrowFeeModeDbError(err, `setSchoolFeeMode(${schoolId}, ${feeMode})`);
  }
}
