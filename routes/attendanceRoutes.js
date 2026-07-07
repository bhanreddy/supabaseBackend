import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();
import { sendNotificationToUsers } from '../services/notificationService.js';

/**
 * Resolve which half-day session ('morning' | 'afternoon') a mark applies to.
 * The frontend should send it explicitly; if omitted we fall back to the wall
 * clock — before 13:00 counts as the morning (first period) session, otherwise
 * the afternoon (first period after lunch) session.
 */
function resolveSession(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'morning' || s === 'afternoon') return s;
  return new Date().getHours() < 13 ? 'morning' : 'afternoon';
}

/**
 * The end time of the school's lunch break (fallback 13:00). The "first period
 * after lunch" is the earliest teaching slot starting at/after this time.
 */
function lunchEndTime(schoolId) {
  return sql`
    COALESCE(
      -- Prefer an explicitly-named lunch period,
      (SELECT end_time FROM periods
        WHERE school_id = ${schoolId} AND name ILIKE '%lunch%'
        ORDER BY end_time DESC LIMIT 1),
      -- else the longest break of the day (the midday break, whatever it's named),
      (SELECT end_time FROM periods
        WHERE school_id = ${schoolId} AND is_break = true
        ORDER BY (end_time - start_time) DESC, start_time LIMIT 1),
      -- else a sane default.
      TIME '13:00'
    )
  `;
}

/**
 * Auto-detect which class section a teacher should mark for the given session.
 *   morning   → the class where they teach the first period of the day (period 1)
 *   afternoon → the class where they teach the first period AFTER lunch
 * Falls back to a static class-teacher assignment for either session.
 * Returns the class_section_id (uuid) or null.
 */
