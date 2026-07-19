// Exam timetable generator.
//
// Turns a small set of admin-chosen parameters (classes, date window, session
// time, day rules) into concrete exam_subjects rows (one row = one paper for
// one class), which the admin can then edit cell-by-cell before publishing.
//
// Invariants:
//  - Every query is school-scoped (schoolId always comes from the caller's
//    middleware-derived req.schoolId, never from the client payload).
//  - Papers that already have marks recorded are never deleted or moved by a
//    regeneration — they are preserved as-is and reported back.
//  - Generation runs in a single transaction; a failed run leaves the previous
//    schedule untouched.
//  - Regenerating an already-published timetable un-publishes it (the admin
//    must review and re-publish).

import sql from '../db.js';

export class ExamTimetableError extends Error {
  constructor(message, status = 400, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function toUtcDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Validate + normalize the generator parameters. Throws ExamTimetableError on
 * bad input. Unknown keys are dropped so timetable_params stays canonical.
 */
export function normalizeParams(raw = {}) {
  const p = {
    class_ids: Array.isArray(raw.class_ids) ? [...new Set(raw.class_ids.map(String))] : [],
    start_date: raw.start_date,
    end_date: raw.end_date,
    start_time: raw.start_time || null,
    end_time: raw.end_time || null,
    include_saturdays: raw.include_saturdays !== false,
    exclude_holidays: raw.exclude_holidays !== false,
    excluded_dates: Array.isArray(raw.excluded_dates) ? [...new Set(raw.excluded_dates)] : [],
    gap_days: Number.isInteger(raw.gap_days) ? raw.gap_days : 0,
    max_marks: raw.max_marks ?? 100,
    passing_marks: raw.passing_marks ?? 35,
    subject_order: Array.isArray(raw.subject_order) ? raw.subject_order.map(String) : [],
    // Ordered subject selection. When non-empty it is authoritative: only these
    // subjects are scheduled, in exactly this order. (subject_order is the
    // legacy priority-only hint, kept for back-compat.)
    subject_ids: Array.isArray(raw.subject_ids) ? [...new Set(raw.subject_ids.map(String))] : [],
    // Exam sessions per day, each with its own timings. One session (possibly
    // untimed) is the default; up to 3 sessions schedule multiple papers per day.
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions.map((s) => ({
          start_time: s?.start_time || null,
          end_time: s?.end_time || null,
        }))
      : [],
    // 'aligned'  : same subject sits on the same date for every class that
    //              teaches it (the common convention for Indian schools).
    // 'per_class': each class fills its own consecutive exam days.
    mode: raw.mode === 'per_class' ? 'per_class' : 'aligned',
  };

  if (p.class_ids.length === 0) {
    throw new ExamTimetableError('Select at least one class');
  }
  if (!DATE_RE.test(p.start_date || '') || !DATE_RE.test(p.end_date || '')) {
    throw new ExamTimetableError('start_date and end_date are required (YYYY-MM-DD)');
  }
  if (p.end_date < p.start_date) {
    throw new ExamTimetableError('end_date must be on or after start_date');
  }
  const spanDays = (toUtcDate(p.end_date) - toUtcDate(p.start_date)) / 86400000;
  if (spanDays > 92) {
    throw new ExamTimetableError('Exam window cannot exceed 3 months');
  }
  for (const t of [p.start_time, p.end_time]) {
    if (t && !TIME_RE.test(t)) {
      throw new ExamTimetableError('Times must be HH:MM (24h)');
    }
  }
  if (p.start_time && p.end_time && p.end_time <= p.start_time) {
    throw new ExamTimetableError('end_time must be after start_time');
  }

  // Sessions: default to one session built from the legacy start/end fields.
  if (p.sessions.length === 0) {
    p.sessions = [{ start_time: p.start_time, end_time: p.end_time }];
  }
  if (p.sessions.length > 3) {
    throw new ExamTimetableError('At most 3 sessions per day');
  }
  for (const s of p.sessions) {
    for (const t of [s.start_time, s.end_time]) {
      if (t && !TIME_RE.test(t)) {
        throw new ExamTimetableError('Session times must be HH:MM (24h)');
      }
    }
    if (s.start_time && s.end_time && s.end_time <= s.start_time) {
      throw new ExamTimetableError('Each session must end after it starts');
    }
  }
  if (p.sessions.length > 1) {
    // Multiple papers on one day need real, non-overlapping timings.
    if (p.sessions.some((s) => !s.start_time || !s.end_time)) {
      throw new ExamTimetableError('With multiple sessions, every session needs start and end times');
    }
    p.sessions.sort((a, b) => (a.start_time < b.start_time ? -1 : 1));
    for (let i = 1; i < p.sessions.length; i++) {
      if (p.sessions[i].start_time < p.sessions[i - 1].end_time) {
        throw new ExamTimetableError('Sessions must not overlap');
      }
    }
  }
  // Keep the legacy fields mirroring session 1 so older readers stay correct.
  p.start_time = p.sessions[0].start_time;
  p.end_time = p.sessions[0].end_time;
  for (const d of p.excluded_dates) {
    if (!DATE_RE.test(d)) throw new ExamTimetableError(`Invalid excluded date: ${d}`);
  }
  if (p.gap_days < 0 || p.gap_days > 6) {
    throw new ExamTimetableError('gap_days must be between 0 and 6');
  }
  const max = Number(p.max_marks);
  const pass = Number(p.passing_marks);
  if (!(max > 0) || !(pass >= 0) || pass > max) {
    throw new ExamTimetableError('passing_marks must be between 0 and max_marks');
  }
  p.max_marks = max;
  p.passing_marks = pass;
  return p;
}

/**
 * Validate + normalize a paper's syllabus payload.
 * Accepts null/[] (clears the syllabus) or an array of { topic, marks }.
 * Returns a clean array or null. Throws ExamTimetableError on bad input.
 * Pure function — unit tested.
 */
export function normalizeSyllabus(raw) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new ExamTimetableError('syllabus must be a list of topics');
  }
  if (raw.length > 50) {
    throw new ExamTimetableError('At most 50 syllabus topics per paper');
  }
  const items = [];
  for (const entry of raw) {
    const topic = String(entry?.topic ?? '').trim();
    if (!topic) continue; // empty rows from the editor are just dropped
    if (topic.length > 200) {
      throw new ExamTimetableError('Syllabus topics must be under 200 characters');
    }
    let marks = null;
    if (entry.marks !== null && entry.marks !== undefined && entry.marks !== '') {
      marks = Number(entry.marks);
      if (Number.isNaN(marks) || marks < 0) {
        throw new ExamTimetableError(`Invalid weightage for "${topic}"`);
      }
    }
    items.push({ topic, marks });
  }
  return items.length > 0 ? items : null;
}

