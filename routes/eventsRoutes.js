import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { translateFields } from '../services/geminiTranslator.js';

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
        id, title, title_te, description, description_te, event_type, start_date, end_date,
        start_time, end_time, location, is_all_day, is_public
      FROM events
      WHERE start_date >= CURRENT_DATE
        AND school_id = ${req.schoolId}
        AND is_public = true
      ORDER BY start_date, start_time
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    events = await sql`
      SELECT 
        id, title, title_te, description, description_te, event_type, start_date, end_date,
        start_time, end_time, location, is_all_day, is_public
      FROM events
      WHERE school_id = ${req.schoolId}
        ${from_date ? sql`AND start_date >= ${from_date}` : sql``}
        ${to_date ? sql`AND start_date <= ${to_date}` : sql``}
        ${event_type ? sql`AND event_type = ${event_type}` : sql``}
      ORDER BY start_date DESC, start_time
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sendSuccess(res, req.schoolId, events);
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
      id, title, title_te, event_type, start_date, end_date, start_time, end_time,
      is_all_day, location
    FROM events
    WHERE school_id = ${req.schoolId}
      AND start_date <= ${endDate} 
      AND (end_date >= ${startDate} OR end_date IS NULL OR COALESCE(end_date, start_date) >= ${startDate})
      AND is_public = true
    ORDER BY start_date, start_time
  `;

  return sendSuccess(res, req.schoolId, events);
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
    WHERE e.id = ${id} AND e.school_id = ${req.schoolId}
  `;

  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  return sendSuccess(res, req.schoolId, event);
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

  // Translate text fields
  let title_te = null;
  let description_te = null;
  try {
    const fields = { title };
    if (description) fields.description = description;
    const te = await translateFields(fields);
    title_te = te.title || null;
    description_te = te.description || null;
  } catch (e) {

  }

  const [event] = await sql`
    INSERT INTO events (school_id, title, title_te, description, description_te, event_type, start_date, end_date, start_time, end_time, location, is_all_day, is_public, target_audience, created_by)
    VALUES (${req.schoolId}, ${title}, ${title_te}, ${description}, ${description_te}, ${event_type || 'other'}, ${start_date}, ${end_date}, 
            ${start_time}, ${end_time}, ${location}, ${is_all_day || false}, ${is_public !== false}, 
            ${target_audience || 'all'}, ${req.user?.internal_id})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, { message: 'Event created', event }, 201);
}));

/**
 * PUT /events/:id
 * Update an event
 */
router.put('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { title, description, event_type, start_date, end_date, start_time, end_time, location, is_all_day, is_public } = req.body;

  // Translate text fields if changed
  let sql_title_te = sql`title_te`;
  let sql_description_te = sql`description_te`;
  if (title || description) {
    try {
      const fields = {};
      if (title) fields.title = title;
      if (description) fields.description = description;
      const te = await translateFields(fields);
      if (te.title) sql_title_te = sql`${te.title}`;
      if (te.description) sql_description_te = sql`${te.description}`;
    } catch (e) {

    }
  }

  const [updated] = await sql`
    UPDATE events
    SET 
      title = COALESCE(${title ?? null}, title),
      title_te = ${sql_title_te},
      description = COALESCE(${description ?? null}, description),
      description_te = ${sql_description_te},
      event_type = COALESCE(${event_type ?? null}, event_type),
      start_date = COALESCE(${start_date ?? null}, start_date),
      end_date = COALESCE(${end_date ?? null}, end_date),
      start_time = COALESCE(${start_time ?? null}, start_time),
      end_time = COALESCE(${end_time ?? null}, end_time),
      location = COALESCE(${location ?? null}, location),
      is_all_day = COALESCE(${is_all_day ?? null}, is_all_day),
      is_public = COALESCE(${is_public ?? null}, is_public)
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  if (!updated) {
    return res.status(404).json({ error: 'Event not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Event updated', event: updated });
}));

/**
 * DELETE /events/:id
 * Delete an event
 */
router.delete('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const [deleted] = await sql`DELETE FROM events WHERE id = ${id} AND school_id = ${req.schoolId} AND school_id = ${req.schoolId} RETURNING id`;

  if (!deleted) {
    return res.status(404).json({ error: 'Event not found' });
  }

  return sendSuccess(res, req.schoolId, { message: 'Event deleted' });
}));

export default router;