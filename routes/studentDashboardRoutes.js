// OPT: Aggregated student dashboard — one HTTP response replaces multiple client calls (profile + notices + attendance snapshot + fee + today timetable); DB work parallelized after one context query.
import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { studentCacheGet, studentCacheSet, studentCacheKey } from '../utils/studentDataCache.js';
import { requireStudentPortal, resolveStudentId } from '../utils/studentPortal.js';

const router = express.Router();

const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * GET /api/v1/student/dashboard
 * Aggregates home-screen data in one HTTP round trip; DB work is parallelized after a single context resolve.
 */
router.get('/dashboard', requireAuth, requireStudentPortal, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  const resolvedStudentId = await resolveStudentId(req);
  if (!resolvedStudentId) {
    return res.status(404).json({ error: 'Student profile not found' });
  }

  const [ctx] = await sql`
      SELECT
        s.id AS student_id,
        s.admission_no,
        p.first_name,
        p.middle_name,
        p.last_name,
        p.display_name,
        p.dob,
        p.gender_id,
        st.code AS status,
        (
          SELECT json_build_object(
            'id', se.id,
            'roll_number', se.roll_number,
            'class_code', c.code,
            'class_name', c.name,
            'class_id', c.id,
            'section_name', sec.name,
            'section_id', sec.id,
            'class_section_id', cs.id,
            'academic_year', ay.code,
            'academic_year_id', ay.id,
            'class_teacher', (
              SELECT p_t.display_name
              FROM staff st_t
              JOIN persons p_t ON st_t.person_id = p_t.id
              WHERE st_t.id = cs.class_teacher_id
            ),
            'class_teacher_id', cs.class_teacher_id,
            'class_teacher_photo_url', (
              SELECT p_t.photo_url
              FROM staff st_t
              JOIN persons p_t ON st_t.person_id = p_t.id
              WHERE st_t.id = cs.class_teacher_id
            ),
            'class_teacher_user_id', (
              SELECT u.id
              FROM staff st_t
              JOIN users u ON u.person_id = st_t.person_id
              WHERE st_t.id = cs.class_teacher_id
              LIMIT 1
            )
          )
          FROM student_enrollments se
          JOIN class_sections cs ON se.class_section_id = cs.id
          JOIN classes c ON cs.class_id = c.id
          JOIN sections sec ON cs.section_id = sec.id
          JOIN academic_years ay ON se.academic_year_id = ay.id
          WHERE se.student_id = s.id
            AND se.status = 'active'
            AND se.deleted_at IS NULL
            AND se.school_id = ${schoolId}
          LIMIT 1
        ) AS current_enrollment
      FROM students s
      JOIN persons p ON s.person_id = p.id
      JOIN student_statuses st ON s.status_id = st.id
      WHERE s.id = ${resolvedStudentId}
        AND s.school_id = ${schoolId}
        AND s.deleted_at IS NULL
      LIMIT 1
    `;

  if (!ctx?.student_id) {
    return res.status(404).json({ error: 'Student profile not found' });
  }

  const studentId = ctx.student_id;
  const cacheKey = studentCacheKey(studentId, schoolId, 'dashboard');
  const cached = studentCacheGet(cacheKey);
  if (cached) {
    return sendSuccess(res, schoolId, cached);
  }

  const dayOfWeek = DOW[new Date().getDay()];
  const classSectionId = ctx.current_enrollment?.class_section_id;
  const academicYearId = ctx.current_enrollment?.academic_year_id;

  const [notices, attendanceBlock, upcomingFee, timetableToday] = await Promise.all([
    sql`
        SELECT
          n.id, n.title, n.content, n.title_te, n.content_te, n.audience, n.priority,
          n.is_pinned, n.publish_at AS published_at, n.expires_at, n.created_at
        FROM notices n
        WHERE n.publish_at <= NOW()
          AND n.school_id = ${schoolId}
          AND (n.expires_at IS NULL OR n.expires_at > NOW())
          AND (n.audience = 'students' OR n.audience = 'all')
        ORDER BY n.is_pinned DESC, n.publish_at DESC
        LIMIT 8
      `,
    sql`
        SELECT
          (
            SELECT row_to_json(su)
            FROM (
              SELECT
                COUNT(*) FILTER (WHERE da.status = 'present') AS present,
                COUNT(*) FILTER (WHERE da.status = 'absent') AS absent,
                COUNT(*) FILTER (WHERE da.status = 'late') AS late,
                COUNT(*)::int AS total
              FROM daily_attendance da
              JOIN student_enrollments se ON da.student_enrollment_id = se.id
              WHERE se.student_id = ${studentId}
                AND se.school_id = ${schoolId}
                AND da.deleted_at IS NULL
            ) su
          ) AS summary,
          (
            SELECT row_to_json(r)
            FROM (
              SELECT da.attendance_date, da.status, da.marked_at,
                c.name AS class_name, sec.name AS section_name
              FROM daily_attendance da
              JOIN student_enrollments se ON da.student_enrollment_id = se.id
              JOIN class_sections cs ON se.class_section_id = cs.id
              JOIN classes c ON cs.class_id = c.id
              JOIN sections sec ON cs.section_id = sec.id
              WHERE se.student_id = ${studentId}
                AND se.school_id = ${schoolId}
                AND da.deleted_at IS NULL
              ORDER BY da.attendance_date DESC
              LIMIT 1
            ) r
          ) AS latest_record
      `,
    sql`
        SELECT sf.id, sf.amount_due, sf.amount_paid, sf.discount, sf.status,
          sf.due_date, ft.name AS fee_type
        FROM student_fees sf
        JOIN fee_structures fs ON sf.fee_structure_id = fs.id
        JOIN fee_types ft ON fs.fee_type_id = ft.id
        WHERE sf.student_id = ${studentId}
          AND sf.school_id = ${schoolId}
          AND (sf.amount_due - COALESCE(sf.discount, 0) - COALESCE(sf.amount_paid, 0)) > 0
        ORDER BY sf.due_date ASC NULLS LAST
        LIMIT 1
      `,
    classSectionId && academicYearId
      ? sql`
            SELECT
              ts.id,
              ts.period_number,
              ts.start_time,
              ts.end_time,
              ts.room_no,
              sub.name AS subject_name,
              sub.name_te AS subject_name_te,
              sub.id AS subject_id,
              p.display_name AS teacher_name,
              ts.teacher_id
            FROM timetable_slots ts
            JOIN subjects sub ON ts.subject_id = sub.id
            LEFT JOIN staff st ON ts.teacher_id = st.id
            LEFT JOIN persons p ON st.person_id = p.id
            JOIN class_sections cs ON ts.class_section_id = cs.id
            WHERE ts.class_section_id = ${classSectionId}
              AND cs.school_id = ${schoolId}
              AND ts.academic_year_id = ${academicYearId}
              AND LOWER(ts.day_of_week::text) = ${dayOfWeek}
              AND ts.deleted_at IS NULL
            ORDER BY ts.period_number
          `
      : sql`SELECT id FROM timetable_slots WHERE false`,
  ]);

  const profile = {
    id: ctx.student_id,
    admission_no: ctx.admission_no,
    first_name: ctx.first_name,
    middle_name: ctx.middle_name,
    last_name: ctx.last_name,
    display_name: ctx.display_name,
    dob: ctx.dob,
    gender_id: ctx.gender_id,
    status: ctx.status,
    current_enrollment: ctx.current_enrollment,
  };

  const payload = {
    profile,
    notices,
    attendance: {
      summary: attendanceBlock?.[0]?.summary || { present: 0, absent: 0, late: 0, total: 0 },
      latest_record: attendanceBlock?.[0]?.latest_record || null,
    },
    upcoming_fee: upcomingFee?.[0] || null,
    timetable_today: Array.isArray(timetableToday) ? timetableToday : [],
  };

  studentCacheSet(cacheKey, payload, 90 * 1000);
  return sendSuccess(res, schoolId, payload);
}));

export default router;
