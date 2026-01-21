import express from 'express';
import sql from '../db.js';
import { requirePermission, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /attendance
 * Get attendance records with filters
 * Query params: date, class_section_id, student_id, from_date, to_date
 */
router.get('/', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
    const { date, class_section_id, student_id, from_date, to_date, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    // Build dynamic query based on filters
    let attendance;

    if (date && class_section_id) {
        // Get attendance for a specific date and class
        attendance = await sql`
      SELECT 
        da.id, da.attendance_date, da.status, da.marked_at,
        s.id as student_id, s.admission_no,
        p.display_name as student_name, p.photo_url,
        marker.display_name as marked_by_name
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      JOIN students s ON se.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN users u ON da.marked_by = u.id
      LEFT JOIN persons marker ON u.person_id = marker.id
      WHERE da.attendance_date = ${date}
        AND se.class_section_id = ${class_section_id}
        AND da.deleted_at IS NULL
      ORDER BY p.display_name
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
      ORDER BY da.attendance_date DESC
      LIMIT ${limit} OFFSET ${offset}
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
      ORDER BY c.name, sec.name, p.display_name
      LIMIT ${limit} OFFSET ${offset}
    `;
    } else {
        return res.status(400).json({
            error: 'Please provide filters: date, or (student_id + from_date + to_date)'
        });
    }

    res.json(attendance);
}));

/**
 * POST /attendance
 * Mark attendance (bulk)
 * Body: { class_section_id, date, attendance: [{ student_id, status }] }
 */
router.post('/', requirePermission('attendance.mark'), asyncHandler(async (req, res) => {
    const { class_section_id, date, attendance } = req.body;

    if (!class_section_id || !date || !attendance || !Array.isArray(attendance)) {
        return res.status(400).json({
            error: 'class_section_id, date, and attendance array are required'
        });
    }

    const markedBy = req.user?.internal_id || null;

    const results = await sql.begin(async sql => {
        const inserted = [];

        for (const record of attendance) {
            const { student_id, status } = record;

            if (!student_id || !status) continue;

            // Get active enrollment for this student in this class
            const [enrollment] = await sql`
        SELECT id FROM student_enrollments
        WHERE student_id = ${student_id}
          AND class_section_id = ${class_section_id}
          AND status = 'active'
          AND deleted_at IS NULL
        LIMIT 1
      `;

            if (!enrollment) {
                console.warn(`No active enrollment for student ${student_id} in class ${class_section_id}`);
                continue;
            }

            // Upsert attendance (delete old if exists, then insert)
            await sql`
        UPDATE daily_attendance 
        SET deleted_at = NOW() 
        WHERE student_enrollment_id = ${enrollment.id} 
          AND attendance_date = ${date}
          AND deleted_at IS NULL
      `;

            const [newRecord] = await sql`
        INSERT INTO daily_attendance (student_enrollment_id, attendance_date, status, marked_by)
        VALUES (${enrollment.id}, ${date}, ${status}, ${markedBy})
        RETURNING id, status
      `;

            inserted.push({ student_id, ...newRecord });
        }

        return inserted;
    });

    res.status(201).json({
        message: 'Attendance marked successfully',
        count: results.length,
        records: results
    });
}));

/**
 * PUT /attendance/:id
 * Update single attendance record
 */
router.put('/:id', requirePermission('attendance.edit'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
        return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['present', 'absent', 'late', 'half_day'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${validStatuses.join(', ')}` });
    }

    const [updated] = await sql`
    UPDATE daily_attendance
    SET status = ${status}, marked_by = ${req.user?.internal_id}
    WHERE id = ${id} AND deleted_at IS NULL
    RETURNING *
  `;

    if (!updated) {
        return res.status(404).json({ error: 'Attendance record not found' });
    }

    res.json({ message: 'Attendance updated', attendance: updated });
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
        ROUND(
          COUNT(*) FILTER (WHERE da.status = 'present')::numeric / 
          NULLIF(COUNT(*), 0) * 100, 2
        ) as attendance_percentage
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.student_id = ${student_id}
        AND da.deleted_at IS NULL
        ${from_date ? sql`AND da.attendance_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND da.attendance_date <= ${to_date}` : sql``}
    `;

        res.json(summary[0]);
    } else if (class_section_id) {
        // Class attendance summary for a date range
        const summary = await sql`
      SELECT 
        da.attendance_date,
        COUNT(*) FILTER (WHERE da.status = 'present') as present,
        COUNT(*) FILTER (WHERE da.status = 'absent') as absent,
        COUNT(*) FILTER (WHERE da.status = 'late') as late,
        COUNT(*) as total
      FROM daily_attendance da
      JOIN student_enrollments se ON da.student_enrollment_id = se.id
      WHERE se.class_section_id = ${class_section_id}
        AND da.deleted_at IS NULL
        ${from_date ? sql`AND da.attendance_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND da.attendance_date <= ${to_date}` : sql``}
      GROUP BY da.attendance_date
      ORDER BY da.attendance_date DESC
    `;

        res.json(summary);
    } else {
        return res.status(400).json({
            error: 'Please provide student_id or class_section_id'
        });
    }
}));

/**
 * GET /attendance/class/:classSectionId
 * Get class attendance for a specific date (or today)
 * Returns list of students with their attendance status
 */
router.get('/class/:classSectionId', requirePermission('attendance.view'), asyncHandler(async (req, res) => {
    const { classSectionId } = req.params;
    const { date = new Date().toISOString().split('T')[0] } = req.query;

    // Get all students in the class with their attendance status for the date
    const students = await sql`
    SELECT 
      s.id as student_id, s.admission_no,
      p.display_name as student_name, p.photo_url,
      se.id as enrollment_id,
      da.id as attendance_id, da.status, da.marked_at
    FROM student_enrollments se
    JOIN students s ON se.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    LEFT JOIN daily_attendance da ON da.student_enrollment_id = se.id 
      AND da.attendance_date = ${date}
      AND da.deleted_at IS NULL
    WHERE se.class_section_id = ${classSectionId}
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
    WHERE cs.id = ${classSectionId}
  `;

    res.json({
        date,
        class_section_id: classSectionId,
        class_name: classInfo?.class_name,
        section_name: classInfo?.section_name,
        total_students: students.length,
        marked_count: students.filter(s => s.status).length,
        students
    });
}));

export default router;
