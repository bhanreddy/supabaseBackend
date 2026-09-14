/**
 * Pure current-period matching. The route layer supplies timetable slots
 * already scoped to the authenticated teacher and school.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function weekdayFromDate(date, timezone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  }).formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value || '';
  return weekday.toLowerCase();
}

export function clockMinutesFromDate(date, timezone = 'Asia/Kolkata') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return hour * 60 + minute;
}

export function parseTimeToMinutes(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '';
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${String(mins).padStart(2, '0')} ${suffix}`;
}

export function classLabel(slot) {
  if (!slot) return '';
  const klass = slot.class_name || slot.className || '';
  const section = slot.section_name || slot.sectionName || '';
  return `${klass}${section}`.trim();
}

/**
 * @param {object[]} slots teacher timetable rows (may include substitutions)
 * @param {object} now
 * @param {string} now.weekday
 * @param {number} now.minutes
 */
export function detectCurrentClass(slots, now) {
  const list = Array.isArray(slots) ? slots : [];
  const weekday = String(now?.weekday || '').toLowerCase();
  const minutes = Number(now?.minutes);
  const todaySlots = list
    .filter((slot) => {
      const day = String(slot.day_of_week || slot.dayOfWeek || '').toLowerCase();
      // Uniform timetables often store the template on monday.
      return !day || day === weekday || (now?.uniform && day === 'monday');
    })
    .map((slot) => ({
      ...slot,
      startMinutes: parseTimeToMinutes(slot.start_time || slot.startTime),
      endMinutes: parseTimeToMinutes(slot.end_time || slot.endTime),
    }))
    .filter((slot) => slot.startMinutes != null && slot.endMinutes != null)
    .sort((a, b) => a.startMinutes - b.startMinutes);

  const current = todaySlots.find((slot) => minutes >= slot.startMinutes && minutes < slot.endMinutes);
  if (current) {
    return { slot: current, match: 'current', reason: 'timetable' };
  }

  const next = todaySlots.find((slot) => slot.startMinutes > minutes);
  if (next) {
    return { slot: next, match: 'next', reason: 'upcoming' };
  }

  const previous = [...todaySlots].reverse().find((slot) => slot.endMinutes <= minutes);
  if (previous) {
    return { slot: previous, match: 'previous', reason: 'last_period' };
  }

  return { slot: null, match: 'none', reason: 'no_timetable' };
}

export function toCurrentClassPayload(detection, recentAssignment = null, nowMinutes = null) {
  const slot = detection?.slot;
  if (slot) {
    return {
      class_section_id: slot.class_section_id,
      class_name: slot.class_name,
      section_name: slot.section_name,
      subject_id: slot.subject_id,
      subject_name: slot.subject_name,
      period_number: slot.period_number,
      start_time: slot.start_time,
      end_time: slot.end_time,
      display_class: classLabel(slot),
      display_time: formatClock(nowMinutes ?? slot.startMinutes),
      source: slot.is_substitution ? 'substitution' : (detection.reason || 'timetable'),
      match: detection.match,
    };
  }

  if (recentAssignment) {
    return {
      class_section_id: recentAssignment.class_section_id,
      class_name: recentAssignment.class_name,
      section_name: recentAssignment.section_name,
      subject_id: recentAssignment.subject_id,
      subject_name: recentAssignment.subject_name,
      period_number: null,
      start_time: null,
      end_time: null,
      display_class: classLabel(recentAssignment),
      display_time: nowMinutes != null ? formatClock(nowMinutes) : '',
      source: 'recent',
      match: 'recent',
    };
  }

  return null;
}

export function suggestionForCurrentClass(current, recentEntries = []) {
  if (!current?.class_section_id || !current?.subject_id) return null;
  const today = recentEntries.find((entry) => (
    entry.subject_id === current.subject_id
    && entry.class_section_id !== current.class_section_id
    && sameDay(entry.entry_date, recentEntries._today)
  ));
  const match = today || recentEntries.find((entry) => (
    entry.subject_id === current.subject_id
    && entry.class_section_id !== current.class_section_id
  ));
  if (!match) return null;
  return {
    type: 'reuse',
    diary_id: match.id,
    label: `Reuse today's ${match.class_name || ''}${match.section_name || ''} ${match.subject_name || ''} diary?`.replace(/\s+/g, ' ').trim(),
    preview: String(match.content || match.title || '').slice(0, 120),
  };
}

function sameDay(entryDate, today) {
  if (!today) return true;
  return String(entryDate || '').slice(0, 10) === String(today).slice(0, 10);
}

export { DAY_NAMES };