async function detectClassSectionForSession(exec, { staffId, yearId, schoolId, session }) {
  if (session === 'afternoon') {
    const [row] = await exec`
      WITH first_after_lunch AS (
        SELECT DISTINCT ON (ts.class_section_id, ts.day_of_week)
               ts.class_section_id, ts.day_of_week, ts.teacher_id
        FROM timetable_slots ts
        WHERE ts.academic_year_id = ${yearId}
          AND ts.school_id = ${schoolId}
          AND ts.deleted_at IS NULL
          AND ts.start_time >= ${lunchEndTime(schoolId)}
        ORDER BY ts.class_section_id, ts.day_of_week, ts.start_time
      )
      SELECT class_section_id AS id
      FROM first_after_lunch
      WHERE teacher_id = ${staffId}
      ORDER BY day_of_week
      LIMIT 1
    `;
    if (row) return row.id;
  } else {
    const [row] = await exec`
      SELECT class_section_id AS id
      FROM timetable_slots
      WHERE teacher_id = ${staffId}
        AND academic_year_id = ${yearId}
        AND period_number = 1
        AND school_id = ${schoolId}
        AND deleted_at IS NULL
      ORDER BY day_of_week, class_section_id
      LIMIT 1
    `;
    if (row) return row.id;
  }

  // Fallback: static class-teacher assignment (applies to either session).
  const [staticRow] = await exec`
    SELECT id FROM class_sections
    WHERE class_teacher_id = ${staffId}
      AND academic_year_id = ${yearId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  return staticRow?.id || null;
}

/**
 * Is this teacher allowed to mark the given class section for the given session?
 *   morning   → static class teacher OR period-1 subject teacher
 *   afternoon → static class teacher OR first-period-after-lunch subject teacher
 */
async function isAuthorizedForSession(exec, { staffId, classSectionId, schoolId, session }) {
  if (session === 'afternoon') {
    const [row] = await exec`
      WITH first_after_lunch AS (
        SELECT DISTINCT ON (ts.class_section_id, ts.day_of_week)
               ts.class_section_id, ts.day_of_week, ts.teacher_id
        FROM timetable_slots ts
        WHERE ts.class_section_id = ${classSectionId}
          AND ts.school_id = ${schoolId}
          AND ts.deleted_at IS NULL
          AND ts.start_time >= ${lunchEndTime(schoolId)}
        ORDER BY ts.class_section_id, ts.day_of_week, ts.start_time
      )
      SELECT 1 AS ok FROM first_after_lunch WHERE teacher_id = ${staffId}
      UNION ALL
      SELECT 1 AS ok FROM class_sections
        WHERE id = ${classSectionId} AND school_id = ${schoolId} AND class_teacher_id = ${staffId}
      LIMIT 1
    `;
    return !!row;
  }

  const [row] = await exec`
    SELECT 1 AS ok FROM class_sections cs
      WHERE cs.id = ${classSectionId} AND cs.school_id = ${schoolId} AND cs.class_teacher_id = ${staffId}
    UNION ALL
    SELECT 1 AS ok FROM timetable_slots ts
      WHERE ts.class_section_id = ${classSectionId} AND ts.school_id = ${schoolId}
        AND ts.teacher_id = ${staffId} AND ts.period_number = 1 AND ts.deleted_at IS NULL
    LIMIT 1
  `;
  return !!row;
}

/**
 * GET /attendance
 * Get attendance records with filters
 * Query params: date, class_section_id, student_id, from_date, to_date
 */
router.get('/', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  const { date, class_section_id, student_id, from_date, to_date, lastSyncedAt, page = 1 } = req.query;
  const classListLimit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200));
  const listLimit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
  const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
  const offset = (pageNum - 1) * listLimit;

  // Build dynamic query based on filters
  let attendance;

  if (date && class_section_id) {
    // Get full student list with attendance for a specific date and class
    attendance = await sql`
      SELECT
        da.id, da.attendance_date, da.status, da.morning_status, da.afternoon_status, da.marked_at,
        s.id as student_id, s.admission_no,
        p.display_name as student_name, p.photo_url,
        marker.display_name as marked_by_name
      FROM student_enrollments se
      JOIN students s ON se.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN daily_attendance da ON da.student_enrollment_id = se.id 
        AND da.attendance_date = ${date}
        AND da.deleted_at IS NULL
      LEFT JOIN users u ON da.marked_by = u.id
      LEFT JOIN persons marker ON u.person_id = marker.id
      WHERE se.class_section_id = ${class_section_id}
        AND se.school_id = ${req.schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND s.school_id = ${req.schoolId}
        ${lastSyncedAt ? sql`AND (da.updated_at >= ${lastSyncedAt} OR da.marked_at >= ${lastSyncedAt})` : sql``}
      ORDER BY p.display_name
      LIMIT ${classListLimit}
    `;
  } else if (student_id && from_date && to_date) {
    // Get attendance history for a student
    attendance = await sql`
      SELECT 
        da.id, da.attendance_date, da.status, da.marked_at,
        c.name as class_name, sec.name as section_name
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections sec ON cs.section_id = sec.id
      WHERE se.student_id = ${student_id}
        AND da.attendance_date BETWEEN ${from_date} AND ${to_date}
        AND da.deleted_at IS NULL
        ${lastSyncedAt ? sql`AND (da.updated_at >= ${lastSyncedAt} OR da.marked_at >= ${lastSyncedAt})` : sql``}
      ORDER BY da.attendance_date DESC
      LIMIT ${listLimit} OFFSET ${offset}
    `;
  } else if (date) {
    // Get all attendance for a date
    attendance = await sql`
      SELECT 
        da.id, da.attendance_date, da.status,
        s.id as student_id, s.admission_no,
        p.display_name as student_name,
        c.name as class_name, sec.name as section_name
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      JOIN students s ON se.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      JOIN class_sections cs ON se.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections sec ON cs.section_id = sec.id
      WHERE da.attendance_date = ${date}
        AND da.deleted_at IS NULL
        AND s.school_id = ${req.schoolId}
      ORDER BY c.name, sec.name, p.display_name
      LIMIT ${listLimit} OFFSET ${offset}
    `;
  } else {
    return res.status(400).json({
      error: 'Please provide filters: date, or (student_id + from_date + to_date)'
    });
  }

  return sendSuccess(res, req.schoolId, attendance);
}));

/**
 * POST /attendance
 * Mark attendance (bulk)
 * Body: { class_section_id, date, attendance: [{ student_id, status }] }
 */
// Mark attendance (bulk)
router.post('/', requirePermission('attendance.mark'), asyncHandler(async (req, res) => {
  let { class_section_id, date, attendance, records, session } = req.body;
  if (!attendance && records) attendance = records;
  const isAdmin = req.user?.roles.includes('admin');

  if (!date || !attendance || !Array.isArray(attendance)) {
    return res.status(400).json({
      error: 'date and attendance array are required'
    });
  }

  // Which half-day session this mark applies to. Each session is worth half a
  // day; the DB trigger derives the overall day status from both sessions.
  session = resolveSession(session);
  const sessionColumn = session === 'afternoon' ? 'afternoon_status' : 'morning_status';

  // Resolve the teacher's staff id once (needed for detection + authorization).
  let staff = null;
  if (!isAdmin) {
    [staff] = await sql`SELECT id FROM staff WHERE person_id = ${req.user.person_id} AND school_id = ${req.schoolId}`;
  }

  // 1. Automatic Detection for Teachers (session-aware)
  if (!class_section_id && !isAdmin) {
    const [currentYear] = await sql`SELECT id FROM academic_years WHERE now() BETWEEN start_date AND end_date AND school_id = ${req.schoolId} LIMIT 1`;
    if (staff && currentYear) {
      class_section_id = await detectClassSectionForSession(sql, {
        staffId: staff.id, yearId: currentYear.id, schoolId: req.schoolId, session,
      });
    }
  }

  if (!class_section_id) {
    return res.status(400).json({ error: 'class_section_id is required' });
  }

  // 2. Strict Authorization: Verify User may mark THIS session (unless Admin).
  //    Morning → class teacher / period-1 teacher.
  //    Afternoon → class teacher / first-period-after-lunch teacher.
  if (!isAdmin) {
    const authorized = staff && await isAuthorizedForSession(sql, {
      staffId: staff.id, classSectionId: class_section_id, schoolId: req.schoolId, session,
    });
    if (!authorized) {
      const who = session === 'afternoon'
        ? 'the Class Teacher (or the teacher of the first period after lunch)'
        : 'the Class Teacher (or the Period 1 Subject Teacher)';
      return res.status(403).json({ error: `Only ${who} can mark ${session} attendance for this class` });
    }
  }

  const markedBy = req.user?.internal_id || null;

  const results = await sql.begin(async (tx) => {
    const rows = (attendance || [])
      .filter((r) => r?.student_id && r?.status)
      .map((r) => ({ student_id: String(r.student_id), status: r.status }));
    const lastByStudent = new Map();
    for (const r of rows) {
      lastByStudent.set(r.student_id, r.status);
    }
    const studentIds = [...lastByStudent.keys()];
    if (studentIds.length === 0) return [];

    const enrollments = await tx`
      SELECT se.id AS enrollment_id, se.student_id
      FROM student_enrollments se
      WHERE se.class_section_id = ${class_section_id}
        AND se.school_id = ${req.schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
        AND se.student_id = ANY(${sql.array(studentIds)}::uuid[])
    `;
    const eMap = new Map(enrollments.map((e) => [String(e.student_id), e.enrollment_id]));
    const envIds = [];
    const statuses = [];
    for (const sid of studentIds) {
      const eid = eMap.get(sid);
      if (!eid) continue;
      envIds.push(eid);
      statuses.push(lastByStudent.get(sid));
    }
    if (envIds.length === 0) return [];

    // Write only the current session's column; the other session (if already
    // marked earlier today) is preserved. `status` is seeded here but the
    // compute_attendance_day_status() trigger derives the authoritative overall
    // value from both session columns.
    const upserted = await tx`
      INSERT INTO daily_attendance (
        school_id, student_enrollment_id, attendance_date,
        ${sql(sessionColumn)}, status, marked_by, updated_at, deleted_at
      )
      SELECT
        ${req.schoolId},
        u.enrollment_id,
        ${date}::date,
        u.status::attendance_status_enum,
        u.status::attendance_status_enum,
        ${markedBy},
        NOW(),
        NULL
      FROM unnest(
        ${sql.array(envIds)}::uuid[],
        ${sql.array(statuses)}::text[]
      ) AS u(enrollment_id, status)
      ON CONFLICT (student_enrollment_id, attendance_date)
      WHERE deleted_at IS NULL
      DO UPDATE SET
        ${sql(sessionColumn)} = EXCLUDED.${sql(sessionColumn)},
        marked_by = EXCLUDED.marked_by,
        updated_at = NOW(),
        deleted_at = NULL
      RETURNING id, status, morning_status, afternoon_status, student_enrollment_id
    `;
    const invStudent = new Map(enrollments.map((e) => [String(e.enrollment_id), String(e.student_id)]));
    return upserted.map((row) => ({
      student_id: invStudent.get(String(row.student_enrollment_id)),
      id: row.id,
      status: row.status,
      morning_status: row.morning_status,
      afternoon_status: row.afternoon_status,
      // The status the teacher just submitted for this session (drives notifications).
      session_status: session === 'afternoon' ? row.afternoon_status : row.morning_status,
    }));
  });

  // ... (Database transaction successful)

  // 3. Trigger Notifications (Async - Fire & Forget)
  // We do not await this to return the response quickly, or we can await if we want to ensure log consistency.
  // Given "stabilization", we should probably await inside a try/catch or just promise-chain it.
  // The user requirement says "Trigger notification only after successful DB operation".
  // We will run this *after* the response or asynchronously before sending response if fast enough.
  // For reliability, let's await it but catch errors so we don't fail the request.

  (async () => {
    try {
      if (!results || results.length === 0) return;

      const studentIds = results.map((r) => r.student_id).filter(Boolean);
      const notificationDate = date;

      const allTargetUsers = await sql`
        SELECT u.id as user_id, s.id as student_id, 'student'::text as role
        FROM students s
        JOIN users u ON s.person_id = u.person_id AND u.school_id = ${req.schoolId}
        WHERE s.id = ANY(${sql.array(studentIds)}::uuid[])
          AND s.school_id = ${req.schoolId}
          AND u.account_status = 'active'

        UNION ALL

        SELECT u.id as user_id, sp.student_id, 'parent'::text as role
        FROM student_parents sp
        JOIN parents p ON sp.parent_id = p.id AND p.school_id = ${req.schoolId}
        JOIN users u ON p.person_id = u.person_id AND u.school_id = ${req.schoolId}
        WHERE sp.student_id = ANY(${sql.array(studentIds)}::uuid[])
          AND sp.school_id = ${req.schoolId}
          AND u.account_status = 'active'
      `;

      if (allTargetUsers.length === 0) return;

      // Notify based on the status just marked for THIS session, not the derived
      // overall day status (which may still be pending the other session).
      const statusByStudent = new Map(results.map((r) => [String(r.student_id), r.session_status]));
      const absentUserIds = [];
      const presentUserIds = [];

      for (const u of allTargetUsers) {
        const status = statusByStudent.get(String(u.student_id));
        if (!status) continue;
        if (String(status).toLowerCase() === 'absent') {
          absentUserIds.push(u.user_id);
        } else {
          presentUserIds.push(u.user_id);
        }
      }

      const sends = [];
      if (absentUserIds.length > 0) {
        sends.push(
          sendNotificationToUsers([...new Set(absentUserIds)], 'ATTENDANCE_ABSENT', { date: notificationDate })
        );
      }
      if (presentUserIds.length > 0) {
        sends.push(
          sendNotificationToUsers(
            [...new Set(presentUserIds)],
            'ATTENDANCE_PRESENT',
            { message: `Attendance marked for ${notificationDate}.` }
          )
        );
      }
      if (sends.length > 0) await Promise.all(sends);
    } catch (notificationError) {

    }
  })();

  return sendSuccess(res, req.schoolId, {
    message: `Attendance marked successfully (${session} session)`,
    session,
    count: results.length,
    records: results
  }, 201);
}));

/**
 * PUT /attendance/:id
 * Update single attendance record
 */
router.put('/:id', requirePermission('attendance.edit'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, remarks } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required' });
  }

  const validStatuses = ['present', 'absent', 'late', 'half_day'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
  }

  const [attendanceCheck] = await sql`
    SELECT id
    FROM daily_attendance
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
  `;

  if (!attendanceCheck) {
    return res.status(404).json({ error: 'Attendance record not found' });
  }

  // Map the requested overall status onto both half-day sessions so the derived
  // `status` (recomputed by the trigger) matches what the editor intends:
  //   present  -> both sessions present   (full day)
  //   absent   -> both sessions absent
  //   half_day -> morning present, afternoon absent
  //   late     -> both sessions late
  const [morningStatus, afternoonStatus] = status === 'half_day'
    ? ['present', 'absent']
    : [status, status];

  const [updated] = await sql`
    UPDATE daily_attendance
    SET
      morning_status = ${morningStatus},
      afternoon_status = ${afternoonStatus},
      remarks = COALESCE(${remarks ?? null}, remarks),
      marked_by = ${req.user?.internal_id},
      updated_at = NOW()
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Attendance record not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Attendance updated', attendance: updated });
}));

