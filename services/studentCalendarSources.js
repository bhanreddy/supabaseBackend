import { dateKey } from './attendanceCalendarModel.js';
import { schoolEventTimestamp } from './calendarTime.js';
import { selectEffectiveSectionPapers } from './examTimetableService.js';

// Read source modules in the caller's report snapshot. Calendar projections are
// intentionally excluded: an old copy must never resurrect an unpublished paper.
export async function loadStudentCalendarSources({ db, schoolId, yearId, start, end, timezone, enrollments }) {
  const papers = await db`SELECT es.id, es.exam_id, es.subject_id, es.class_id, es.class_section_id,
      es.exam_date::text, es.start_time::text, es.end_time::text,
      e.name AS exam_name, e.name_te AS exam_name_te, s.name AS subject_name, s.name_te AS subject_name_te
    FROM exam_subjects es JOIN exams e ON e.id = es.exam_id AND e.school_id = es.school_id
    LEFT JOIN subjects s ON s.id = es.subject_id AND s.school_id = es.school_id
    WHERE es.school_id = ${schoolId} AND e.academic_year_id = ${yearId}
      AND e.deleted_at IS NULL AND es.deleted_at IS NULL AND e.timetable_published = true
      AND e.status <> 'cancelled' AND es.exam_date IS NOT NULL`;
  const selected = new Map();
  for (const enrollment of enrollments) {
    const classPapers = papers.filter(p => String(p.class_id) === String(enrollment.class_id));
    for (const examId of new Set(classPapers.map(p => p.exam_id))) {
      for (const paper of selectEffectiveSectionPapers(classPapers.filter(p => p.exam_id === examId), enrollment.class_section_id)) {
        if (paper.exam_date < start || paper.exam_date > end || paper.exam_date < enrollment.start_date || (enrollment.end_date && paper.exam_date > enrollment.end_date)) continue;
        const key = `${paper.id}:${enrollment.class_section_id}`;
        selected.set(key, { id: `exam:${paper.id}`, source_module: 'EXAM', source_entity_id: paper.id,
          title: `${paper.exam_name}: ${paper.subject_name || 'Paper'}`,
          title_te: paper.exam_name_te && paper.subject_name_te ? `${paper.exam_name_te}: ${paper.subject_name_te}` : null,
          event_type: 'EXAM', start_date: paper.exam_date, end_date: paper.exam_date,
          start_datetime: paper.start_time ? schoolEventTimestamp(paper.exam_date, paper.start_time, timezone) : null,
          end_datetime: paper.end_time ? schoolEventTimestamp(paper.exam_date, paper.end_time, timezone) : null,
          is_all_day: !paper.start_time, attachments: [],
          targets: [{ target_type: 'SECTION', target_id: enrollment.class_section_id }] });
      }
    }
  }
  const events = await db`SELECT e.id, e.title, e.title_te, e.description, e.description_te,
      e.start_date::text, COALESCE(e.end_date, e.start_date)::text AS end_date,
      e.start_time::text, e.end_time::text, e.is_all_day, e.is_public, e.location,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('target_type', t.target_type, 'target_id', t.target_id))
        FROM event_audience_targets t WHERE t.event_id = e.id AND t.school_id = e.school_id), '[]'::jsonb) AS targets
    FROM events e WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL
      AND e.status IN ('PUBLISHED','REGISTRATION_OPEN','REGISTRATION_CLOSED','ONGOING','COMPLETED','CLOSURE_PENDING','CLOSED')
      AND e.start_date <= ${end} AND COALESCE(e.end_date, e.start_date) >= ${start}`;
  return [...selected.values(), ...events.map(e => ({
    id: `event:${e.id}`, source_module: 'EVENTS', source_entity_id: e.id,
    title: e.title, title_te: e.title_te, description: e.description, description_te: e.description_te,
    event_type: 'SCHOOL_EVENT', start_date: dateKey(e.start_date), end_date: dateKey(e.end_date),
    start_datetime: !e.is_all_day && e.start_time ? schoolEventTimestamp(e.start_date, e.start_time, timezone) : null,
    end_datetime: !e.is_all_day && e.end_time ? schoolEventTimestamp(e.end_date, e.end_time, timezone) : null,
    is_all_day: e.is_all_day, location: e.location, attachments: [],
    targets: e.targets.length ? e.targets : e.is_public ? [{ target_type: 'ENTIRE_SCHOOL', target_id: 'ALL' }] : [{ target_type: 'EXTERNAL', target_id: 'NONE' }],
  }))];
}