/**
 * Working exam days inside [startDate, endDate]:
 * skips Sundays always, Saturdays optionally, plus any excluded dates; then
 * keeps every (gapDays+1)-th remaining day so papers are spaced out.
 * Pure function — unit tested in tests/examTimetable.test.js.
 */
export function buildExamDates({ startDate, endDate, includeSaturdays, excludedDates, gapDays }) {
  const excluded = new Set(excludedDates || []);
  const working = [];
  const end = toUtcDate(endDate);
  for (let d = toUtcDate(startDate); d <= end; d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow === 0) continue;
    if (dow === 6 && !includeSaturdays) continue;
    const iso = toIsoDate(d);
    if (excluded.has(iso)) continue;
    working.push(iso);
  }
  const step = (gapDays || 0) + 1;
  return working.filter((_, i) => i % step === 0);
}

/**
 * Map subjects onto (day, session) slots.
 *  - classSubjects:  Map<classId, Set<subjectId>>
 *  - subjectOrder:   ordered union of subject ids across the classes
 *  - sessionsPerDay: papers per day (slot j → day floor(j/S), session j%S)
 * Returns { assignments: [{class_id, subject_id, exam_date, session_index}], required }
 * where `required` is how many DATES the chosen mode needs.
 * Pure function — unit tested.
 */
export function assignSubjects({ classSubjects, subjectOrder, dates, mode, sessionsPerDay = 1 }) {
  const S = Math.max(1, sessionsPerDay);
  const assignments = [];
  let required = 0;
  if (mode === 'per_class') {
    for (const [classId, subjects] of classSubjects) {
      const ordered = subjectOrder.filter((s) => subjects.has(s));
      required = Math.max(required, Math.ceil(ordered.length / S));
      ordered.forEach((subjectId, j) => {
        const date = dates[Math.floor(j / S)];
        if (date) {
          assignments.push({
            class_id: classId,
            subject_id: subjectId,
            exam_date: date,
            session_index: j % S,
          });
        }
      });
    }
  } else {
    // aligned: slot j belongs to subject j for every class teaching it
    required = Math.ceil(subjectOrder.length / S);
    subjectOrder.forEach((subjectId, j) => {
      const date = dates[Math.floor(j / S)];
      if (!date) return;
      for (const [classId, subjects] of classSubjects) {
        if (subjects.has(subjectId)) {
          assignments.push({
            class_id: classId,
            subject_id: subjectId,
            exam_date: date,
            session_index: j % S,
          });
        }
      }
    });
  }
  return { assignments, required };
}

