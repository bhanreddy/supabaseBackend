import { createHash } from 'node:crypto';
import sql from '../db.js';
import { loadStudentCalendarSources } from './studentCalendarSources.js';
import { attendanceCalendarSchema, requireAttendanceCalendarSchema } from './attendanceCalendarSchema.js';
import { expandRecurrenceOccurrences } from './calendarService.js';
import { DEFAULT_ATTENDANCE_POLICY, attendanceError, dateKey, validDate, schoolToday,
  buildAttendanceReport, policyForDate, validatePolicy, calendarJson } from './attendanceCalendarModel.js';

export async function calendarCapabilities(schoolId, db = sql) {
  const rows = await db`SELECT key, value FROM school_settings WHERE school_id = ${schoolId}
    AND key IN ('attendance_calendar_v2_enabled', 'school_timezone')`;
  const values = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let timezone = values.school_timezone || 'Asia/Kolkata';
  try { schoolToday(timezone); } catch { timezone = 'Asia/Kolkata'; }
  const schema = await attendanceCalendarSchema(db);
  return { enabled: schema.ready && values.attendance_calendar_v2_enabled === 'true', schema_ready: schema.ready, timezone, school_today: schoolToday(timezone) };
}
export async function requireCalendarEnabled(schoolId, db = sql) {
  const caps = await calendarCapabilities(schoolId, db);
  if (!caps.enabled) throw attendanceError('The enhanced attendance calendar has not been enabled for this school.', 404);
  return caps;
}
export async function loadAttendancePolicies(schoolId, db = sql) {
  if (!(await attendanceCalendarSchema(db)).ready) return [];
  const rows = await db`SELECT * FROM attendance_calendar_policies WHERE school_id = ${schoolId} ORDER BY effective_from DESC`;
  return rows.map(r => ({ ...r, effective_from: dateKey(r.effective_from), half_day_weight: Number(r.half_day_weight),
    submission_cutoff: r.submission_cutoff?.slice(0, 5) || null, quiet_start: r.quiet_start?.slice(0, 5) || null, quiet_end: r.quiet_end?.slice(0, 5) || null }));
}
export async function saveAttendancePolicy(schoolId, actorId, body, db = sql) {
  await requireAttendanceCalendarSchema(db);
  const input = validatePolicy(body);
  if (!String(body.reason || '').trim()) throw attendanceError('Explain the policy change for the audit history.');
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(61115, ${Number(schoolId)})`;
    await tx`SELECT set_config('app.attendance_actor', ${actorId}, true), set_config('app.attendance_reason', ${body.reason.trim()}, true)`;
    const [policy] = await tx`INSERT INTO attendance_calendar_policies
      (school_id, effective_from, working_weekdays, half_day_weight, submission_cutoff, show_teacher_name,
       notify_exams, notify_holidays, quiet_start, quiet_end, created_by)
      VALUES (${schoolId}, ${input.effective_from}, ${input.working_weekdays}, ${input.half_day_weight}, ${input.submission_cutoff || null},
        ${input.show_teacher_name}, ${input.notify_exams}, ${input.notify_holidays}, ${input.quiet_start || null}, ${input.quiet_end || null}, ${actorId})
      ON CONFLICT (school_id, effective_from) DO UPDATE SET working_weekdays = EXCLUDED.working_weekdays,
        half_day_weight = EXCLUDED.half_day_weight, submission_cutoff = EXCLUDED.submission_cutoff,
        show_teacher_name = EXCLUDED.show_teacher_name, notify_exams = EXCLUDED.notify_exams,
        notify_holidays = EXCLUDED.notify_holidays, quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end,
        revision = attendance_calendar_policies.revision + 1
      RETURNING *`;
    if (typeof body.enabled === 'boolean') {
      await tx`INSERT INTO school_settings(school_id, key, value, updated_at)
        VALUES (${schoolId}, 'attendance_calendar_v2_enabled', ${String(body.enabled)}, now())
        ON CONFLICT (school_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
      await tx`INSERT INTO audit_logs(school_id, user_id, action, entity, details)
        VALUES (${schoolId}, ${actorId}, 'ROLLOUT_CHANGED', 'attendance_calendar', ${tx.json({ enabled: body.enabled, reason: body.reason })})`;
    }
    return policy;
  });
}

