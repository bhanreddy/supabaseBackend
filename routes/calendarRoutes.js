import express from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import CalendarService from '../services/calendarService.js';
import { resolveSchoolDay, formatYMD } from '../services/workingDayResolver.js';
import sql from '../db.js';

const router = express.Router();

/**
 * GET /api/v1/calendar
 * Fetch calendar events for the authenticated caller within a date range or month.
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const q = req.query;
  const start_date = q.start_date || q.startDate;
  const end_date = q.end_date || q.endDate;
  const year = q.year;
  const month = q.month;
  const event_type = q.event_type || q.eventType;
  const priority = q.priority;
  const status = q.status;
  const source_module = q.source_module || q.sourceModule;
  const search = q.search || q.q;
  const student_id = q.student_id || q.studentId;

  let start = start_date;
  let end = end_date;

  if (year && month && String(month).length <= 2) {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    start = `${y}-${String(m).padStart(2, '0')}-01`;
    end = new Date(Date.UTC(y, m, 0)).toISOString().split('T')[0];
  } else if (!start) {
    const now = new Date();
    start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().split('T')[0];
  }

  const events = await CalendarService.getEventsForUser({
    schoolId: req.schoolId,
    user: req.user,
    startDate: start,
    endDate: end || start,
    filters: { event_type, priority, status, source_module, search, student_id },
  });

  return sendSuccess(res, req.schoolId, events);
}));

/**
 * GET /api/v1/calendar/upcoming
 * Fast upcoming events query for dashboard widgets.
 */
router.get('/upcoming', requireAuth, asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '5', 10), 20);
  const events = await CalendarService.getUpcomingEvents({
    schoolId: req.schoolId,
    user: req.user,
    limit,
    studentId: req.query.student_id || req.query.studentId,
  });
  return sendSuccess(res, req.schoolId, events);
}));

/**
 * GET /api/v1/calendar/day-status
 * Resolves holiday / working-day status for a specific date.
 */
router.get('/day-status', requireAuth, asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return sendError(res, 400, 'date query parameter is required (YYYY-MM-DD)');
  }
  const dayStatus = await resolveSchoolDay(req.schoolId, date);
  return sendSuccess(res, req.schoolId, dayStatus);
}));

/**
 * GET /api/v1/calendar/conflicts
 * Checks for scheduling collisions before submitting an event.
 */
router.get('/conflicts', requireAuth, asyncHandler(async (req, res) => {
  const { start_date, end_date, start_time, end_time, location, event_type, class_id, section_id, exclude_id } = {
    start_date: req.query.start_date || req.query.startDate,
    end_date: req.query.end_date || req.query.endDate,
    start_time: req.query.start_time || req.query.startTime,
    end_time: req.query.end_time || req.query.endTime,
    location: req.query.location,
    event_type: req.query.event_type || req.query.eventType,
    class_id: req.query.class_id || req.query.classId,
    section_id: req.query.section_id || req.query.sectionId,
    exclude_id: req.query.exclude_id || req.query.excludeId,
  };

  const targets = [];
  if (class_id) targets.push({ target_type: 'CLASS', target_id: class_id });
  if (section_id) targets.push({ target_type: 'SECTION', target_id: section_id });

  const conflictReport = await CalendarService.checkConflicts({
    schoolId: req.schoolId,
    eventData: {
      start_date,
      end_date,
      start_time,
      end_time,
      location,
      event_type,
    },
    targets,
    excludeEventId: exclude_id || null,
  });

  return sendSuccess(res, req.schoolId, {
    hasConflict: conflictReport.hasConflict,
    hasConflicts: conflictReport.hasConflict,
    conflicts: conflictReport.conflicts,
  });
}));

/**
 * GET /api/v1/calendar/analytics
 * Total academic days, working days completed, remaining instructional days, term progress.
 */
router.get('/analytics', requireAuth, asyncHandler(async (req, res) => {
  const analytics = await CalendarService.getCalendarAnalytics({
    schoolId: req.schoolId,
    academicYearId: req.query.academic_year_id || req.query.academicYearId || null,
  });
  return sendSuccess(res, req.schoolId, analytics);
}));

