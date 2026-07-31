import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { carryForwardUnpaidFees } from '../services/defaulterCarryForward.js';
import { carryForwardTransportUnpaid } from '../services/transportFeeService.js';

const router = express.Router();

// All routes require admin role + academic_year.upgrade permission
const upgradeGuard = [requireAuth, requireRole('admin', 'principal'), requirePermission('academic_year.upgrade')];
const adminGuard = [requireAuth, requireRole('admin', 'principal')];

/**
 * GET /admin/academic-year/current
 * Returns the current active academic year for this school.
 */
router.get('/current', adminGuard, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  // 1. Get active_academic_year_id from school_settings
  const [setting] = await sql`
    SELECT value FROM school_settings
    WHERE school_id = ${schoolId} AND key = 'active_academic_year_id'
  `;

  if (!setting || !setting.value) {
    // Fallback: find the most recent academic year by date range
    const [fallback] = await sql`
      SELECT id, code, start_date, end_date
      FROM academic_years
      WHERE school_id = ${schoolId}
        AND deleted_at IS NULL
      ORDER BY start_date DESC
      LIMIT 1
    `;

    if (!fallback) {
      return sendError(res, 404, 'No academic year configured for this school. Go to Academics → Academic Years to create one.');
    }

    // Auto-seed the setting so future calls don't need fallback
    await sql`
      INSERT INTO school_settings (school_id, key, value)
      VALUES (${schoolId}, 'active_academic_year_id', ${fallback.id})
      ON CONFLICT (school_id, key)
      DO UPDATE SET value = ${fallback.id}, updated_at = NOW()
    `;

    return sendSuccess(res, schoolId, {
      id: fallback.id,
      code: fallback.code,
      start_date: fallback.start_date,
      end_date: fallback.end_date,
    });
  }

  const [year] = await sql`
    SELECT id, code, start_date, end_date
    FROM academic_years
    WHERE id = ${setting.value}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;

  if (!year) {
    return sendError(res, 404, 'Active academic year not found. It may have been deleted.');
  }

  return sendSuccess(res, schoolId, year);
}));

/**
 * PUT /admin/academic-year/current
 * Set the active academic year for this school.
 */
router.put('/current', adminGuard, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { academic_year_id } = req.body;

  if (!academic_year_id) {
    return sendError(res, 400, 'academic_year_id is required.');
  }

  // Verify the year exists and belongs to this school
  const [year] = await sql`
    SELECT id, code, start_date, end_date
    FROM academic_years
    WHERE id = ${academic_year_id}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;

  if (!year) {
    return sendError(res, 404, 'Academic year not found.');
  }

  // Upsert into school_settings
  await sql`
    INSERT INTO school_settings (school_id, key, value)
    VALUES (${schoolId}, 'active_academic_year_id', ${year.id})
    ON CONFLICT (school_id, key)
    DO UPDATE SET value = ${year.id}, updated_at = NOW()
  `;

  return sendSuccess(res, schoolId, year);
}));

/**
 * POST /admin/academic-year/set-current
 * Set the active academic year for this school (POST variant).
 */
