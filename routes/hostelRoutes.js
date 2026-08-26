import express from 'express';
import sql from '../db.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { requireStudentPortal, resolveStudentId } from '../utils/studentPortal.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();
const REQUEST_TYPES = new Set(['outing', 'overnight_leave', 'late_return', 'visitor', 'other']);

function cleanText(value, maxLength = 500) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function positiveInteger(value, fallback = null) {
  if (value === '' || value == null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeMoney(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Number(parsed.toFixed(2)) : undefined;
}

function optionalInteger(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

async function currentAcademicYear(schoolId, db = sql) {
  const [year] = await db`
    SELECT id, code, start_date, end_date
    FROM academic_years
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND (NOW() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN start_date AND end_date
    ORDER BY start_date DESC
    LIMIT 1
  `;
  return year || null;
}

async function activeRoom(roomId, schoolId, db = sql) {
  const [room] = await db`
    SELECT hr.id, hr.block_id, hr.capacity, hr.room_no, hr.floor, hr.room_type, hr.monthly_fee
    FROM hostel_rooms hr
    JOIN hostel_blocks hb ON hb.id = hr.block_id AND hb.school_id = ${schoolId}
    WHERE hr.id = ${roomId}
      AND hr.school_id = ${schoolId}
      AND hr.deleted_at IS NULL
      AND hb.deleted_at IS NULL
      AND hb.is_active = TRUE
      AND hr.is_available = TRUE
  `;
  return room || null;
}

// ============== SUMMARY + ACADEMIC YEAR ==============

router.get('/summary', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const [summary] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM hostel_blocks
       WHERE school_id = ${req.schoolId} AND deleted_at IS NULL AND is_active = TRUE) AS blocks,
      (SELECT COUNT(*)::int FROM hostel_rooms
       WHERE school_id = ${req.schoolId} AND deleted_at IS NULL) AS rooms,
      (SELECT COALESCE(SUM(capacity), 0)::int FROM hostel_rooms
       WHERE school_id = ${req.schoolId} AND deleted_at IS NULL AND is_available = TRUE) AS beds,
      (SELECT COUNT(*)::int FROM hostel_allocations
       WHERE school_id = ${req.schoolId} AND is_active = TRUE) AS occupied,
      (SELECT COUNT(*)::int FROM hostel_permission_requests
       WHERE school_id = ${req.schoolId} AND status = 'pending') AS pending_requests
  `;
  return sendSuccess(res, req.schoolId, summary);
}));

router.get('/academic-years/current', requireAuth, asyncHandler(async (req, res) => {
  const year = await currentAcademicYear(req.schoolId);
  if (!year) return res.status(404).json({ error: 'No active academic year found' });
  return sendSuccess(res, req.schoolId, year);
}));

// ============== PARENT / STUDENT SELF SERVICE ==============

router.get('/me', requireStudentPortal, asyncHandler(async (req, res) => {
  const studentId = await resolveStudentId(req);
  if (!studentId) return res.status(404).json({ error: 'Student profile not found' });

  const [profile] = await sql`
    SELECT
      s.id AS student_id, s.admission_no, p.display_name AS student_name,
      ha.id AS allocation_id, ha.bed_no, ha.allocated_at,
      ay.code AS academic_year, hr.room_no, hr.floor, hr.room_type, hr.monthly_fee,
      hb.name AS block_name, hb.code AS block_code,
      warden_person.display_name AS warden_name
    FROM students s
    JOIN persons p ON p.id = s.person_id
    LEFT JOIN hostel_allocations ha
      ON ha.student_id = s.id AND ha.school_id = ${req.schoolId} AND ha.is_active = TRUE
    LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id AND hr.school_id = ${req.schoolId}
    LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id AND hb.school_id = ${req.schoolId}
    LEFT JOIN academic_years ay ON ay.id = ha.academic_year_id
    LEFT JOIN staff warden ON warden.id = hb.warden_id AND warden.school_id = ${req.schoolId}
    LEFT JOIN persons warden_person ON warden_person.id = warden.person_id
    WHERE s.id = ${studentId} AND s.school_id = ${req.schoolId} AND s.deleted_at IS NULL
    ORDER BY ha.allocated_at DESC NULLS LAST
    LIMIT 1
  `;
  if (!profile) return res.status(404).json({ error: 'Student profile not found' });
  return sendSuccess(res, req.schoolId, {
    ...profile,
    annual_fee: profile.monthly_fee == null ? null : Number(profile.monthly_fee) * 12,
    is_allocated: Boolean(profile.allocation_id),
  });
}));

router.get('/me/requests', requireStudentPortal, asyncHandler(async (req, res) => {
  const studentId = await resolveStudentId(req);
  if (!studentId) return res.status(404).json({ error: 'Student profile not found' });
  const requests = await sql`
    SELECT id, request_type, reason, starts_on, ends_on, status,
           admin_note, reviewed_at, created_at
    FROM hostel_permission_requests
    WHERE school_id = ${req.schoolId} AND student_id = ${studentId}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return sendSuccess(res, req.schoolId, requests);
}));