/**
 * GET /api/v1/calendar/templates
 * List reusable event templates for this school.
 */
router.get('/templates', requireAuth, asyncHandler(async (req, res) => {
  const templates = await sql`
    SELECT * FROM calendar_event_templates
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
    ORDER BY name ASC
  `;
  return sendSuccess(res, req.schoolId, templates);
}));

/**
 * POST /api/v1/calendar/templates
 * Create a custom event template.
 */
router.post('/templates', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { name, event_type, default_priority, default_audience_type, attendance_disabled, timetable_disabled, default_reminders, icon, color } = req.body;

  if (!name || !event_type) {
    return sendError(res, 400, 'name and event_type are required');
  }

  const [template] = await sql`
    INSERT INTO calendar_event_templates (
      school_id, name, event_type, default_priority, default_audience_type,
      attendance_disabled, timetable_disabled, default_reminders, icon, color
    ) VALUES (
      ${req.schoolId}, ${name}, ${event_type}, ${default_priority || 'NORMAL'},
      ${default_audience_type || 'ENTIRE_SCHOOL'}, ${Boolean(attendance_disabled)},
      ${Boolean(timetable_disabled)}, ${JSON.stringify(default_reminders || ['1d'])},
      ${icon || 'calendar-outline'}, ${color || '#3B82F6'}
    )
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, template, 201);
}));

/**
 * GET /api/v1/calendar/terms
 * List academic terms for an academic year.
 */
router.get('/terms', requireAuth, asyncHandler(async (req, res) => {
  const { academic_year_id } = { academic_year_id: req.query.academic_year_id || req.query.academicYearId };

  const terms = await sql`
    SELECT t.*, ay.code as academic_year_code
    FROM academic_terms t
    JOIN academic_years ay ON t.academic_year_id = ay.id
    WHERE t.school_id = ${req.schoolId}
      AND t.deleted_at IS NULL
      ${academic_year_id ? sql`AND t.academic_year_id = ${academic_year_id}` : sql``}
    ORDER BY t.sequence ASC, t.start_date ASC
  `;

  return sendSuccess(res, req.schoolId, terms);
}));

/**
 * POST /api/v1/calendar/terms
 * Create an academic term with overlap validation.
 */
router.post('/terms', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { academic_year_id, name, start_date, end_date, sequence } = req.body;

  if (!academic_year_id || !name || !start_date || !end_date) {
    return sendError(res, 400, 'academic_year_id, name, start_date, and end_date are required');
  }

  const start = formatYMD(start_date);
  const end = formatYMD(end_date);

  if (start > end) {
    return sendError(res, 400, 'start_date cannot be after end_date');
  }

  // Validate term is within the academic year dates
  const [year] = await sql`
    SELECT id, code, start_date, end_date FROM academic_years
    WHERE id = ${academic_year_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!year) {
    return sendError(res, 404, 'Academic year not found');
  }
  if (start < formatYMD(year.start_date) || end > formatYMD(year.end_date)) {
    return sendError(res, 400, `Term dates must fall within academic year ${year.code} (${year.start_date} to ${year.end_date})`);
  }

  // Check overlapping terms within the same academic year
  const [clash] = await sql`
    SELECT id, name, start_date, end_date FROM academic_terms
    WHERE school_id = ${req.schoolId}
      AND academic_year_id = ${academic_year_id}
      AND deleted_at IS NULL
      AND start_date <= ${end}
      AND end_date >= ${start}
    LIMIT 1
  `;
  if (clash) {
    return sendError(res, 400, `Term dates overlap with existing term "${clash.name}" (${clash.start_date} to ${clash.end_date})`);
  }

  const [term] = await sql`
    INSERT INTO academic_terms (school_id, academic_year_id, name, start_date, end_date, sequence)
    VALUES (${req.schoolId}, ${academic_year_id}, ${name}, ${start}, ${end}, ${sequence || 1})
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, term, 201);
}));

/**
 * PUT /api/v1/calendar/terms/:id
 * Update an academic term.
 */
router.put('/terms/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, start_date, end_date, sequence, status } = req.body;

  const [existing] = await sql`
    SELECT * FROM academic_terms WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!existing) return sendError(res, 404, 'Academic term not found');

  const start = start_date ? formatYMD(start_date) : existing.start_date;
  const end = end_date ? formatYMD(end_date) : existing.end_date;

  if (start > end) {
    return sendError(res, 400, 'start_date cannot be after end_date');
  }

  // Check overlap against other terms
  const [clash] = await sql`
    SELECT id, name, start_date, end_date FROM academic_terms
    WHERE school_id = ${req.schoolId}
      AND academic_year_id = ${existing.academic_year_id}
      AND id != ${id}
      AND deleted_at IS NULL
      AND start_date <= ${end}
      AND end_date >= ${start}
    LIMIT 1
  `;
  if (clash) {
    return sendError(res, 400, `Updated term dates overlap with "${clash.name}" (${clash.start_date} to ${clash.end_date})`);
  }

  const [updated] = await sql`
    UPDATE academic_terms
    SET 
      name = COALESCE(${name ?? null}, name),
      start_date = ${start},
      end_date = ${end},
      sequence = COALESCE(${sequence ?? null}, sequence),
      status = COALESCE(${status ?? null}, status),
      updated_at = now()
    WHERE id = ${id} AND school_id = ${req.schoolId}
    RETURNING *
  `;

  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * DELETE /api/v1/calendar/terms/:id
 * Delete an academic term.
 */