/** Bounded reads, irrespective of number of dates. All reads use the same transaction snapshot. */
export async function loadStudentAttendanceCalendar({ schoolId, studentId, userId, roles, academicYearId, month, from, to, report = false }, db = sql) {
  return db.begin('isolation level repeatable read read only', async tx => {
    const caps = await requireCalendarEnabled(schoolId, tx);
    if (academicYearId && (typeof academicYearId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(academicYearId))) throw attendanceError('Choose a valid academic year.');
    if (month && (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))) throw attendanceError('Month must be YYYY-MM.');
    const anchor = month ? `${month}-01` : from || caps.school_today;
    if (!validDate(anchor)) throw attendanceError('Choose a valid start date.');
    const years = await tx`SELECT id, code, start_date::text, end_date::text FROM academic_years
      WHERE school_id = ${schoolId} AND deleted_at IS NULL
      ${academicYearId ? tx`AND id = ${academicYearId}` : tx`AND start_date <= ${anchor} AND end_date >= ${anchor}`}
      ORDER BY start_date DESC LIMIT 1`;
    const year = years[0];
    if (!year) throw attendanceError('No academic year is configured for the selected date.', 404);
    const start = month ? `${month}-01` : from;
    const end = month ? dateKey(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))) : to;
    if (!validDate(start) || !validDate(end) || start > end) throw attendanceError('From Date must be on or before To Date.');
    if (report && (start < year.start_date || end > year.end_date || end > caps.school_today)) throw attendanceError('Reports must stay within the selected academic year and end no later than today.');
    const [student] = await tx`SELECT s.id, s.admission_no, s.admission_date::text, s.exit_date::text, p.display_name AS student_name, sc.name AS school_name
      FROM students s JOIN persons p ON p.id = s.person_id JOIN schools sc ON sc.id = s.school_id
      WHERE s.id = ${studentId} AND s.school_id = ${schoolId} AND s.deleted_at IS NULL`;
    if (!student) throw attendanceError('Student profile not found.', 404);
    const enrollments = await tx`SELECT se.id, se.class_section_id, cs.class_id, se.start_date::text, se.end_date::text,
        c.name AS class_name, sec.name AS section_name
      FROM student_enrollments se JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = se.school_id
      JOIN classes c ON c.id = cs.class_id JOIN sections sec ON sec.id = cs.section_id
      WHERE se.school_id = ${schoolId} AND se.student_id = ${studentId} AND se.academic_year_id = ${year.id}
        AND se.deleted_at IS NULL AND se.start_date <= ${end} AND (se.end_date IS NULL OR se.end_date >= ${start})
      ORDER BY se.start_date DESC`;
    const boundedEnrollments = enrollments.map(e => ({ ...e,
      start_date: student.admission_date && student.admission_date > e.start_date ? student.admission_date : e.start_date,
      end_date: student.exit_date && (!e.end_date || student.exit_date < e.end_date) ? student.exit_date : e.end_date }));
    const records = await tx`SELECT da.id, da.student_enrollment_id, da.attendance_date::text, da.status, da.marked_at,
        tp.display_name AS teacher_name FROM daily_attendance da
      JOIN student_enrollments se ON se.id = da.student_enrollment_id AND se.school_id = da.school_id
      LEFT JOIN users u ON u.id = da.marked_by AND u.school_id = da.school_id LEFT JOIN persons tp ON tp.id = u.person_id
      WHERE da.school_id = ${schoolId} AND se.student_id = ${studentId} AND se.academic_year_id = ${year.id}
        AND da.attendance_date BETWEEN ${start} AND ${end} AND da.deleted_at IS NULL AND se.deleted_at IS NULL`;
    const rawEvents = await tx`SELECT e.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('target_type', t.target_type, 'target_id', t.target_id))
      FROM calendar_event_targets t WHERE t.school_id = e.school_id AND t.event_id = e.id), '[]'::jsonb) AS targets
      FROM calendar_events e WHERE e.school_id = ${schoolId} AND e.deleted_at IS NULL
        AND e.status IN ('PUBLISHED', 'COMPLETED') AND (e.academic_year_id IS NULL OR e.academic_year_id = ${year.id})
        AND COALESCE(e.source_module, 'MANUAL') NOT IN ('EXAM', 'EVENT', 'EVENTS') AND e.event_type <> 'EXAM'
        AND e.start_date <= ${end} AND (e.end_date >= ${start} OR e.recurrence_rule IS NOT NULL)`;
    const events = rawEvents.flatMap(e => {
      const event = { ...e, recurrence_rule: calendarJson(e.recurrence_rule, null),
        attachments: calendarJson(e.attachments, []),
        school_timezone: caps.timezone, start_date: dateKey(e.start_date), end_date: dateKey(e.end_date) };
      return event.recurrence_rule?.frequency && !event.recurrence_parent_id ? expandRecurrenceOccurrences(event, start, end) : [event];
    }).map(e => ({ id: e.id, master_event_id: e.master_event_id, title: e.title, title_te: e.title_te,
      description: e.description, description_te: e.description_te, event_type: e.event_type, start_date: e.start_date, end_date: e.end_date,
      start_datetime: e.start_datetime, end_datetime: e.end_datetime, is_all_day: e.is_all_day, location: e.location,
      attachments: Array.isArray(e.attachments) ? e.attachments : [], holiday_type: e.holiday_type, attendance_enabled: e.attendance_enabled,
      override_event_ids: e.override_event_ids || [], targets: e.targets, source_module: 'ACADEMIC_CALENDAR', source_entity_id: e.id }));
    events.push(...await loadStudentCalendarSources({ db: tx, schoolId, yearId: year.id, start, end, timezone: caps.timezone, enrollments: boundedEnrollments }));
    const policies = await loadAttendancePolicies(schoolId, tx);
    const finalizations = await tx`SELECT from_date::text, to_date::text, status FROM attendance_report_finalizations
      WHERE school_id = ${schoolId} AND student_id = ${studentId} AND academic_year_id = ${year.id}
        AND from_date <= ${end} AND to_date >= ${start}`;
    const schoolClock = new Intl.DateTimeFormat('en-GB', { timeZone: caps.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const result = buildAttendanceReport({ start, end, today: caps.school_today, schoolClock, studentId, userId, roles, year, enrollments: boundedEnrollments, records, events, policies, finalizations });
    const current = policyForDate(policies, caps.school_today);
    const hash = createHash('sha256').update(JSON.stringify({ days: result.days, calculation: result.calculation })).digest('hex');
    return { ...result, student, academic_year: year, from_date: start, to_date: end,
      timezone: caps.timezone, school_today: caps.school_today, generated_at: new Date().toISOString(), snapshot_hash: hash,
      policy: { half_day_weight: Number(current.half_day_weight), show_teacher_name: current.show_teacher_name } };
  });
}

