import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /events
 * List events (with date range and type filters)
 */
router.get('/', requirePermission('events.view'), asyncHandler(async (req, res) => {
    const { from_date, to_date, event_type, upcoming_only, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let events;
    if (upcoming_only === 'true') {
        events = await sql`
      SELECT 
        id, title, description, event_type, start_date, end_date,
        start_time, end_time, location, is_all_day, is_public
      FROM events
      WHERE start_date >= CURRENT_DATE
        AND is_public = true
      ORDER BY start_date, start_time
      LIMIT ${limit} OFFSET ${offset}
    `;
    } else {
        events = await sql`
      SELECT 
        id, title, description, event_type, start_date, end_date,
        start_time, end_time, location, is_all_day, is_public
      FROM events
      WHERE TRUE
        ${from_date ? sql`AND start_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND start_date <= ${to_date}` : sql``}
        ${event_type ? sql`AND event_type = ${event_type}` : sql``}
      ORDER BY start_date DESC, start_time
      LIMIT ${limit} OFFSET ${offset}
    `;
    }

    res.json(events);
}));

/**
 * GET /events/calendar
 * Get events for calendar view (month/week)
 */
router.get('/calendar', requirePermission('events.view'), asyncHandler(async (req, res) => {
    const { year, month } = req.query;

    if (!year || !month) {
        return res.status(400).json({ error: 'year and month are required' });
    }

    const startDate = `${year}-${month.padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0]; // Last day of month

    const events = await sql`
    SELECT 
      id, title, event_type, start_date, end_date, start_time, end_time,
      is_all_day, location
    FROM events
    WHERE start_date <= ${endDate} 
      AND (end_date >= ${startDate} OR end_date IS NULL OR COALESCE(end_date, start_date) >= ${startDate})
      AND is_public = true
    ORDER BY start_date, start_time
  `;

    res.json(events);
}));

/**
 * GET /events/:id
 * Get event details
 */
router.get('/:id', requirePermission('events.view'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [event] = await sql`
    SELECT e.*, creator.display_name as created_by_name
    FROM events e
    LEFT JOIN users u ON e.created_by = u.id
    LEFT JOIN persons creator ON u.person_id = creator.id
    WHERE e.id = ${id}
  `;

    if (!event) {
        return res.status(404).json({ error: 'Event not found' });
    }

    res.json(event);
}));

/**
 * POST /events
 * Create an event
 */
router.post('/', requirePermission('events.manage'), asyncHandler(async (req, res) => {
    const { title, description, event_type, start_date, end_date, start_time, end_time, location, is_all_day, is_public, target_audience } = req.body;

    if (!title || !start_date) {
        return res.status(400).json({ error: 'title and start_date are required' });
    }

    const [event] = await sql`
    INSERT INTO events (title, description, event_type, start_date, end_date, start_time, end_time, location, is_all_day, is_public, target_audience, created_by)
    VALUES (${title}, ${description}, ${event_type || 'other'}, ${start_date}, ${end_date}, 
            ${start_time}, ${end_time}, ${location}, ${is_all_day || false}, ${is_public !== false}, 
            ${target_audience || 'all'}, ${req.user?.internal_id})
    RETURNING *
  `;

    res.status(201).json({ message: 'Event created', event });
}));

/**
 * PUT /events/:id
 * Update an event
 */
router.put('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, description, event_type, start_date, end_date, start_time, end_time, location, is_all_day, is_public } = req.body;

    const [updated] = await sql`
    UPDATE events
    SET 
      title = COALESCE(${title}, title),
      description = COALESCE(${description}, description),
      event_type = COALESCE(${event_type}, event_type),
      start_date = COALESCE(${start_date}, start_date),
      end_date = COALESCE(${end_date}, end_date),
      start_time = COALESCE(${start_time}, start_time),
      end_time = COALESCE(${end_time}, end_time),
      location = COALESCE(${location}, location),
      is_all_day = COALESCE(${is_all_day}, is_all_day),
      is_public = COALESCE(${is_public}, is_public)
    WHERE id = ${id}
    RETURNING *
  `;

    if (!updated) {
        return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ message: 'Event updated', event: updated });
}));

/**
 * DELETE /events/:id
 * Delete an event
 */
router.delete('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
    const { id } = req.params;

    const [deleted] = await sql`DELETE FROM events WHERE id = ${id} RETURNING id`;

    if (!deleted) {
        return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ message: 'Event deleted' });
}));

export default router;