router.post('/me/requests', requireStudentPortal, asyncHandler(async (req, res) => {
  const studentId = await resolveStudentId(req);
  if (!studentId) return res.status(404).json({ error: 'Student profile not found' });

  const requestType = cleanText(req.body?.request_type, 40);
  const reason = cleanText(req.body?.reason, 1000);
  const startsOn = cleanText(req.body?.starts_on, 10);
  const endsOn = cleanText(req.body?.ends_on, 10);
  if (!requestType || !REQUEST_TYPES.has(requestType)) {
    return res.status(400).json({ error: 'Select a valid permission type' });
  }
  if (!reason) return res.status(400).json({ error: 'Reason is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endsOn || '')) {
    return res.status(400).json({ error: 'Start and end dates are required in YYYY-MM-DD format' });
  }
  if (endsOn < startsOn) return res.status(400).json({ error: 'End date cannot be before start date' });

  const [allocation] = await sql`
    SELECT id FROM hostel_allocations
    WHERE school_id = ${req.schoolId} AND student_id = ${studentId} AND is_active = TRUE
    LIMIT 1
  `;
  if (!allocation) return res.status(409).json({ error: 'Hostel permission requests require an active hostel allocation' });

  const [request] = await sql`
    INSERT INTO hostel_permission_requests (
      school_id, student_id, request_type, reason, starts_on, ends_on, requested_by
    ) VALUES (
      ${req.schoolId}, ${studentId}, ${requestType}, ${reason}, ${startsOn}, ${endsOn}, ${req.user.internal_id}
    )
    RETURNING id, request_type, reason, starts_on, ends_on, status, created_at
  `;
  return sendSuccess(res, req.schoolId, { message: 'Permission request sent', request }, 201);
}));

// ============== BLOCKS ==============

router.get('/blocks', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const blocks = await sql`
    SELECT hb.id, hb.name, hb.code, hb.total_rooms, hb.is_active, hb.gender_id,
      g.name AS gender, warden_person.display_name AS warden_name,
      (SELECT COUNT(*)::int FROM hostel_rooms room_count
       WHERE room_count.block_id = hb.id AND room_count.school_id = ${req.schoolId}
         AND room_count.deleted_at IS NULL) AS room_count,
      (SELECT COALESCE(SUM(capacity), 0)::int FROM hostel_rooms room_capacity
       WHERE room_capacity.block_id = hb.id AND room_capacity.school_id = ${req.schoolId}
         AND room_capacity.deleted_at IS NULL) AS total_capacity,
      (SELECT COUNT(*)::int FROM hostel_allocations allocation_count
       JOIN hostel_rooms occupied_room ON occupied_room.id = allocation_count.room_id
       WHERE occupied_room.block_id = hb.id AND allocation_count.school_id = ${req.schoolId}
         AND allocation_count.is_active = TRUE) AS occupied_beds
    FROM hostel_blocks hb
    LEFT JOIN genders g ON g.id = hb.gender_id
    LEFT JOIN staff warden ON warden.id = hb.warden_id AND warden.school_id = ${req.schoolId}
    LEFT JOIN persons warden_person ON warden_person.id = warden.person_id
    WHERE hb.school_id = ${req.schoolId} AND hb.deleted_at IS NULL
    ORDER BY hb.name
  `;
  return sendSuccess(res, req.schoolId, blocks);
}));