router.post('/set-current', adminGuard, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { academic_year_id } = req.body;

  if (!academic_year_id) {
    return sendError(res, 400, 'academic_year_id is required.');
  }

  const [year] = await sql`
    SELECT id, code, start_date, end_date
    FROM academic_years
    WHERE id = ${academic_year_id}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;

  if (!year) {
    return sendError(res, 404, 'Academic year not found.');
  }

  await sql`
    INSERT INTO school_settings (school_id, key, value)
    VALUES (${schoolId}, 'active_academic_year_id', ${year.id})
    ON CONFLICT (school_id, key)
    DO UPDATE SET value = ${year.id}, updated_at = NOW()
  `;

  return sendSuccess(res, schoolId, year);
}));

/**
 * GET /admin/academic-year/preview
 * Dry-run: how many students will be promoted vs graduated.
 */
router.get('/preview', upgradeGuard, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  // 1. Get current active year
  const [activeSetting] = await sql`
    SELECT value FROM school_settings
    WHERE school_id = ${schoolId} AND key = 'active_academic_year_id'
  `;

  if (!activeSetting?.value) {
    return sendError(res, 400, 'No active academic year configured. Please set it in School Settings.');
  }

  const fromYearId = activeSetting.value;

  // 2. Get the from_year details
  const [fromYear] = await sql`
    SELECT id, code FROM academic_years
    WHERE id = ${fromYearId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;

  if (!fromYear) {
    return sendError(res, 404, 'Active academic year not found.');
  }

  // 3. Find the next academic year (by start_date, after current)
  const [toYear] = await sql`
    SELECT id, code, start_date FROM academic_years
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND start_date > (SELECT start_date FROM academic_years WHERE id = ${fromYearId})
    ORDER BY start_date ASC
    LIMIT 1
  `;

  // 4. Get max sort_order among classes for this school (determines final class)
  const [maxClassRow] = await sql`
    SELECT MAX(sort_order) as max_sort_order
    FROM classes
    WHERE school_id = ${schoolId} AND deleted_at IS NULL
  `;

  const maxSortOrder = maxClassRow?.max_sort_order ?? 0;

  if (maxSortOrder <= 0) {
    return sendError(res, 400, 'Classes must have sort_order configured before performing an upgrade. Go to Academics > Classes and set the class order.');
  }

  // 5. Count active enrollments for current year, grouped by final vs. non-final class
  const counts = await sql`
    SELECT
      CASE WHEN cl.sort_order >= ${maxSortOrder} AND ${maxSortOrder} > 0
           THEN 'graduate'
           ELSE 'upgrade'
      END as action,
      COUNT(*)::int as count
    FROM student_enrollments se
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes cl ON cs.class_id = cl.id
    WHERE se.school_id = ${schoolId}
      AND se.academic_year_id = ${fromYearId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    GROUP BY action
  `;

  let upgradeCount = 0;
  let graduateCount = 0;
  for (const row of counts) {
    if (row.action === 'upgrade') upgradeCount = row.count;
    if (row.action === 'graduate') graduateCount = row.count;
  }

  return sendSuccess(res, schoolId, {
    from_year: fromYear,
    to_year: toYear || null,
    upgrade_count: upgradeCount,
    graduate_count: graduateCount,
    total: upgradeCount + graduateCount,
    max_sort_order: maxSortOrder,
    has_next_year: !!toYear,
  });
}));

/**
 * POST /admin/academic-year/upgrade
 * Execute the bulk academic year upgrade within a single transaction.
 */