/**
 * GET /attendance/summary
 * Get attendance summary/statistics
 * Query: student_id, class_section_id, academic_year_id, from_date, to_date
 */
router.get('/summary', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  const { student_id, class_section_id, from_date, to_date } = req.query;

  if (student_id) {
    // Student attendance summary
    const summary = await sql`
      SELECT
        COUNT(*) FILTER (WHERE da.status = 'present') as present_days,
        COUNT(*) FILTER (WHERE da.status = 'absent') as absent_days,
        COUNT(*) FILTER (WHERE da.status = 'late') as late_days,
        COUNT(*) FILTER (WHERE da.status = 'half_day') as half_days,
        COUNT(*) as total_days,
        -- Half days count as 0.5 of a present day (half + half = full day).
        (COUNT(*) FILTER (WHERE da.status = 'present')
          + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day')) as effective_present_days,
        ROUND(
          (COUNT(*) FILTER (WHERE da.status = 'present')
            + 0.5 * COUNT(*) FILTER (WHERE da.status = 'half_day'))::numeric /
          NULLIF(COUNT(*), 0) * 100, 2
        ) as attendance_percentage
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${student_id}
        AND da.deleted_at IS NULL
        ${from_date ? sql`AND da.attendance_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND da.attendance_date <= ${to_date}` : sql``}
    `;

    return sendSuccess(res, req.schoolId, summary[0]);
  } else if (class_section_id) {
    // Class attendance summary for a date range
    const summary = await sql`
      SELECT 
        da.attendance_date,
        COUNT(*) FILTER (WHERE da.status = 'present') as present,
        COUNT(*) FILTER (WHERE da.status = 'absent') as absent,
        COUNT(*) FILTER (WHERE da.status = 'late') as late,
        COUNT(*) FILTER (WHERE da.status = 'half_day') as half_day,
        COUNT(*) as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.class_section_id = ${class_section_id} AND school_id = ${req.schoolId}
        AND da.deleted_at IS NULL
        ${from_date ? sql`AND da.attendance_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND da.attendance_date <= ${to_date}` : sql``}
      GROUP BY da.attendance_date
      ORDER BY da.attendance_date DESC
    `;

    return sendSuccess(res, req.schoolId, summary);
  } else {
    return res.status(400).json({
      error: 'Please provide student_id or class_section_id'
    });
  }
}));