router.post('/blocks', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const name = cleanText(req.body?.name, 100);
  const code = cleanText(req.body?.code, 20);
  const wardenId = req.body?.warden_id || null;
  if (!name) return res.status(400).json({ error: 'Block name is required' });
  if (wardenId) {
    const [warden] = await sql`
      SELECT id FROM staff
      WHERE id = ${wardenId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!warden) return res.status(404).json({ error: 'Warden not found' });
  }
  const [block] = await sql`
    INSERT INTO hostel_blocks (school_id, name, code, gender_id, warden_id)
    VALUES (${req.schoolId}, ${name}, ${code}, ${req.body?.gender_id || null}, ${wardenId})
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, { message: 'Block created', block }, 201);
}));

router.put('/blocks/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const name = cleanText(req.body?.name, 100);
  if (!name) return res.status(400).json({ error: 'Block name is required' });
  const [block] = await sql`
    UPDATE hostel_blocks
    SET name = ${name}, code = ${cleanText(req.body?.code, 20)},
        is_active = COALESCE(${req.body?.is_active ?? null}, is_active)
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING *
  `;
  if (!block) return res.status(404).json({ error: 'Block not found' });
  return sendSuccess(res, req.schoolId, { message: 'Block updated', block });
}));

router.delete('/blocks/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const [occupied] = await sql`
    SELECT 1 FROM hostel_allocations ha
    JOIN hostel_rooms hr ON hr.id = ha.room_id
    WHERE hr.block_id = ${req.params.id} AND ha.school_id = ${req.schoolId} AND ha.is_active = TRUE
    LIMIT 1
  `;
  if (occupied) return res.status(409).json({ error: 'Vacate all students before deleting this block' });
  const [block] = await sql`
    UPDATE hostel_blocks SET deleted_at = NOW(), is_active = FALSE
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!block) return res.status(404).json({ error: 'Block not found' });
  await sql`
    UPDATE hostel_rooms SET deleted_at = NOW(), is_available = FALSE
    WHERE block_id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  return sendSuccess(res, req.schoolId, { message: 'Block deleted' });
}));

// ============== ROOMS + FEES ==============

router.get('/rooms', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const { block_id: blockId, available_only: availableOnly } = req.query;
  const rooms = await sql`
    SELECT hr.id, hr.block_id, hr.room_no, hr.floor, hr.capacity, hr.room_type,
      hr.monthly_fee, hr.is_available, hb.name AS block_name,
      COUNT(ha.id) FILTER (WHERE ha.is_active = TRUE)::int AS occupied_beds
    FROM hostel_rooms hr
    JOIN hostel_blocks hb ON hb.id = hr.block_id AND hb.school_id = ${req.schoolId}
    LEFT JOIN hostel_allocations ha ON ha.room_id = hr.id AND ha.school_id = ${req.schoolId}
    WHERE hr.school_id = ${req.schoolId} AND hr.deleted_at IS NULL AND hb.deleted_at IS NULL
      ${blockId ? sql`AND hr.block_id = ${blockId}` : sql``}
      ${availableOnly === 'true' ? sql`AND hr.is_available = TRUE` : sql``}
    GROUP BY hr.id, hb.name
    ORDER BY hb.name, hr.floor NULLS FIRST, hr.room_no
  `;
  return sendSuccess(res, req.schoolId, rooms);
}));

router.post('/rooms', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const blockId = req.body?.block_id;
  const roomNo = cleanText(req.body?.room_no, 20);
  const capacity = positiveInteger(req.body?.capacity, 2);
  const floor = optionalInteger(req.body?.floor);
  const fee = nonNegativeMoney(req.body?.monthly_fee);
  if (!blockId || !roomNo) return res.status(400).json({ error: 'Block and room number are required' });
  if (!capacity) return res.status(400).json({ error: 'Capacity must be a positive whole number' });
  if (floor === undefined) return res.status(400).json({ error: 'Floor must be a whole number' });
  if (fee === undefined) return res.status(400).json({ error: 'Monthly fee must be zero or greater' });
  const [block] = await sql`
    SELECT id FROM hostel_blocks
    WHERE id = ${blockId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!block) return res.status(404).json({ error: 'Block not found' });
  const [room] = await sql`
    INSERT INTO hostel_rooms (school_id, block_id, room_no, floor, capacity, room_type, monthly_fee)
    VALUES (${req.schoolId}, ${blockId}, ${roomNo}, ${floor}, ${capacity},
      ${cleanText(req.body?.room_type, 50) || 'shared'}, ${fee})
    RETURNING *
  `;
  await sql`
    UPDATE hostel_blocks SET total_rooms = (
      SELECT COUNT(*) FROM hostel_rooms
      WHERE block_id = ${blockId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    ) WHERE id = ${blockId} AND school_id = ${req.schoolId}
  `;
  return sendSuccess(res, req.schoolId, { message: 'Room added', room }, 201);
}));