router.post('/upgrade', upgradeGuard, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user?.internal_id || req.user?.id;
  const { from_year: fromYearCode, to_year: toYearCode } = req.body;

  if (!fromYearCode || !toYearCode) {
    return sendError(res, 400, 'from_year and to_year are required.');
  }

  // 1. Resolve year codes to IDs
  const [fromYear] = await sql`
    SELECT id, code FROM academic_years
    WHERE school_id = ${schoolId} AND code = ${fromYearCode} AND deleted_at IS NULL
  `;
  const [toYear] = await sql`
    SELECT id, code FROM academic_years
    WHERE school_id = ${schoolId} AND code = ${toYearCode} AND deleted_at IS NULL
  `;

  if (!fromYear) return sendError(res, 404, `Academic year "${fromYearCode}" not found.`);
  if (!toYear) return sendError(res, 404, `Academic year "${toYearCode}" not found. Create it first via Academics > Academic Years.`);

  // 2. Verify the school's current active year matches from_year (prevent double-upgrade)
  const [activeSetting] = await sql`
    SELECT value FROM school_settings
    WHERE school_id = ${schoolId} AND key = 'active_academic_year_id'
  `;

  if (activeSetting?.value && activeSetting.value !== fromYear.id) {
    return sendError(res, 409, `The school's active year is no longer "${fromYearCode}". A year upgrade may have already been performed.`);
  }

  // 3. Get max sort_order (final class)
  const [maxClassRow] = await sql`
    SELECT MAX(sort_order) as max_sort_order
    FROM classes WHERE school_id = ${schoolId} AND deleted_at IS NULL
  `;
  const maxSortOrder = maxClassRow?.max_sort_order ?? 0;

  if (maxSortOrder <= 0) {
    return sendError(res, 400, 'Classes must have sort_order configured before performing an upgrade. Go to Academics > Classes and set the class order.');
  }

  // 4. Execute the transaction
  let upgradedCount = 0;
  let graduatedCount = 0;
  let carriedForwardCount = 0;
  let transportCarriedForwardCount = 0;

  try {
    await sql.begin(async (tx) => {
      // 4a. Fetch all active enrollments for from_year
      const activeEnrollments = await tx`
        SELECT
          se.id as enrollment_id,
          se.student_id,
          se.class_section_id,
          cs.class_id,
          cs.section_id,
          cl.sort_order as class_sort_order,
          cl.name as class_name
        FROM student_enrollments se
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes cl ON cs.class_id = cl.id
        WHERE se.school_id = ${schoolId}
          AND se.academic_year_id = ${fromYear.id}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
        ORDER BY cl.sort_order ASC
      `;

      if (activeEnrollments.length === 0) {
        throw new Error('No active enrollments found for the current academic year. Nothing to upgrade.');
      }

      // 4b. Build a map of (sort_order + 1) → class_id for the next class
      const allClasses = await tx`
        SELECT id, sort_order FROM classes
        WHERE school_id = ${schoolId} AND deleted_at IS NULL
        ORDER BY sort_order ASC
      `;
      const sortOrderToClassId = new Map();
      for (const c of allClasses) {
        sortOrderToClassId.set(c.sort_order, c.id);
      }

      // 4c. Build a map of (class_id, section_id) → class_section_id for to_year
      const toYearClassSections = await tx`
        SELECT cs.id, cs.class_id, cs.section_id
        FROM class_sections cs
        WHERE cs.school_id = ${schoolId}
          AND cs.academic_year_id = ${toYear.id}
          AND cs.deleted_at IS NULL
      `;
      const csMap = new Map();
      for (const cs of toYearClassSections) {
        csMap.set(`${cs.class_id}__${cs.section_id}`, cs.id);
      }

      // 4d. Process each enrollment
      const enrollmentsToClose = [];
      const newEnrollments = [];
      const studentsToGraduate = [];
      const today = new Date().toISOString().split('T')[0];

      for (const enrollment of activeEnrollments) {
        enrollmentsToClose.push(enrollment.enrollment_id);

        if (enrollment.class_sort_order >= maxSortOrder) {
          // --- GRADUATE ---
          studentsToGraduate.push(enrollment.student_id);
          graduatedCount++;
        } else {
          // --- PROMOTE ---
          const nextSortOrder = enrollment.class_sort_order + 1;
          const nextClassId = sortOrderToClassId.get(nextSortOrder);

          if (!nextClassId) {
            throw new Error(`No class found with sort_order ${nextSortOrder}. Ensure all classes have consecutive sort_order values.`);
          }

          // Try same section in new year; if not found, try any section of the next class
          let nextCsId = csMap.get(`${nextClassId}__${enrollment.section_id}`);
          if (!nextCsId) {
            // Fallback: find any class_section for nextClassId in to_year
            const fallbackCs = toYearClassSections.find(cs => cs.class_id === nextClassId);
            if (!fallbackCs) {
              throw new Error(`No class-section mapping found for the next class (sort_order ${nextSortOrder}) in academic year "${toYearCode}". Please create class-section mappings for all classes in the new year first.`);
            }
            nextCsId = fallbackCs.id;
          }

          newEnrollments.push({
            school_id: schoolId,
            student_id: enrollment.student_id,
            academic_year_id: toYear.id,
            class_section_id: nextCsId,
            start_date: today,
            status: 'active',
          });
          upgradedCount++;
        }
      }

      // 4e. Close old enrollments (batch)
      if (enrollmentsToClose.length > 0) {
        await tx`
          UPDATE student_enrollments
          SET status = 'completed', end_date = ${today}, updated_at = NOW()
          WHERE id = ANY(${enrollmentsToClose})
            AND school_id = ${schoolId}
        `;
      }

      // 4f. Graduate students (batch)
      if (studentsToGraduate.length > 0) {
        await tx`
          UPDATE students
          SET status_id = 2,
              exit_academic_year_id = ${fromYear.id},
              exit_date = ${today},
              updated_at = NOW()
          WHERE id = ANY(${studentsToGraduate})
            AND school_id = ${schoolId}
        `;
        await tx`
          UPDATE student_transport
          SET is_active = FALSE
          WHERE student_id = ANY(${studentsToGraduate})
            AND school_id = ${schoolId}
            AND is_active = TRUE
        `;
        await tx`
          UPDATE hostel_allocations
          SET is_active = FALSE, vacated_at = COALESCE(vacated_at, NOW())
          WHERE student_id = ANY(${studentsToGraduate})
            AND school_id = ${schoolId}
            AND is_active = TRUE
        `;
      }

      // 4g. Create new enrollments (batch insert)
      if (newEnrollments.length > 0) {
        await tx`
          INSERT INTO student_enrollments ${tx(newEnrollments, 'school_id', 'student_id', 'academic_year_id', 'class_section_id', 'start_date', 'status')}
        `;
      }

      // 4h. Carry forward unpaid closing-year balances into defaulter_dues
      const carryResult = await carryForwardUnpaidFees(tx, {
        schoolId,
        fromYearId: fromYear.id,
        fromYearCode: fromYear.code,
        createdBy: userId,
      });
      carriedForwardCount = carryResult.carried_count;

      const transportCarryResult = await carryForwardTransportUnpaid(tx, {
        schoolId,
        fromYearId: fromYear.id,
        fromYearCode: fromYear.code,
        createdBy: userId,
      });
      transportCarriedForwardCount = transportCarryResult.carried_count;

      // 4i. Update active_academic_year_id in school_settings
      await tx`
        INSERT INTO school_settings (school_id, key, value)
        VALUES (${schoolId}, 'active_academic_year_id', ${toYear.id})
        ON CONFLICT (school_id, key)
        DO UPDATE SET value = ${toYear.id}, updated_at = NOW()
      `;

      // 4j. Audit log
      await tx`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, school_id)
        VALUES (
          ${userId},
          'ACADEMIC_YEAR_UPGRADE',
          'academic_years',
          ${toYear.id},
          ${sql.json({
            from_year: fromYear.code,
            to_year: toYear.code,
            from_year_id: fromYear.id,
            to_year_id: toYear.id,
            upgraded_count: upgradedCount,
            graduated_count: graduatedCount,
            carried_forward_count: carriedForwardCount,
            transport_carried_forward_count: transportCarriedForwardCount,
            total_affected: upgradedCount + graduatedCount,
            performed_at: new Date().toISOString(),
          })},
          ${schoolId}
        )
      `;
    });
  } catch (txErr) {
    // Transaction rolled back automatically on error
    console.error('[academic-year-upgrade] Transaction failed:', txErr.message);
    return sendError(res, 500, txErr.message || 'Academic year upgrade failed. All changes have been rolled back.');
  }

  return sendSuccess(res, schoolId, {
    success: true,
    upgraded_count: upgradedCount,
    graduated_count: graduatedCount,
    carried_forward_count: carriedForwardCount,
    transport_carried_forward_count: transportCarriedForwardCount,
    new_year: toYearCode,
  });
}));

export default router;