/**
 * GET /attendance/my-class
 * Automatically detect teacher's assigned class and student list.
 * Optional ?staff_id= lets an admin view/mark another staff member's class
 * (e.g. "view as" from Manage Staff) — requires admin role or attendance.view.
 */
router.get('/my-class', requireAuth, asyncHandler(async (req, res) => {
  const { staff_id } = req.query;
  let staff;

  if (staff_id) {
    const isAdmin = req.user.roles.includes('admin');
    const canView = req.user.permissions.includes('attendance.view');
    if (!isAdmin && !canView) {
      return res.status(403).json({ error: 'Forbidden: Missing permission attendance.view' });
    }
    [staff] = await sql`SELECT id FROM staff WHERE id = ${staff_id} AND school_id = ${req.schoolId}`;
  } else {
    // 1. Get staff profile for current user
    [staff] = await sql`SELECT id FROM staff WHERE person_id = ${req.user.person_id} AND school_id = ${req.schoolId}`;
  }
  if (!staff) {
    return res.status(404).json({ error: 'Staff profile not found' });
  }

  // 2. Get current academic year
  const [currentYear] = await sql`SELECT id FROM academic_years WHERE now() BETWEEN start_date AND end_date AND school_id = ${req.schoolId} LIMIT 1`;
  if (!currentYear) {
    return res.status(404).json({ error: 'No active academic year found' });
  }

  // 3. Find the class section this teacher marks for the requested session.
  //    Morning → first period of the day; Afternoon → first period after lunch;
  //    fallback → static class-teacher assignment.
  const session = resolveSession(req.query.session);
  const classSectionId = await detectClassSectionForSession(sql, {
    staffId: staff.id, yearId: currentYear.id, schoolId: req.schoolId, session,
  });

  if (!classSectionId) {
    return res.status(404).json({
      error: session === 'afternoon'
        ? 'No class assigned to you for the first period after lunch this academic year'
        : 'No class assigned to you as a Class Teacher for the current academic year'
    });
  }
  const classSection = { id: classSectionId };

  // 4. Load students for this class section (reusing logic)
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const students = await sql`
    SELECT 
      s.id as student_id, s.admission_no,
      p.display_name as student_name, p.photo_url,
      se.id as enrollment_id,
      da.id as attendance_id, da.status, da.morning_status, da.afternoon_status, da.marked_at
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN daily_attendance da ON da.student_enrollment_id = se.id 
      AND da.attendance_date = ${date}
      AND da.deleted_at IS NULL
    WHERE se.class_section_id = ${classSection.id}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND s.deleted_at IS NULL
    ORDER BY p.display_name
  `;

  const [classInfo] = await sql`
    SELECT c.name as class_name, s.name as section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.id = ${classSection.id} AND cs.school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, {
    date,
    session,
    class_section_id: classSection.id,
    class_name: classInfo?.class_name,
    section_name: classInfo?.section_name,
    total_students: students.length,
    marked_count: students.filter((s) => s.status).length,
    morning_marked_count: students.filter((s) => s.morning_status).length,
    afternoon_marked_count: students.filter((s) => s.afternoon_status).length,
    students
  });
}));

/**
 * GET /attendance/class/:classSectionId
 * Get class attendance for a specific date (or today)
 * Returns list of students with their attendance status
 */
router.get('/class/:classSectionId', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  let { classSectionId } = req.params;

  // 1. Automatic Detection if ID is missing or literal 'undefined'/'null'
  if (!classSectionId || classSectionId === 'undefined' || classSectionId === 'null') {
    const isAdmin = req.user?.roles.includes('admin');
    if (!isAdmin) {
      // Auto-detect for teacher
      const [staff] = await sql`SELECT id FROM staff WHERE person_id = ${req.user.person_id} AND school_id = ${req.schoolId}`;
      const [currentYear] = await sql`SELECT id FROM academic_years WHERE now() BETWEEN start_date AND end_date AND school_id = ${req.schoolId} LIMIT 1`;

      if (staff && currentYear) {
        // Session-aware: morning → period 1, afternoon → first period after lunch,
        // fallback → static class-teacher assignment.
        const session = resolveSession(req.query.session);
        classSectionId = await detectClassSectionForSession(sql, {
          staffId: staff.id, yearId: currentYear.id, schoolId: req.schoolId, session,
        }) || classSectionId;
      }
    }
  }

  if (!classSectionId || classSectionId === 'undefined' || classSectionId === 'null') {
    return res.status(400).json({ error: 'Class Section ID required (not automatically detectable for this user)' });
  }

  const { date = new Date().toISOString().split('T')[0] } = req.query;

  // Get all students in the class with their attendance status for the date
  const students = await sql`
    SELECT 
      s.id as student_id, s.admission_no,
      p.display_name as student_name, p.photo_url,
      se.id as enrollment_id,
      da.id as attendance_id, da.status, da.morning_status, da.afternoon_status, da.marked_at
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN daily_attendance da ON da.student_enrollment_id = se.id 
      AND da.attendance_date = ${date}
      AND da.deleted_at IS NULL
    WHERE se.class_section_id = ${classSectionId}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND s.deleted_at IS NULL
    ORDER BY p.display_name
  `;

  // Get class info
  const [classInfo] = await sql`
    SELECT c.name as class_name, s.name as section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.id = ${classSectionId} AND cs.school_id = ${req.schoolId}
  `;

  return sendSuccess(res, req.schoolId, {
    date,
    class_section_id: classSectionId,
    class_name: classInfo?.class_name,
    section_name: classInfo?.section_name,
    total_students: students.length,
    marked_count: students.filter((s) => s.status).length,
    morning_marked_count: students.filter((s) => s.morning_status).length,
    afternoon_marked_count: students.filter((s) => s.afternoon_status).length,
    students
  });
}));

/**
 * GET /attendance/staff
 * Get staff attendance for a specific date
 * Query: date
 */
router.get('/staff', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  const attendance = await sql`
        SELECT 
            s.id as staff_id, s.staff_code,
            p.display_name as staff_name, p.photo_url,
            sd.name as designation,
            sa.id as attendance_id, sa.attendance_date, sa.status, sa.marked_at
        FROM staff s
        JOIN persons p ON s.person_id = p.id
        LEFT JOIN staff_designations sd ON s.designation_id = sd.id
        LEFT JOIN staff_attendance sa ON s.id = sa.staff_id 
            AND sa.attendance_date = ${date}
            AND sa.deleted_at IS NULL
        WHERE s.deleted_at IS NULL
          AND s.school_id = ${req.schoolId}
          AND s.status_id = 1 -- Only active staff
        ORDER BY p.display_name
    `;

  return sendSuccess(res, req.schoolId, attendance);
}));

/**
 * POST /attendance/staff
 * Mark staff attendance (bulk)
 * Body: { date, attendance: [{ staff_id, status }] }
 */
router.post('/staff', requirePermission('attendance.mark'), asyncHandler(async (req, res) => {
  const { date, attendance } = req.body;

  if (!date || !attendance || !Array.isArray(attendance)) {
    return res.status(400).json({
      error: 'date and attendance array are required'
    });
  }

  const markedBy = req.user?.internal_id || null;
  const rows = (attendance || []).filter((r) => r?.staff_id && r?.status);
  if (rows.length === 0) {
    return res.status(400).json({ error: 'No valid staff attendance records provided' });
  }

  const lastByStaff = new Map();
  for (const r of rows) {
    lastByStaff.set(String(r.staff_id), r.status);
  }
  const staffIdArr = [...lastByStaff.keys()];
  const statusArr = staffIdArr.map((id) => lastByStaff.get(id));

  const validStaff = await sql`
    SELECT id
    FROM staff
    WHERE id = ANY(${sql.array(staffIdArr)}::uuid[])
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
  `;

  if (validStaff.length !== staffIdArr.length) {
    return res.status(400).json({
      error: 'One or more staff IDs not found in this school',
      expected: staffIdArr.length,
      found: validStaff.length
    });
  }

  const upserted = await sql`
    INSERT INTO staff_attendance (school_id, staff_id, attendance_date, status, marked_by)
    SELECT
      ${req.schoolId},
      u.staff_id,
      ${date}::date,
      u.status::attendance_status_enum,
      ${markedBy}
    FROM unnest(
      ${sql.array(staffIdArr)}::uuid[],
      ${sql.array(statusArr)}::text[]
    ) AS u(staff_id, status)
    ON CONFLICT (staff_id, attendance_date)
    DO UPDATE SET
      school_id  = EXCLUDED.school_id,
      status     = EXCLUDED.status,
      marked_by  = EXCLUDED.marked_by,
      updated_at = NOW(),
      deleted_at = NULL
    RETURNING id, staff_id, status
  `;

  const results = upserted.map((row) => ({ staff_id: row.staff_id, status: row.status }));

  return sendSuccess(res, req.schoolId, {
    message: 'Staff attendance marked successfully',
    count: results.length,
    records: results
  }, 201);
}));


/**
 * GET /attendance/staff/me
 * Get current staff member's attendance history
 * Query params: from_date, to_date
 */
router.get('/staff/me', requireAuth, asyncHandler(async (req, res) => {
  // 1. Identify staff based on person_id from auth token
  const [staff] = await sql`SELECT id FROM staff WHERE person_id = ${req.user.person_id} AND school_id = ${req.schoolId}`;
  if (!staff) {
    return res.status(404).json({ error: 'Staff profile not found' });
  }

  const { from_date, to_date } = req.query;

  // 2. Fetch history
  const history = await sql`
    SELECT 
      sa.id, sa.attendance_date, sa.status, sa.marked_at
    FROM staff_attendance sa
    WHERE sa.staff_id = ${staff.id}
      AND sa.deleted_at IS NULL
      ${from_date ? sql`AND sa.attendance_date >= ${from_date}` : sql``}
      ${to_date ? sql`AND sa.attendance_date <= ${to_date}` : sql``}
    ORDER BY sa.attendance_date DESC
  `;

  return sendSuccess(res, req.schoolId, history);
}));

export default router;