router.put('/rooms/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const existing = await activeRoom(req.params.id, req.schoolId);
  if (!existing) return res.status(404).json({ error: 'Room not found' });
  const capacity = positiveInteger(req.body?.capacity, existing.capacity);
  const floor = Object.prototype.hasOwnProperty.call(req.body || {}, 'floor')
    ? optionalInteger(req.body.floor) : existing.floor;
  const fee = Object.prototype.hasOwnProperty.call(req.body || {}, 'monthly_fee')
    ? nonNegativeMoney(req.body.monthly_fee) : Number(existing.monthly_fee ?? 0);
  if (!capacity) return res.status(400).json({ error: 'Capacity must be a positive whole number' });
  if (floor === undefined) return res.status(400).json({ error: 'Floor must be a whole number' });
  if (fee === undefined) return res.status(400).json({ error: 'Monthly fee must be zero or greater' });
  const [occupancy] = await sql`
    SELECT COUNT(*)::int AS count FROM hostel_allocations
    WHERE room_id = ${req.params.id} AND school_id = ${req.schoolId} AND is_active = TRUE
  `;
  if (capacity < occupancy.count) {
    return res.status(409).json({ error: `Capacity cannot be below the ${occupancy.count} occupied beds` });
  }
  const [room] = await sql`
    UPDATE hostel_rooms SET
      room_no = ${cleanText(req.body?.room_no, 20) || existing.room_no},
      floor = ${floor}, capacity = ${capacity},
      room_type = ${cleanText(req.body?.room_type, 50) || 'shared'}, monthly_fee = ${fee},
      is_available = COALESCE(${req.body?.is_available ?? null}, is_available)
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING *
  `;
  return sendSuccess(res, req.schoolId, { message: 'Room and fee updated', room });
}));