export async function finalizeAttendanceReport(input, actorId, reason, expectedHash, db = sql) {
  if (!String(reason || '').trim()) throw attendanceError('A finalization reason is required.');
  // Read after taking the same lock acquired by source-write triggers. A teacher
  // write cannot slip between the snapshot check and finalization persistence.
  return db.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(61117, ${Number(input.schoolId)})`;
    const snapshot = await loadStudentAttendanceCalendar({ ...input, report: true }, {
      begin: async (_options, callback) => callback(tx),
    });
    if (snapshot.snapshot_hash !== expectedHash) throw attendanceError('Attendance changed. Refresh the report before finalizing.', 409);
    if (snapshot.summary.not_marked || snapshot.summary.conflicts || !snapshot.summary.marked_days || snapshot.to_date >= snapshot.school_today)
      throw attendanceError('Only completed past periods with marked attendance and no pending entries or conflicts can be finalized.', 409);
    await tx`SELECT set_config('app.attendance_actor', ${actorId}, true), set_config('app.attendance_reason', ${reason.trim()}, true)`;
    const [row] = await tx`INSERT INTO attendance_report_finalizations
      (school_id, student_id, academic_year_id, from_date, to_date, status, snapshot_hash, finalized_by, reason)
      VALUES (${input.schoolId}, ${input.studentId}, ${snapshot.academic_year.id}, ${snapshot.from_date}, ${snapshot.to_date},
        'FINALIZED', ${snapshot.snapshot_hash}, ${actorId}, ${reason.trim()})
      ON CONFLICT (school_id, student_id, academic_year_id, from_date, to_date) DO UPDATE
        SET status = 'FINALIZED', snapshot_hash = EXCLUDED.snapshot_hash, finalized_by = EXCLUDED.finalized_by,
          finalized_at = now(), reopened_at = NULL, reason = EXCLUDED.reason RETURNING *`;
    return row;
  });
}

export { DEFAULT_ATTENDANCE_POLICY };
