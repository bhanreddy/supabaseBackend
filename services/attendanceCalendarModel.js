/** Pure attendance/calendar rules. No database, device clock, or UI calculations. */
export const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  id: 'default', effective_from: '0001-01-01', working_weekdays: [1, 2, 3, 4, 5, 6],
  half_day_weight: 0.5, submission_cutoff: null, show_teacher_name: false,
  notify_exams: true, notify_holidays: true, quiet_start: null, quiet_end: null,
});
export const attendanceError = (message, status = 400) => Object.assign(new Error(message), { status });
export const dateKey = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
export function calendarJson(value, fallback) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
}
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && dateKey(new Date(`${value}T00:00:00Z`)) === value;
}
export function schoolToday(timezone = 'Asia/Kolkata', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = key => parts.find(p => p.type === key).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function dateRange(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) throw attendanceError('Choose a valid date range with From Date on or before To Date.');
  const dates = [];
  for (const d = new Date(`${start}T00:00:00Z`); dateKey(d) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(dateKey(d));
    if (dates.length > 370) throw attendanceError('Select a range within one academic year (maximum 370 days).');
  }
  return dates;
}
export function policyForDate(policies = [], date) {
  return policies.filter(p => dateKey(p.effective_from) <= date)
    .sort((a, b) => dateKey(b.effective_from).localeCompare(dateKey(a.effective_from)))[0] || DEFAULT_ATTENDANCE_POLICY;
}
export function validatePolicy(input) {
  if (!validDate(input.effective_from)) throw attendanceError('A valid effective date is required.');
  if (!Array.isArray(input.working_weekdays) || input.working_weekdays.length > 7
    || input.working_weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)
    || new Set(input.working_weekdays).size !== input.working_weekdays.length) throw attendanceError('Working weekdays must be unique numbers from 0 (Sunday) to 6 (Saturday).');
  const weight = Number(input.half_day_weight);
  if (input.half_day_weight == null || input.half_day_weight === '' || typeof input.half_day_weight === 'boolean' || !Number.isFinite(weight) || weight < 0 || weight > 1) throw attendanceError('Half-day weight must be between 0 and 1.');
  for (const key of ['submission_cutoff', 'quiet_start', 'quiet_end']) {
    if (input[key] != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[key])) throw attendanceError(`${key} must be HH:mm or empty.`);
  }
  if (!!input.quiet_start !== !!input.quiet_end || (input.quiet_start && input.quiet_start === input.quiet_end)) throw attendanceError('Choose different start and end times for quiet hours, or leave both empty.');
  for (const key of ['show_teacher_name', 'notify_exams', 'notify_holidays']) {
    if (typeof input[key] !== 'boolean') throw attendanceError(`${key} must be true or false.`);
  }
  return { ...input, half_day_weight: weight };
}
export function eventApplies(event, enrollment, studentId, userId, roles = ['parent', 'student']) {
  const targets = event.targets || [];
  return targets.length === 0 || targets.some(t => {
    const id = String(t.target_id);
    return t.target_type === 'ENTIRE_SCHOOL'
      || (t.target_type === 'CLASS' && id === String(enrollment?.class_id))
      || (t.target_type === 'SECTION' && id === String(enrollment?.class_section_id))
      || (t.target_type === 'STUDENT' && id === String(studentId))
      || (t.target_type === 'USER' && !!userId && id === String(userId))
      || (t.target_type === 'ROLE' && roles.includes(id))
      || (t.target_type === 'PARENT' && roles.includes('parent'));
  });
}
export const isHolidayEvent = e => ['HOLIDAY', 'VACATION'].includes(e.event_type) || !!e.holiday_type;
export const isEmergencyEvent = e => e.holiday_type === 'EMERGENCY_HOLIDAY';
export function resolveDayRules(date, events, policy = DEFAULT_ATTENDANCE_POLICY) {
  const specificity = e => Math.max(0, ...(e.targets || []).map(t => ({ ENTIRE_SCHOOL: 1, ROLE: 2, CLASS: 3, SECTION: 4, STUDENT: 5 }[t.target_type] || 0)));
  const holidays = events.filter(isHolidayEvent).sort((a, b) => specificity(b) - specificity(a) || String(a.id).localeCompare(String(b.id)));
  const special = events.find(e => e.event_type === 'SPECIAL_WORKING_DAY');
  const emergency = holidays.find(isEmergencyEvent);
  const authorizedSpecial = special && (!holidays.length || holidays.every(h => (special.override_event_ids || []).includes(h.master_event_id || h.id)));
  const holiday = emergency || (!authorizedSpecial && holidays[0]);
  const conflict = !!special && !!holidays.length && (!authorizedSpecial || !!emergency);
  if (holiday) return { day_type: isEmergencyEvent(holiday) ? 'EMERGENCY_CLOSURE' : holiday.holiday_type === 'LOCAL_HOLIDAY' ? 'LOCAL_HOLIDAY' : 'FIXED_HOLIDAY',
    is_attendance_expected: false, holiday_name: holiday.title, holiday_name_te: holiday.title_te || null,
    holiday_type: holiday.holiday_type || holiday.event_type, conflict, source_event: holiday };
  if (special) return { day_type: 'SPECIAL_WORKING_DAY', is_attendance_expected: special.attendance_enabled !== false, conflict, source_event: special };
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return { day_type: policy.working_weekdays.includes(weekday) ? 'INSTRUCTIONAL' : 'WEEKLY_HOLIDAY',
    is_attendance_expected: policy.working_weekdays.includes(weekday), holiday_name: policy.working_weekdays.includes(weekday) ? null : 'Weekly holiday', conflict: false };
}
export function classifyAttendanceDays({ start, end, today, schoolClock = '00:00', enrollments = [], records = [], events = [], policies = [], studentId, userId, roles, year }) {
  const recordMap = new Map(records.map(r => [`${dateKey(r.attendance_date)}:${r.student_enrollment_id}`, r]));
  return dateRange(start, end).map(date => {
    const enrollment = enrollments.find(e => dateKey(e.start_date) <= date && (!e.end_date || dateKey(e.end_date) >= date)
      && (!year || (date >= dateKey(year.start_date) && date <= dateKey(year.end_date))));
    const policy = policyForDate(policies, date);
    const applicableEvents = enrollment ? events.filter(e => dateKey(e.start_date) <= date && dateKey(e.end_date || e.start_date) >= date
      && eventApplies(e, enrollment, studentId, userId, roles)) : [];
    const { source_event: _source, ...rules } = enrollment ? resolveDayRules(date, applicableEvents, policy)
      : { day_type: 'OUTSIDE_ENROLLMENT', is_attendance_expected: false, conflict: false };
    const record = enrollment && recordMap.get(`${date}:${enrollment.id}`);
    const isFuture = date > today;
    const outcome = !isFuture && rules.is_attendance_expected && record && ['present', 'absent', 'late', 'half_day'].includes(record.status) ? record.status : null;
    return { date, ...rules, is_future: isFuture,
      attendance_display_status: isFuture && rules.is_attendance_expected ? 'UPCOMING' : outcome || (rules.is_attendance_expected ? 'NOT_MARKED' : rules.day_type === 'OUTSIDE_ENROLLMENT' ? 'UNAVAILABLE' : 'HOLIDAY'),
      attendance: outcome ? { status: outcome, marked_at: record.marked_at || null,
        source_label: 'School', ...(policy.show_teacher_name && record.teacher_name ? { teacher_name: record.teacher_name } : {}) } : null,
      class_name: enrollment?.class_name || null, section_name: enrollment?.section_name || null,
      half_day_weight: Number(policy.half_day_weight), policy_version: `${policy.id}:${policy.revision || 1}`,
      has_record_conflict: !!record && !rules.is_attendance_expected,
      submission_overdue: !!policy.submission_cutoff && rules.is_attendance_expected && !outcome && !isFuture
        && (date < today || schoolClock >= String(policy.submission_cutoff).slice(0, 5)),
      events: applicableEvents.map(({ targets: _targets, created_by: _creator, ...e }) => e) };
  });
}
export function calendarActivities(days) {
  const weekly = days.filter(d => d.day_type === 'WEEKLY_HOLIDAY').map(d => ({
    id: `weekly:${d.date}`, title: 'Weekly holiday', title_te: 'వారాంతపు సెలవు', event_type: 'HOLIDAY',
    start_date: d.date, end_date: d.date, is_all_day: true, holiday_type: 'WEEKLY', attachments: [],
  }));
  return [...new Map([...days.flatMap(d => d.events), ...weekly].map(e => [`${e.id}:${e.start_date}`, e])).values()];
}
export function summarizeAttendance(days, { finalizations = [], end, today } = {}) {
  const result = { scheduled_working_days: 0, elapsed_working_days: 0, remaining_working_days: 0,
    marked_days: 0, present: 0, absent: 0, late: 0, half_day: 0, not_marked: 0, holidays: 0,
    effective_present: 0, attendance_percentage: null, conflicts: 0, report_status: 'PROVISIONAL' };
  for (const d of days) {
    if (d.conflict || d.has_record_conflict) result.conflicts++;
    if (!d.is_attendance_expected) {
      if (!['OUTSIDE_ENROLLMENT'].includes(d.day_type)) result.holidays++;
      continue;
    }
    result.scheduled_working_days++;
    if (d.is_future) { result.remaining_working_days++; continue; }
    result.elapsed_working_days++;
    if (!d.attendance) { result.not_marked++; continue; }
    result.marked_days++;
    result[d.attendance.status]++;
    result.effective_present += d.attendance.status === 'half_day' ? d.half_day_weight : d.attendance.status === 'absent' ? 0 : 1;
  }
  result.effective_present = Math.round(result.effective_present * 10000) / 10000;
  if (result.marked_days) result.attendance_percentage = Math.round(result.effective_present / result.marked_days * 1000) / 10;
  if (result.marked_days && !result.not_marked && !result.conflicts && end <= today
    && days.filter(d => d.is_attendance_expected).every(d => finalizations.some(f => f.status === 'FINALIZED' && dateKey(f.from_date) <= d.date && dateKey(f.to_date) >= d.date))) result.report_status = 'FINALIZED';
  return result;
}
export function buildAttendanceReport(input) {
  const days = classifyAttendanceDays(input);
  const summarize = subset => summarizeAttendance(subset, { finalizations: input.finalizations || [], end: subset.at(-1)?.date, today: input.today });
  const months = [...new Set(days.map(d => d.date.slice(0, 7)))].map(month => ({ month, ...summarize(days.filter(d => d.date.startsWith(month))) }));
  return { days, summary: summarize(days), months,
    calculation: { version: 'attendance-calendar-v1', formula: '(Present + Late + weighted Half Days) / marked days × 100',
      policy_versions: [...new Set(days.map(d => d.policy_version))], excludes: ['NOT_MARKED', 'HOLIDAYS', 'FUTURE', 'OUTSIDE_ENROLLMENT'] } };
}