router.delete('/terms/:id', requirePermission('academics.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [deleted] = await sql`
    UPDATE academic_terms
    SET deleted_at = now(), updated_at = now()
    WHERE id = ${id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    RETURNING id
  `;
  if (!deleted) return sendError(res, 404, 'Academic term not found');
  return sendSuccess(res, req.schoolId, { message: 'Academic term deleted successfully' });
}));

/**
 * GET /api/v1/calendar/export
 * Export calendar events as iCalendar (.ics) or JSON.
 */
router.get('/export', requireAuth, asyncHandler(async (req, res) => {
  const { start_date, startDate, end_date, endDate, format = 'ics' } = req.query;

  const now = new Date();
  const start = start_date || startDate || `${now.getUTCFullYear()}-01-01`;
  const end = end_date || endDate || `${now.getUTCFullYear()}-12-31`;
  const exportFormat = String(format || 'ics').toLowerCase();

  const events = await CalendarService.getEventsForUser({
    schoolId: req.schoolId,
    user: req.user,
    startDate: start,
    endDate: end,
    filters: { status: 'PUBLISHED' },
  });

  if (exportFormat === 'ics') {
    const icsContent = CalendarService.generateIcsFeed(events);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="school_calendar.ics"');
    return res.send(icsContent);
  }

  if (exportFormat === 'csv') {
    const csv = CalendarService.generateCsv(events);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="school_calendar.csv"');
    return res.send(csv);
  }

  if (exportFormat === 'pdf' || exportFormat === 'html' || exportFormat === 'print') {
    const html = CalendarService.generatePrintableHtml(events, 'Printable Academic Calendar');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  if (exportFormat === 'xlsx' || exportFormat === 'excel') {
    const XLSX = (await import('xlsx')).default;
    const workbook = XLSX.utils.book_new();
    const rows = events.map((event) => ({
      Title: event.title,
      Type: event.event_type,
      Start: event.start_date,
      End: event.end_date,
      Location: event.location || '',
      Status: event.status,
      Priority: event.priority,
    }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Calendar');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="school_calendar.xlsx"');
    return res.send(buffer);
  }

  return sendSuccess(res, req.schoolId, events);
}));

/**
 * POST /api/v1/calendar/import
 * Bulk import calendar events from JSON rows parsed from CSV/Excel.
 */
router.post('/import', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body.rows)
    ? req.body.rows
    : (Array.isArray(req.body.events) ? req.body.events : []);
  if (!Array.isArray(rows) || rows.length === 0) {
    return sendError(res, 400, 'rows array is required for calendar import');
  }

  const result = await CalendarService.bulkImportEvents({
    schoolId: req.schoolId,
    userId: req.user?.id,
    rows,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * GET /api/v1/calendar/:id/ics
 * Download single event ICS.
 */
router.get('/:id/ics', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const event = await CalendarService.getEventById({ schoolId: req.schoolId, eventId: id });
  if (!event) return sendError(res, 404, 'Event not found');

  const ics = CalendarService.generateIcsForEvent(event);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="event_${event.id}.ics"`);
  return res.send(ics);
}));