router.delete('/rooms/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const [occupied] = await sql`
    SELECT 1 FROM hostel_allocations
    WHERE room_id = ${req.params.id} AND school_id = ${req.schoolId} AND is_active = TRUE LIMIT 1
  `;
  if (occupied) return res.status(409).json({ error: 'Vacate all students before deleting this room' });
  const [room] = await sql`
    UPDATE hostel_rooms SET deleted_at = NOW(), is_available = FALSE
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING id, block_id
  `;
  if (!room) return res.status(404).json({ error: 'Room not found' });
  await sql`
    UPDATE hostel_blocks SET total_rooms = (
      SELECT COUNT(*) FROM hostel_rooms
      WHERE block_id = ${room.block_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    ) WHERE id = ${room.block_id} AND school_id = ${req.schoolId}
  `;
  return sendSuccess(res, req.schoolId, { message: 'Room deleted' });
}));

router.get('/rooms/:id', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const [room] = await sql`
    SELECT hr.*, hb.name AS block_name
    FROM hostel_rooms hr
    JOIN hostel_blocks hb ON hb.id = hr.block_id AND hb.school_id = ${req.schoolId}
    WHERE hr.id = ${req.params.id} AND hr.school_id = ${req.schoolId}
      AND hr.deleted_at IS NULL AND hb.deleted_at IS NULL
  `;
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const occupants = await sql`
    SELECT ha.id AS allocation_id, ha.bed_no, ha.allocated_at,
      s.id AS student_id, s.admission_no, p.display_name AS student_name
    FROM hostel_allocations ha
    JOIN students s ON s.id = ha.student_id AND s.school_id = ${req.schoolId}
    JOIN persons p ON p.id = s.person_id
    WHERE ha.room_id = ${req.params.id} AND ha.school_id = ${req.schoolId} AND ha.is_active = TRUE
    ORDER BY ha.bed_no NULLS LAST, p.display_name
  `;
  return sendSuccess(res, req.schoolId, { ...room, occupants });
}));

// ============== STUDENT ALLOCATIONS ==============

router.get('/eligible-students', requirePermission('hostel.allocate'), asyncHandler(async (req, res) => {
  const year = req.query.academic_year_id ? { id: req.query.academic_year_id } : await currentAcademicYear(req.schoolId);
  if (!year) return res.status(404).json({ error: 'No active academic year found' });
  const [ownedYear] = await sql`
    SELECT id FROM academic_years
    WHERE id = ${year.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!ownedYear) return res.status(404).json({ error: 'Academic year not found' });
  const search = cleanText(req.query.search, 100);
  const term = search ? `%${search}%` : null;
  const students = await sql`
    SELECT s.id, s.admission_no, p.display_name AS student_name,
      enrollment.roll_number, enrollment.class_name, enrollment.section_name,
      ha.id AS allocation_id, ha.room_id, ha.bed_no, hr.room_no, hb.name AS block_name
    FROM students s
    JOIN persons p ON p.id = s.person_id
    LEFT JOIN LATERAL (
      SELECT se.roll_number, c.name AS class_name, sec.name AS section_name
      FROM student_enrollments se
      JOIN class_sections cs ON cs.id = se.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections sec ON sec.id = cs.section_id
      WHERE se.student_id = s.id AND se.school_id = ${req.schoolId}
        AND se.academic_year_id = ${year.id} AND se.status = 'active' AND se.deleted_at IS NULL
      ORDER BY se.created_at DESC LIMIT 1
    ) enrollment ON TRUE
    LEFT JOIN hostel_allocations ha
      ON ha.student_id = s.id AND ha.school_id = ${req.schoolId}
      AND ha.academic_year_id = ${year.id} AND ha.is_active = TRUE
    LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
    LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id
    WHERE s.school_id = ${req.schoolId} AND s.deleted_at IS NULL AND s.status_id = 1
      ${term ? sql`AND (p.display_name ILIKE ${term} OR s.admission_no ILIKE ${term})` : sql``}
    ORDER BY (ha.id IS NOT NULL) DESC, p.display_name
    LIMIT 250
  `;
  return sendSuccess(res, req.schoolId, { academic_year_id: year.id, students });
}));