/** Expand holiday events overlapping the window into a list of ISO dates. */
async function fetchHolidayDates(db, schoolId, startDate, endDate) {
  const rows = await db`
    SELECT start_date, COALESCE(end_date, start_date) AS end_date
    FROM events
    WHERE school_id = ${schoolId}
      AND event_type = 'holiday'
      AND deleted_at IS NULL
      AND start_date <= ${endDate}
      AND COALESCE(end_date, start_date) >= ${startDate}
  `;
  const dates = [];
  for (const row of rows) {
    const from = toUtcDate(toIsoDate(new Date(row.start_date)));
    const to = toUtcDate(toIsoDate(new Date(row.end_date)));
    for (let d = from; d <= to; d = new Date(d.getTime() + 86400000)) {
      dates.push(toIsoDate(d));
    }
  }
  return dates;
}

/**
 * Generate (or regenerate) the timetable for an exam.
 * Returns { inserted, preserved, dates_used, subject_order, warnings }.
 */
export async function generateExamTimetable({ schoolId, examId, params: rawParams, db = sql }) {
  // `db` lets integration tests pass an open transaction (rolled back at the
  // end); production callers use the pooled `sql` default.
  const runInTx = typeof db.begin === 'function'
    ? (fn) => db.begin(fn)
    : (fn) => db.savepoint(fn);
  const params = normalizeParams(rawParams);

  const [exam] = await db`
    SELECT id, academic_year_id, timetable_published
    FROM exams
    WHERE id = ${examId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!exam) throw new ExamTimetableError('Exam not found', 404);

  const classes = await db`
    SELECT id, name FROM classes
    WHERE id = ANY(${params.class_ids}) AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (classes.length !== params.class_ids.length) {
    throw new ExamTimetableError('One or more classes not found for this school');
  }
  const classNames = new Map(classes.map((c) => [String(c.id), c.name]));

  // Subjects each class actually teaches (union of its sections' mappings).
  const subjectRows = await db`
    SELECT DISTINCT cs.class_id, sub.id AS subject_id, sub.name AS subject_name
    FROM class_subjects csub
    JOIN class_sections cs ON csub.class_section_id = cs.id
    JOIN subjects sub ON csub.subject_id = sub.id
    WHERE cs.class_id = ANY(${params.class_ids})
      AND cs.school_id = ${schoolId}
      AND csub.deleted_at IS NULL
      AND cs.deleted_at IS NULL
      AND sub.deleted_at IS NULL
  `;

  const classSubjects = new Map(params.class_ids.map((id) => [id, new Set()]));
  const subjectNames = new Map();
  for (const row of subjectRows) {
    classSubjects.get(String(row.class_id))?.add(String(row.subject_id));
    subjectNames.set(String(row.subject_id), row.subject_name);
  }

  const emptyClasses = params.class_ids.filter((id) => classSubjects.get(id).size === 0);
  if (emptyClasses.length > 0) {
    throw new ExamTimetableError(
      'Some classes have no subjects mapped. Assign subjects in Academics first.',
      400,
      { classes: emptyClasses.map((id) => classNames.get(id)) }
    );
  }

  const unionIds = [...new Set(subjectRows.map((r) => String(r.subject_id)))];
  const preFilterWarnings = [];
  let subjectOrder;
  if (params.subject_ids.length > 0) {
    // Explicit ordered selection: only these subjects, in exactly this order.
    subjectOrder = params.subject_ids.filter((id) => unionIds.includes(id));
    if (subjectOrder.length === 0) {
      throw new ExamTimetableError('None of the selected subjects are taught in the selected classes');
    }
    const selection = new Set(subjectOrder);
    for (const [classId, subjects] of classSubjects) {
      const kept = new Set([...subjects].filter((s) => selection.has(s)));
      classSubjects.set(classId, kept);
      if (kept.size === 0) {
        preFilterWarnings.push(
          `${classNames.get(classId)} teaches none of the selected subjects — no papers scheduled for it.`
        );
      }
    }
  } else {
    // Ordered union of subjects: explicit order first, remainder alphabetical.
    const explicit = params.subject_order.filter((id) => unionIds.includes(id));
    const rest = unionIds
      .filter((id) => !explicit.includes(id))
      .sort((a, b) => (subjectNames.get(a) || '').localeCompare(subjectNames.get(b) || ''));
    subjectOrder = [...explicit, ...rest];
  }

  const holidayDates = params.exclude_holidays
    ? await fetchHolidayDates(db, schoolId, params.start_date, params.end_date)
    : [];

  const dates = buildExamDates({
    startDate: params.start_date,
    endDate: params.end_date,
    includeSaturdays: params.include_saturdays,
    excludedDates: [...params.excluded_dates, ...holidayDates],
    gapDays: params.gap_days,
  });

  const sessionsPerDay = params.sessions.length;
  const { assignments, required } = assignSubjects({
    classSubjects,
    subjectOrder,
    dates,
    mode: params.mode,
    sessionsPerDay,
  });

  if (required > dates.length) {
    throw new ExamTimetableError(
      `Not enough exam days: ${subjectOrder.length} subject(s) at ${sessionsPerDay} session(s)/day need ${required} days but only ${dates.length} working days fit the selected window.`,
      400,
      { required_days: required, available_days: dates.length, holidays_skipped: holidayDates.length }
    );
  }

  const result = await runInTx(async (tx) => {
    await tx`SELECT id FROM exams WHERE id = ${examId} AND school_id = ${schoolId} FOR UPDATE`;

    // Papers with recorded marks are immovable — keep them exactly as they are.
    const preservedRows = await tx`
      SELECT es.id, es.class_id, es.subject_id
      FROM exam_subjects es
      WHERE es.exam_id = ${examId}
        AND es.school_id = ${schoolId}
        AND es.class_id = ANY(${params.class_ids})
        AND es.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id)
    `;
    const preservedKeys = new Set(
      preservedRows.map((r) => `${r.class_id}|${r.subject_id}`)
    );

    await tx`
      UPDATE exam_subjects es
      SET deleted_at = now()
      WHERE es.exam_id = ${examId}
        AND es.school_id = ${schoolId}
        AND es.class_id = ANY(${params.class_ids})
        AND es.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM marks m WHERE m.exam_subject_id = es.id)
    `;

    const toInsert = assignments
      .filter((a) => !preservedKeys.has(`${a.class_id}|${a.subject_id}`))
      .map((a) => ({
        school_id: schoolId,
        exam_id: examId,
        subject_id: a.subject_id,
        class_id: a.class_id,
        exam_date: a.exam_date,
        start_time: params.sessions[a.session_index]?.start_time ?? null,
        end_time: params.sessions[a.session_index]?.end_time ?? null,
        max_marks: params.max_marks,
        passing_marks: params.passing_marks,
      }));

    if (toInsert.length > 0) {
      await tx`INSERT INTO exam_subjects ${tx(toInsert)}`;
    }

    // Seating is derived from the schedule — a regenerated schedule invalidates
    // it, so clear it and tell the admin to reallocate. (Inline rather than
    // calling examAllocationService.clearExamSeating to avoid a module cycle.)
    await tx`
      UPDATE exam_seat_assignments SET deleted_at = now()
      WHERE exam_id = ${examId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    const clearedSeating = await tx`
      UPDATE exam_room_allocations SET deleted_at = now()
      WHERE exam_id = ${examId} AND school_id = ${schoolId} AND deleted_at IS NULL
      RETURNING id
    `;

    // Snap the exam window to the real scheduled span and force a re-publish.
    await tx`
      UPDATE exams
      SET start_date = (
            SELECT MIN(exam_date) FROM exam_subjects
            WHERE exam_id = ${examId} AND deleted_at IS NULL
          ),
          end_date = (
            SELECT MAX(exam_date) FROM exam_subjects
            WHERE exam_id = ${examId} AND deleted_at IS NULL
          ),
          timetable_params = ${sql.json(params)},
          timetable_published = FALSE,
          timetable_published_at = NULL
      WHERE id = ${examId} AND school_id = ${schoolId}
    `;

    return {
      inserted: toInsert.length,
      preserved: preservedRows.length,
      seating_cleared: clearedSeating.length,
    };
  });

  const warnings = [...preFilterWarnings];
  if (result.preserved > 0) {
    warnings.push(
      `${result.preserved} paper(s) already have marks recorded and were kept unchanged.`
    );
  }
  if (exam.timetable_published) {
    warnings.push('Timetable was un-published — review and publish again.');
  }
  if (result.seating_cleared > 0) {
    warnings.push('Seating & invigilation were cleared because the schedule changed — reallocate rooms.');
  }

  return {
    ...result,
    dates_used: dates.slice(0, required),
    subject_order: subjectOrder.map((id) => ({ id, name: subjectNames.get(id) })),
    warnings,
  };
}
