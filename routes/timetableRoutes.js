import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== PERIODS ==============

/**
 * GET /timetable/periods
 * List all periods
 */
router.get('/periods', requirePermission('timetable.view'), asyncHandler(async (req, res) => {
    const periods = await sql`
    SELECT id, name, start_time, end_time, sort_order
    FROM periods
    ORDER BY sort_order
  `;
    res.json(periods);
}));

/**
 * POST /timetable/periods
 * Create a period
 */
router.post('/periods', requirePermission('timetable.manage'), asyncHandler(async (req, res) => {
    const { name, start_time, end_time, sort_order } = req.body;

    if (!name || !start_time || !end_time) {
        return res.status(400).json({ error: 'name, start_time, and end_time are required' });
    }

    const [period] = await sql`
    INSERT INTO periods (name, start_time, end_time, sort_order)
    VALUES (${name}, ${start_time}, ${end_time}, ${sort_order || 0})
    RETURNING *
  `;

    res.status(201).json({ message: 'Period created', period });
}));

// ============== CLASS TIMETABLE ==============

/**
 * GET /timetable/class/:classSectionId
 * Get timetable for a class
 */
router.get('/class/:classSectionId', requirePermission('timetable.view'), asyncHandler(async (req, res) => {
    const { classSectionId } = req.params;
    const { day } = req.query;

    // Get class info
    const [classInfo] = await sql`
    SELECT c.name as class_name, s.name as section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.id = ${classSectionId}
  `;

    let entries;
    if (day) {
        entries = await sql`
      SELECT 
        te.id, te.day_of_week, te.room,
        p.name as period_name, p.start_time, p.end_time, p.sort_order,
        sub.name as subject_name, sub.code as subject_code,
        teacher.display_name as teacher_name
      FROM timetable_entries te
      JOIN periods p ON te.period_id = p.id
      LEFT JOIN subjects sub ON te.subject_id = sub.id
      LEFT JOIN staff st ON te.teacher_id = st.id
      LEFT JOIN persons teacher ON st.person_id = teacher.id
      WHERE te.class_section_id = ${classSectionId}
        AND te.day_of_week = ${day}
      ORDER BY p.sort_order
    `;
    } else {
        entries = await sql`
      SELECT 
        te.id, te.day_of_week, te.room,
        p.name as period_name, p.start_time, p.end_time, p.sort_order,
        sub.name as subject_name,
        teacher.display_name as teacher_name
      FROM timetable_entries te
      JOIN periods p ON te.period_id = p.id
      LEFT JOIN subjects sub ON te.subject_id = sub.id
      LEFT JOIN staff st ON te.teacher_id = st.id
      LEFT JOIN persons teacher ON st.person_id = teacher.id
      WHERE te.class_section_id = ${classSectionId}
      ORDER BY 
        CASE te.day_of_week 
          WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
          WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
          WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 
          ELSE 7 END,
        p.sort_order
    `;
    }

    // Group by day
    const timetable = {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    days.forEach(d => timetable[d] = []);

    entries.forEach(e => {
        if (timetable[e.day_of_week]) {
            timetable[e.day_of_week].push(e);
        }
    });

    res.json({
        class_section_id: classSectionId,
        class_name: classInfo?.class_name,
        section_name: classInfo?.section_name,
        timetable: day ? entries : timetable
    });
}));

/**
 * GET /timetable/staff/:staffId
 * Get timetable for a staff member
 */
router.get('/staff/:staffId', requirePermission('timetable.view'), asyncHandler(async (req, res) => {
    const { staffId } = req.params;
    const { day } = req.query;

    // Get staff info
    const [staffInfo] = await sql`
    SELECT p.display_name, sd.name as designation
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    WHERE st.id = ${staffId}
  `;

    let entries;
    if (day) {
        entries = await sql`
      SELECT 
        te.id, te.day_of_week, te.room,
        p.name as period_name, p.start_time, p.end_time, p.sort_order,
        sub.name as subject_name,
        c.name as class_name, sec.name as section_name
      FROM timetable_entries te
      JOIN periods p ON te.period_id = p.id
      LEFT JOIN subjects sub ON te.subject_id = sub.id
      JOIN class_sections cs ON te.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections sec ON cs.section_id = sec.id
      WHERE te.teacher_id = ${staffId}
        AND te.day_of_week = ${day}
      ORDER BY p.sort_order
    `;
    } else {
        entries = await sql`
      SELECT 
        te.id, te.day_of_week, te.room,
        p.name as period_name, p.start_time, p.end_time, p.sort_order,
        sub.name as subject_name,
        c.name as class_name, sec.name as section_name
      FROM timetable_entries te
      JOIN periods p ON te.period_id = p.id
      LEFT JOIN subjects sub ON te.subject_id = sub.id
      JOIN class_sections cs ON te.class_section_id = cs.id
      JOIN classes c ON cs.class_id = c.id
      JOIN sections sec ON cs.section_id = sec.id
      WHERE te.teacher_id = ${staffId}
      ORDER BY 
        CASE te.day_of_week 
          WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 
          WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4
          WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6 
          ELSE 7 END,
        p.sort_order
    `;
    }

    // Group by day
    const timetable = {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    days.forEach(d => timetable[d] = []);

    entries.forEach(e => {
        if (timetable[e.day_of_week]) {
            timetable[e.day_of_week].push(e);
        }
    });

    res.json({
        staff_id: staffId,
        teacher_name: staffInfo?.display_name,
        designation: staffInfo?.designation,
        timetable: day ? entries : timetable
    });
}));

/**
 * POST /timetable
 * Create/update timetable entry
 */
router.post('/', requirePermission('timetable.manage'), asyncHandler(async (req, res) => {
    const { class_section_id, subject_id, teacher_id, period_id, day_of_week, room } = req.body;

    if (!class_section_id || !period_id || !day_of_week) {
        return res.status(400).json({ error: 'class_section_id, period_id, and day_of_week are required' });
    }

    const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    if (!validDays.includes(day_of_week)) {
        return res.status(400).json({ error: `day_of_week must be one of: ${validDays.join(', ')}` });
    }

    // Upsert (replace if exists)
    const [entry] = await sql`
    INSERT INTO timetable_entries (class_section_id, subject_id, teacher_id, period_id, day_of_week, room)
    VALUES (${class_section_id}, ${subject_id}, ${teacher_id}, ${period_id}, ${day_of_week}, ${room})
    ON CONFLICT (class_section_id, period_id, day_of_week)
    DO UPDATE SET 
      subject_id = EXCLUDED.subject_id,
      teacher_id = EXCLUDED.teacher_id,
      room = EXCLUDED.room
    RETURNING *
  `;

    res.status(201).json({ message: 'Timetable entry saved', entry });
}));

/**
 * DELETE /timetable/:id
 * Delete timetable entry
 */
router.delete('/:id', requirePermission('timetable.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [deleted] = await sql`DELETE FROM timetable_entries WHERE id = ${id} RETURNING id`;

    if (!deleted) {
        return res.status(404).json({ error: 'Timetable entry not found' });
    }

    res.json({ message: 'Timetable entry deleted' });
}));

export default router;
