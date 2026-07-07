import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== BLOCKS ==============

/**
 * GET /hostel/blocks
 * HO1: Scoped to school_id
 */
router.get('/blocks', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  const blocks = await sql`
    SELECT
      hb.id, hb.name, hb.code, hb.total_rooms, hb.is_active,
      g.name as gender,
      warden.display_name as warden_name,
      COUNT(hr.id) as room_count,
      SUM(hr.capacity) as total_capacity,
      COUNT(ha.id) FILTER (WHERE ha.is_active = true) as occupied_beds
    FROM hostel_blocks hb
    LEFT JOIN genders g ON hb.gender_id = g.id
    LEFT JOIN staff st ON hb.warden_id = st.id
    LEFT JOIN persons warden ON st.person_id = warden.id
    LEFT JOIN hostel_rooms hr ON hb.id = hr.block_id
    LEFT JOIN hostel_allocations ha ON hr.id = ha.room_id
    WHERE hb.school_id = ${schoolId}
    GROUP BY hb.id, g.name, warden.display_name
    ORDER BY hb.name
  `;

  return sendSuccess(res, req.schoolId, blocks);
}));

/**
 * POST /hostel/blocks — Create hostel block
 */
router.post('/blocks', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const { name, code, gender_id, warden_id } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Block name is required' });
  }

  const [block] = await sql`
    INSERT INTO hostel_blocks (school_id, name, code, gender_id, warden_id)
    VALUES (${req.schoolId}, ${name}, ${code}, ${gender_id}, ${warden_id})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Block created', block }, 201);
}));

// ============== ROOMS ==============

/**
 * GET /hostel/rooms
 * HO2: Scoped to school_id via hostel_blocks join
 */
router.get('/rooms', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const { block_id, available_only } = req.query;
  const schoolId = req.schoolId;

  if (!block_id) {
    return res.status(400).json({ error: 'block_id is required' });
  }

  // HO2: Verify block belongs to this school
  const [block] = await sql`SELECT id FROM hostel_blocks WHERE id = ${block_id} AND school_id = ${schoolId}`;
  if (!block) return res.status(404).json({ error: 'Block not found' });

  const rooms = await sql`
    SELECT
      hr.id, hr.room_no, hr.floor, hr.capacity, hr.room_type, hr.monthly_fee, hr.is_available,
      COUNT(ha.id) FILTER (WHERE ha.is_active = true) as occupied_beds
    FROM hostel_rooms hr
    LEFT JOIN hostel_allocations ha ON hr.id = ha.room_id
    WHERE hr.block_id = ${block_id}
      ${available_only === 'true' ? sql`AND hr.is_available = true` : sql``}
    GROUP BY hr.id
    ORDER BY hr.floor, hr.room_no
  `;

  return sendSuccess(res, req.schoolId, rooms);
}));

/**
 * POST /hostel/rooms — Add room to block
 */
router.post('/rooms', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const { block_id, room_no, floor, capacity, room_type, monthly_fee } = req.body;
  const schoolId = req.schoolId;

  if (!block_id || !room_no) {
    return res.status(400).json({ error: 'block_id and room_no are required' });
  }

  // Ownership check: block must belong to this school
  const [block] = await sql`SELECT id FROM hostel_blocks WHERE id = ${block_id} AND school_id = ${schoolId}`;
  if (!block) return res.status(404).json({ error: 'Block not found' });

  const [room] = await sql`
    INSERT INTO hostel_rooms (school_id, block_id, room_no, floor, capacity, room_type, monthly_fee)
    VALUES (${req.schoolId}, ${block_id}, ${room_no}, ${floor}, ${capacity || 2}, ${room_type || 'shared'}, ${monthly_fee})
    RETURNING *
  `;

  await sql`UPDATE hostel_blocks SET total_rooms = (SELECT COUNT(*) FROM hostel_rooms WHERE block_id = ${block_id}
      AND school_id = ${req.schoolId}) WHERE id = ${block_id}`;

  return sendSuccess(res, req.schoolId, { message: 'Room added', room }, 201);
}));

/**
 * GET /hostel/rooms/:id
 * HO2: Ownership via hostel_blocks.school_id
 */
router.get('/rooms/:id', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  const [room] = await sql`
    SELECT hr.*, hb.name as block_name
    FROM hostel_rooms hr
    JOIN hostel_blocks hb ON hr.block_id = hb.id
    WHERE hr.id = ${id}
      AND hb.school_id = ${schoolId}
  `;

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const occupants = await sql`
    SELECT
      ha.bed_no, ha.allocated_at,
      s.id as student_id, s.admission_no,
      p.display_name as student_name
    FROM hostel_allocations ha
    JOIN students s ON ha.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    WHERE ha.room_id = ${id} AND ha.is_active = true
    ORDER BY ha.bed_no
  `;

  return sendSuccess(res, req.schoolId, { ...room, occupants });
}));

// ============== ALLOCATIONS ==============

/**
 * GET /hostel/allocations
 * HO3: Scoped to school_id via hostel_blocks join
 */
router.get('/allocations', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const { block_id, academic_year_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  const schoolId = req.schoolId;

  const allocations = await sql`
    SELECT
      ha.id, ha.bed_no, ha.allocated_at, ha.is_active,
      s.id as student_id, s.admission_no,
      p.display_name as student_name,
      hr.room_no, hb.name as block_name
    FROM hostel_allocations ha
    JOIN students s ON ha.student_id = s.id
    JOIN persons p ON s.person_id = p.id
    JOIN hostel_rooms hr ON ha.room_id = hr.id
    JOIN hostel_blocks hb ON hr.block_id = hb.id
    WHERE ha.is_active = true
      AND hb.school_id = ${schoolId}
      ${block_id ? sql`AND hb.id = ${block_id}` : sql``}
      ${academic_year_id ? sql`AND ha.academic_year_id = ${academic_year_id}` : sql``}
    ORDER BY hb.name, hr.room_no, ha.bed_no
    LIMIT ${limit} OFFSET ${offset}
  `;

  return sendSuccess(res, req.schoolId, allocations);
}));

/**
 * POST /hostel/allocations
 * HO4: Verify room belongs to this school before allocating
 */
router.post('/allocations', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const { student_id, room_id, academic_year_id, bed_no } = req.body;
  const schoolId = req.schoolId;

  if (!student_id || !room_id || !academic_year_id) {
    return res.status(400).json({ error: 'student_id, room_id, and academic_year_id are required' });
  }

  // HO4: Ownership check — room must belong to this school
  const [roomCheck] = await sql`
    SELECT hr.id, hr.capacity
    FROM hostel_rooms hr
    JOIN hostel_blocks hb ON hr.block_id = hb.id
    WHERE hr.id = ${room_id} AND hb.school_id = ${schoolId}
  `;
  if (!roomCheck) return res.status(404).json({ error: 'Room not found' });

  // HO4: Student must belong to this school
  const [studentCheck] = await sql`SELECT id FROM students WHERE id = ${student_id} AND school_id = ${schoolId}`;
  if (!studentCheck) return res.status(404).json({ error: 'Student not found' });

  const [occupancy] = await sql`SELECT COUNT(*) as count FROM hostel_allocations WHERE room_id = ${room_id} AND is_active = true`;
  if (occupancy.count >= roomCheck.capacity) {
    return res.status(400).json({ error: 'Room is at full capacity' });
  }

  const [allocation] = await sql`
    INSERT INTO hostel_allocations (school_id, student_id, room_id, academic_year_id, bed_no)
    VALUES (${req.schoolId}, ${student_id}, ${room_id}, ${academic_year_id}, ${bed_no})
    ON CONFLICT (student_id, academic_year_id)
    DO UPDATE SET room_id = EXCLUDED.room_id, bed_no = EXCLUDED.bed_no, is_active = true, vacated_at = NULL
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Student allocated', allocation }, 201);
}));

