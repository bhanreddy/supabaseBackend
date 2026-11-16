import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { resolveStudentParamWithAccess } from '../utils/studentPortal.js';

const router = express.Router({ mergeParams: true });
/**
 * GET /students/:id/attendance
 * Get attendance records for a student
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const targetStudentId = await resolveStudentParamWithAccess(req, res, id);
    if (!targetStudentId) return;

    const { from_date, to_date, limit = 30, page } = req.query;
    const usePaging = page !== undefined;
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 30, 200));
    const pg = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pg - 1) * lim;

    // This is the deployed v1 contract: raw history and the original summary,
    // including ranges spanning academic years. V2 classification/report limits
    // apply only to the additive /calendar and /report endpoints.
    let attendance;
    if (from_date && to_date) {
      attendance = usePaging
        ? await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${lim} OFFSET ${offset}
      `
        : await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
      `;
    } else {
      attendance = usePaging
        ? await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${lim} OFFSET ${offset}
      `
        : await sql`
        SELECT 
          da.attendance_date, da.status, da.marked_at,
          c.name as class_name, s.name as section_name
        FROM daily_attendance da
        JOIN student_enrollments se ON da.student_enrollment_id = se.id
        JOIN class_sections cs ON se.class_section_id = cs.id
        JOIN classes c ON cs.class_id = c.id
        JOIN sections s ON cs.section_id = s.id
        WHERE se.student_id = ${targetStudentId}
          AND se.school_id = ${req.schoolId}
          AND da.deleted_at IS NULL
        ORDER BY da.attendance_date DESC
        LIMIT ${lim}
      `;
    }

    // Calculate summary (respect optional date range used for records)
    const summary = (from_date && to_date)
      ? await sql`
      SELECT 
        COUNT(*) FILTER (WHERE da.status = 'present')::int as present,
        COUNT(*) FILTER (WHERE da.status = 'absent')::int as absent,
        COUNT(*) FILTER (WHERE da.status = 'late')::int as late,
        COUNT(*) FILTER (WHERE da.status = 'half_day')::int as half_day,
        (
          COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
        )::float as effective_present,
        (
          COUNT(*) FILTER (WHERE da.status = 'absent')
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
        )::float as effective_absent,
        ROUND(
          (
            COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
            + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
          )::numeric / NULLIF(COUNT(*), 0) * 100,
          1
        )::float as attendance_percentage,
        COUNT(*)::int as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
        AND da.deleted_at IS NULL
    `
      : await sql`
      SELECT 
        COUNT(*) FILTER (WHERE da.status = 'present')::int as present,
        COUNT(*) FILTER (WHERE da.status = 'absent')::int as absent,
        COUNT(*) FILTER (WHERE da.status = 'late')::int as late,
        COUNT(*) FILTER (WHERE da.status = 'half_day')::int as half_day,
        (
          COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
        )::float as effective_present,
        (
          COUNT(*) FILTER (WHERE da.status = 'absent')
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
        )::float as effective_absent,
        ROUND(
          (
            COUNT(*) FILTER (WHERE da.status IN ('present', 'late'))
            + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')
          )::numeric / NULLIF(COUNT(*), 0) * 100,
          1
        )::float as attendance_percentage,
        COUNT(*)::int as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${targetStudentId}
        AND se.school_id = ${req.schoolId}
        AND da.deleted_at IS NULL
    `;

    if (usePaging) {
      let countQuery;
      if (from_date && to_date) {
        countQuery = sql`
          SELECT count(*)::int as total
          FROM daily_attendance da
          JOIN student_enrollments se ON da.student_enrollment_id = se.id
          WHERE se.student_id = ${targetStudentId}
            AND se.school_id = ${req.schoolId}
            AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
            AND da.deleted_at IS NULL
        `;
      } else {
        countQuery = sql`
          SELECT count(*)::int as total
          FROM daily_attendance da
          JOIN student_enrollments se ON da.student_enrollment_id = se.id
          WHERE se.student_id = ${targetStudentId}
            AND se.school_id = ${req.schoolId}
            AND da.deleted_at IS NULL
        `;
      }
      const [countResult] = await countQuery;
      return sendSuccess(res, req.schoolId, {
        summary: summary[0],
        records: attendance,
        meta: {
          total: countResult.total,
          page: pg,
          limit: lim,
          total_pages: Math.ceil(countResult.total / lim) || 1,
        },
      });
    }

    sendSuccess(res, req.schoolId, {
      summary: summary[0],
      records: attendance
    });
  } catch (error) {

    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to fetch attendance' });
  }
});

export default router;