/**
 * GET /api/v1/calendar/:id
 * Get event details including targeting and history.
 */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const event = await CalendarService.getEventById({ schoolId: req.schoolId, eventId: id });
  if (!event) return sendError(res, 404, 'Event not found');
  return sendSuccess(res, req.schoolId, event);
}));

/**
 * POST /api/v1/calendar
 * Create a new event.
 */
router.post('/', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { title, start_date } = req.body;
  if (!title || !start_date) {
    return sendError(res, 400, 'title and start_date are required');
  }

  const event = await CalendarService.createEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    data: req.body,
    targets: req.body.targets || [],
  });

  return sendSuccess(res, req.schoolId, event, 201);
}));

/**
 * PUT /api/v1/calendar/:id
 * Update an existing event.
 */
router.put('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updated = await CalendarService.updateEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: id,
    data: req.body,
    targets: req.body.targets,
  });

  return sendSuccess(res, req.schoolId, updated);
}));

/**
 * PUT /api/v1/calendar/:id/recurrence
 * Edit a recurring event series or specific occurrence.
 * Scope: THIS_EVENT | THIS_AND_FUTURE | ENTIRE_SERIES
 */
router.put('/:id/recurrence', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { scope, occurrence_date, ...data } = req.body;

  if (!scope) {
    return sendError(res, 400, 'scope is required (THIS_EVENT, THIS_AND_FUTURE, or ENTIRE_SERIES)');
  }
  if (['THIS_EVENT', 'THIS_AND_FUTURE'].includes(scope) && !occurrence_date) {
    return sendError(res, 400, 'occurrence_date is required when scope is THIS_EVENT or THIS_AND_FUTURE');
  }

  const result = await CalendarService.updateRecurringEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: id,
    scope,
    occurrenceDate: occurrence_date,
    data,
    targets: data.targets,
  });

  return sendSuccess(res, req.schoolId, result);
}));

/**
 * POST /api/v1/calendar/:id/publish
 * Publish a draft/scheduled event.
 */
router.post('/:id/publish', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const published = await CalendarService.publishEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: id,
  });
  return sendSuccess(res, req.schoolId, published);
}));

/**
 * POST /api/v1/calendar/:id/approve
 * Approve an event (management workflow).
 */
router.post('/:id/approve', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const approved = await CalendarService.publishEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: id,
  });
  return sendSuccess(res, req.schoolId, approved);
}));

router.post('/:id/reject', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const rejected = await CalendarService.rejectEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: req.params.id,
    reason: req.body?.reason,
  });
  return sendSuccess(res, req.schoolId, rejected);
}));

/**
 * POST /api/v1/calendar/:id/cancel
 * Cancel an event.
 */
router.post('/:id/cancel', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  const cancelled = await CalendarService.cancelEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: id,
    reason,
  });
  return sendSuccess(res, req.schoolId, cancelled);
}));

/**
 * DELETE /api/v1/calendar/:id
 * Soft-delete an event.
 */
router.delete('/:id', requirePermission('events.manage'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  await CalendarService.deleteEvent({
    schoolId: req.schoolId,
    userId: req.user?.id,
    eventId: id,
  });
  return sendSuccess(res, req.schoolId, { message: 'Event deleted successfully' });
}));

export default router;