router.get('/allocations', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const { block_id: blockId, academic_year_id: academicYearId } = req.query;
  const allocations = await sql`
    SELECT ha.id, ha.student_id, ha.room_id, ha.academic_year_id, ha.bed_no, ha.allocated_at,
      s.admission_no, p.display_name AS student_name,
      enrollment.roll_number, enrollment.class_name, enrollment.section_name,
      hr.room_no, hr.monthly_fee, hb.id AS block_id, hb.name AS block_name
    FROM hostel_allocations ha
    JOIN students s ON s.id = ha.student_id AND s.school_id = ${req.schoolId}
    JOIN persons p ON p.id = s.person_id
    JOIN hostel_rooms hr ON hr.id = ha.room_id AND hr.school_id = ${req.schoolId}
    JOIN hostel_blocks hb ON hb.id = hr.block_id AND hb.school_id = ${req.schoolId}
    LEFT JOIN LATERAL (
      SELECT se.roll_number, c.name AS class_name, sec.name AS section_name
      FROM student_enrollments se
      JOIN class_sections cs ON cs.id = se.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections sec ON sec.id = cs.section_id
      WHERE se.student_id = s.id AND se.school_id = ${req.schoolId}
        AND se.academic_year_id = ha.academic_year_id AND se.status = 'active' AND se.deleted_at IS NULL
      LIMIT 1
    ) enrollment ON TRUE
    WHERE ha.school_id = ${req.schoolId} AND ha.is_active = TRUE
      ${blockId ? sql`AND hb.id = ${blockId}` : sql``}
      ${academicYearId ? sql`AND ha.academic_year_id = ${academicYearId}` : sql``}
    ORDER BY hb.name, hr.room_no, ha.bed_no NULLS LAST, p.display_name
  `;
  return sendSuccess(res, req.schoolId, allocations);
}));

router.post('/allocations', requirePermission('hostel.allocate'), asyncHandler(async (req, res) => {
  const { student_id: studentId, room_id: roomId, academic_year_id: academicYearId } = req.body || {};
  const bedNo = req.body?.bed_no == null || req.body.bed_no === '' ? null : positiveInteger(req.body.bed_no);
  if (!studentId || !roomId || !academicYearId) {
    return res.status(400).json({ error: 'Student, room, and academic year are required' });
  }
  if (req.body?.bed_no != null && req.body.bed_no !== '' && !bedNo) {
    return res.status(400).json({ error: 'Bed number must be a positive whole number' });
  }
  const allocation = await sql.begin(async (tx) => {
    const [year] = await tx`
      SELECT id FROM academic_years
      WHERE id = ${academicYearId} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    `;
    if (!year) return { error: 'Academic year not found', status: 404 };
    const room = await activeRoom(roomId, req.schoolId, tx);
    if (!room) return { error: 'Room not found', status: 404 };
    if (bedNo && bedNo > room.capacity) return { error: `Bed number cannot exceed room capacity (${room.capacity})`, status: 400 };
    const [student] = await tx`
      SELECT id FROM students
      WHERE id = ${studentId} AND school_id = ${req.schoolId} AND deleted_at IS NULL AND status_id = 1
    `;
    if (!student) return { error: 'Active student not found', status: 404 };
    await tx`SELECT id FROM hostel_rooms WHERE id = ${roomId} FOR UPDATE`;
    const [occupancy] = await tx`
      SELECT COUNT(*)::int AS count FROM hostel_allocations
      WHERE room_id = ${roomId} AND school_id = ${req.schoolId}
        AND academic_year_id = ${academicYearId} AND is_active = TRUE AND student_id <> ${studentId}
    `;
    if (occupancy.count >= room.capacity) return { error: 'Room is at full capacity', status: 409 };
    if (bedNo) {
      const [taken] = await tx`
        SELECT id FROM hostel_allocations
        WHERE room_id = ${roomId} AND school_id = ${req.schoolId}
          AND academic_year_id = ${academicYearId} AND bed_no = ${bedNo}
          AND is_active = TRUE AND student_id <> ${studentId} LIMIT 1
      `;
      if (taken) return { error: `Bed ${bedNo} is already occupied`, status: 409 };
    }
    const [row] = await tx`
      INSERT INTO hostel_allocations (school_id, student_id, room_id, academic_year_id, bed_no, is_active)
      VALUES (${req.schoolId}, ${studentId}, ${roomId}, ${academicYearId}, ${bedNo}, TRUE)
      ON CONFLICT (school_id, student_id, academic_year_id)
      DO UPDATE SET room_id = EXCLUDED.room_id, bed_no = EXCLUDED.bed_no,
        is_active = TRUE, vacated_at = NULL, allocated_at = NOW()
      RETURNING *
    `;
    return { row };
  });
  if (allocation.error) return res.status(allocation.status).json({ error: allocation.error });
  return sendSuccess(res, req.schoolId, { message: 'Student assigned to hostel', allocation: allocation.row }, 201);
}));

