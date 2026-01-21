import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// ============== BLOCKS ==============

/**
 * GET /hostel/blocks
 * List all hostel blocks
 */
router.get('/blocks', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
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
    GROUP BY hb.id, g.name, warden.display_name
    ORDER BY hb.name
  `;

    res.json(blocks);
}));

/**
 * POST /hostel/blocks
 * Create hostel block
 */
router.post('/blocks', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
    const { name, code, gender_id, warden_id } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Block name is required' });
    }

    const [block] = await sql`
    INSERT INTO hostel_blocks (name, code, gender_id, warden_id)
    VALUES (${name}, ${code}, ${gender_id}, ${warden_id})
    RETURNING *
  `;

    res.status(201).json({ message: 'Block created', block });
}));

// ============== ROOMS ==============

/**
 * GET /hostel/rooms
 * List rooms (filter by block)
 */
router.get('/rooms', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
    const { block_id, available_only } = req.query;

    if (!block_id) {
        return res.status(400).json({ error: 'block_id is required' });
    }

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

    res.json(rooms);
}));

/**
 * POST /hostel/rooms
 * Add room to block
 */
router.post('/rooms', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
    const { block_id, room_no, floor, capacity, room_type, monthly_fee } = req.body;

    if (!block_id || !room_no) {
        return res.status(400).json({ error: 'block_id and room_no are required' });
    }

    const [room] = await sql`
    INSERT INTO hostel_rooms (block_id, room_no, floor, capacity, room_type, monthly_fee)
    VALUES (${block_id}, ${room_no}, ${floor}, ${capacity || 2}, ${room_type || 'shared'}, ${monthly_fee})
    RETURNING *
  `;

    // Update block total_rooms
    await sql`UPDATE hostel_blocks SET total_rooms = (SELECT COUNT(*) FROM hostel_rooms WHERE block_id = ${block_id}) WHERE id = ${block_id}`;

    res.status(201).json({ message: 'Room added', room });
}));

/**
 * GET /hostel/rooms/:id
 * Get room details with occupants
 */
router.get('/rooms/:id', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [room] = await sql`
    SELECT hr.*, hb.name as block_name
    FROM hostel_rooms hr
    JOIN hostel_blocks hb ON hr.block_id = hb.id
    WHERE hr.id = ${id}
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

    res.json({ ...room, occupants });
}));

// ============== ALLOCATIONS ==============

/**
 * GET /hostel/allocations
 * List allocations
 */
router.get('/allocations', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
    const { block_id, academic_year_id, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

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
      ${block_id ? sql`AND hb.id = ${block_id}` : sql``}
      ${academic_year_id ? sql`AND ha.academic_year_id = ${academic_year_id}` : sql``}
    ORDER BY hb.name, hr.room_no, ha.bed_no
    LIMIT ${limit} OFFSET ${offset}
  `;

    res.json(allocations);
}));

/**
 * POST /hostel/allocations
 * Allocate student to room
 */
router.post('/allocations', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
    const { student_id, room_id, academic_year_id, bed_no } = req.body;

    if (!student_id || !room_id || !academic_year_id) {
        return res.status(400).json({ error: 'student_id, room_id, and academic_year_id are required' });
    }

    // Check room capacity
    const [room] = await sql`SELECT capacity FROM hostel_rooms WHERE id = ${room_id}`;
    const [occupancy] = await sql`SELECT COUNT(*) as count FROM hostel_allocations WHERE room_id = ${room_id} AND is_active = true`;

    if (occupancy.count >= room.capacity) {
        return res.status(400).json({ error: 'Room is at full capacity' });
    }

    const [allocation] = await sql`
    INSERT INTO hostel_allocations (student_id, room_id, academic_year_id, bed_no)
    VALUES (${student_id}, ${room_id}, ${academic_year_id}, ${bed_no})
    ON CONFLICT (student_id, academic_year_id) 
    DO UPDATE SET room_id = EXCLUDED.room_id, bed_no = EXCLUDED.bed_no, is_active = true, vacated_at = NULL
    RETURNING *
  `;

    res.status(201).json({ message: 'Student allocated', allocation });
}));

/**
 * DELETE /hostel/allocations/:id
 * Vacate allocation
 */
router.delete('/allocations/:id', requirePermission('hostel.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [updated] = await sql`
    UPDATE hostel_allocations
    SET is_active = false, vacated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `;

    if (!updated) {
        return res.status(404).json({ error: 'Allocation not found' });
    }

    res.json({ message: 'Student vacated' });
}));

/**
 * GET /hostel/students/:studentId
 * Get student's hostel allocation
 */
router.get('/students/:studentId', requirePermission('hostel.view'), asyncHandler(async (req, res) => {
    const { studentId } = req.params;

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

    res.json(allocation || { message: 'No hostel allocation' });
}));

export default router;