/**
 * DELETE /hostel/allocations/:id
 * Ownership check via hostel_blocks.school_id
 */
router.delete('/allocations/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const schoolId = req.schoolId;

  // Ownership check via room → block
  const [existing] = await sql`
    SELECT ha.id FROM hostel_allocations ha
    JOIN hostel_rooms hr ON ha.room_id = hr.id
    JOIN hostel_blocks hb ON hr.block_id = hb.id
    WHERE ha.id = ${id} AND hb.school_id = ${schoolId}
  `;
  if (!existing) return res.status(404).json({ error: 'Allocation not found' });

  const [updated] = await sql`
    UPDATE hostel_allocations
    SET is_active = false, vacated_at = NOW()
    WHERE id = ${id}
      AND school_id = ${req.schoolId}
    RETURNING id
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Allocation not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Student vacated' });
}));

/**
 * GET /hostel/students/:studentId
 * Ownership check — student must belong to this school
 */
router.get('/students/:studentId', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
  const { studentId } = req.params;
  const schoolId = req.schoolId;

  // Verify student belongs to school
  const [studentCheck] = await sql`SELECT id FROM students WHERE id = ${studentId} AND school_id = ${schoolId}`;
  if (!studentCheck) return res.status(404).json({ error: 'Student not found' });

  const [allocation] = await sql`
    SELECT
      ha.id, ha.bed_no, ha.allocated_at, ha.is_active,
      hr.room_no, hr.room_type, hr.monthly_fee,
      hb.name as block_name
    FROM hostel_allocations ha
    JOIN hostel_rooms hr ON ha.room_id = hr.id
    JOIN hostel_blocks hb ON hr.block_id = hb.id
    WHERE ha.student_id = ${studentId} AND ha.is_active = true
  `;

  return sendSuccess(res, req.schoolId, allocation || { message: 'No hostel allocation' });
}));

export default router;