router.delete('/allocations/:id', requirePermission('hostel.allocate'), asyncHandler(async (req, res) => {
  const [updated] = await sql`
    UPDATE hostel_allocations SET is_active = FALSE, vacated_at = NOW()
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND is_active = TRUE RETURNING id
  `;
  if (!updated) return res.status(404).json({ error: 'Active hostel assignment not found' });
  return sendSuccess(res, req.schoolId, { message: 'Student removed from hostel' });
}));

router.get('/students/:studentId', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const [allocation] = await sql`
    SELECT ha.id, ha.bed_no, ha.allocated_at, ha.academic_year_id,
      hr.room_no, hr.room_type, hr.monthly_fee, hb.name AS block_name
    FROM hostel_allocations ha
    JOIN hostel_rooms hr ON hr.id = ha.room_id AND hr.school_id = ${req.schoolId}
    JOIN hostel_blocks hb ON hb.id = hr.block_id AND hb.school_id = ${req.schoolId}
    WHERE ha.student_id = ${req.params.studentId} AND ha.school_id = ${req.schoolId} AND ha.is_active = TRUE
    ORDER BY ha.allocated_at DESC LIMIT 1
  `;
  return sendSuccess(res, req.schoolId, allocation || null);
}));

// ============== ADMIN PERMISSION REQUESTS ==============

router.get('/requests', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const status = cleanText(req.query.status, 20);
  if (status && !['pending', 'approved', 'all'].includes(status)) {
    return res.status(400).json({ error: 'Invalid request status' });
  }
  const requests = await sql`
    SELECT hpr.id, hpr.student_id, hpr.request_type, hpr.reason,
      hpr.starts_on, hpr.ends_on, hpr.status, hpr.admin_note,
      hpr.reviewed_at, hpr.created_at, s.admission_no,
      p.display_name AS student_name, hr.room_no, hb.name AS block_name
    FROM hostel_permission_requests hpr
    JOIN students s ON s.id = hpr.student_id AND s.school_id = ${req.schoolId}
    JOIN persons p ON p.id = s.person_id
    LEFT JOIN LATERAL (
      SELECT active_allocation.room_id
      FROM hostel_allocations active_allocation
      WHERE active_allocation.student_id = s.id
        AND active_allocation.school_id = ${req.schoolId}
        AND active_allocation.is_active = TRUE
      ORDER BY active_allocation.allocated_at DESC
      LIMIT 1
    ) ha ON TRUE
    LEFT JOIN hostel_rooms hr ON hr.id = ha.room_id
    LEFT JOIN hostel_blocks hb ON hb.id = hr.block_id
    WHERE hpr.school_id = ${req.schoolId}
      ${status && status !== 'all' ? sql`AND hpr.status = ${status}` : sql``}
    ORDER BY (hpr.status = 'pending') DESC, hpr.created_at DESC LIMIT 250
  `;
  return sendSuccess(res, req.schoolId, requests);
}));

router.patch('/requests/:id/approve', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const [request] = await sql`
    UPDATE hostel_permission_requests
    SET status = 'approved', reviewed_by = ${req.user.internal_id}, reviewed_at = NOW(),
      admin_note = ${cleanText(req.body?.admin_note, 500)}, updated_at = NOW()
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND status = 'pending'
    RETURNING *
  `;
  if (!request) return res.status(404).json({ error: 'Pending permission request not found' });
  return sendSuccess(res, req.schoolId, { message: 'Permission request approved', request });
}));

router.delete('/requests/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const [request] = await sql`
    DELETE FROM hostel_permission_requests
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} RETURNING id
  `;
  if (!request) return res.status(404).json({ error: 'Permission request not found' });
  return sendSuccess(res, req.schoolId, { message: 'Permission request deleted' });
}));

export default router;
