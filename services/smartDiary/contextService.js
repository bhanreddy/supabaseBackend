import sql from '../../db.js';
import {
  loadClassTeacherSections,
  loadAdminClassSections,
  isPrivilegedDiaryRole,
} from './classTeacherService.js';
import {
  clockMinutesFromDate,
  detectCurrentClass,
  suggestionForCurrentClass,
  toCurrentClassPayload,
  weekdayFromDate,
} from './currentClass.js';

export async function loadTeacherStaffId(schoolId, userId, staffIdOverride = null) {
  if (staffIdOverride) {
    const [staff] = await sql`
      SELECT id FROM staff WHERE id = ${staffIdOverride} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    return staff?.id || null;
  }
  const [staff] = await sql`
    SELECT s.id
    FROM staff s
    JOIN persons p ON s.person_id = p.id
    JOIN users u ON u.person_id = p.id
    WHERE u.id = ${userId}
      AND s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
  `;
  return staff?.id || null;
}

export async function loadTeacherSlots(schoolId, staffId, timezone = 'Asia/Kolkata') {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const weekday = weekdayFromDate(new Date(), timezone);

  const [year] = await sql`
    SELECT id FROM academic_years
    WHERE school_id = ${schoolId}
    ORDER BY
      CASE WHEN CURRENT_DATE BETWEEN start_date AND end_date THEN 0 ELSE 1 END,
      start_date DESC
    LIMIT 1
  `;
  if (!year) return { slots: [], today, weekday, timezone };

  const [configRow] = await sql`
    SELECT timetable_mode FROM schools WHERE id = ${schoolId}
  `;
  const uniform = String(configRow?.timetable_mode || 'uniform').toLowerCase() !== 'per_day';

  const slots = await sql`
    SELECT
      ts.id,
      ts.class_section_id,
      ts.subject_id,
      ts.day_of_week,
      ts.start_time,
      ts.end_time,
      COALESCE(
        NULLIF((
          SELECT COUNT(*)::int FROM periods pp
          WHERE pp.school_id = ${schoolId}
            AND COALESCE(pp.is_break, false) = false
            AND pp.sort_order <= ts.period_number
        ), 0),
        ts.period_number
      ) AS period_number,
      c.name AS class_name,
      sec.name AS section_name,
      sub.name AS subject_name,
      FALSE AS is_substitution
    FROM timetable_slots ts
    JOIN class_sections cs ON ts.class_section_id = cs.id AND cs.school_id = ${schoolId}
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN subjects sub ON ts.subject_id = sub.id AND sub.school_id = ${schoolId}
    WHERE ts.teacher_id = ${staffId}
      AND ts.academic_year_id = ${year.id}
      AND ts.deleted_at IS NULL
      AND cs.academic_year_id = ${year.id}

    UNION ALL

    SELECT
      ts.id,
      ts.class_section_id,
      ts.subject_id,
      ts.day_of_week,
      ts.start_time,
      ts.end_time,
      COALESCE(
        NULLIF((
          SELECT COUNT(*)::int FROM periods pp
          WHERE pp.school_id = ${schoolId}
            AND COALESCE(pp.is_break, false) = false
            AND pp.sort_order <= ts.period_number
        ), 0),
        ts.period_number
      ) AS period_number,
      c.name AS class_name,
      sec.name AS section_name,
      sub.name AS subject_name,
      TRUE AS is_substitution
    FROM timetable_substitutions subn
    JOIN timetable_slots ts ON ts.id = subn.timetable_slot_id AND ts.school_id = ${schoolId}
    JOIN class_sections cs ON ts.class_section_id = cs.id AND cs.school_id = ${schoolId}
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN subjects sub ON ts.subject_id = sub.id AND sub.school_id = ${schoolId}
    WHERE subn.school_id = ${schoolId}
      AND subn.substitute_teacher_id = ${staffId}
      AND subn.substitution_date = ${today}::date
      AND subn.cancelled_at IS NULL
  `;

  return { slots, today, weekday, timezone, uniform };
}

export async function loadRecentDiary(schoolId, userInternalId, limit = 8) {
  return sql`
    SELECT
      d.id, d.entry_date, d.title, d.content, d.homework_due_date, d.attachments,
      d.class_section_id, d.subject_id, d.entry_source, d.created_at,
      s.name AS subject_name,
      c.name AS class_name,
      sec.name AS section_name
    FROM diary_entries d
    JOIN class_sections cs ON d.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    LEFT JOIN subjects s ON d.subject_id = s.id
    WHERE d.school_id = ${schoolId}
      AND d.created_by = ${userInternalId}
      AND d.deleted_at IS NULL
    ORDER BY d.created_at DESC
    LIMIT ${limit}
  `;
}

export async function buildSmartDiaryContext({
  schoolId,
  userId,
  userInternalId,
  staffIdOverride,
  displayName,
  roles = [],
}) {
  const timezone = 'Asia/Kolkata';
  const now = new Date();
  const staffId = await loadTeacherStaffId(schoolId, userId, staffIdOverride);
  const { slots, today, weekday, uniform } = staffId
    ? await loadTeacherSlots(schoolId, staffId, timezone)
    : { slots: [], today: new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now), weekday: weekdayFromDate(now, timezone), uniform: false };

  const minutes = clockMinutesFromDate(now, timezone);
  const detection = detectCurrentClass(slots, { weekday, minutes, uniform });
  const recent = await loadRecentDiary(schoolId, userInternalId);
  recent._today = today;
  const recentAssignment = recent[0]
    ? {
        class_section_id: recent[0].class_section_id,
        class_name: recent[0].class_name,
        section_name: recent[0].section_name,
        subject_id: recent[0].subject_id,
        subject_name: recent[0].subject_name,
      }
    : null;

  const current = toCurrentClassPayload(detection, recentAssignment, minutes);
  if (current) current.today = today;
  const suggestion = suggestionForCurrentClass(current, recent);

  let classTeacherSections = staffId ? await loadClassTeacherSections(schoolId, staffId) : [];
  if (isPrivilegedDiaryRole(roles) && classTeacherSections.length === 0) {
    classTeacherSections = await loadAdminClassSections(schoolId);
  }

  return {
    greeting_name: displayName || '',
    today,
    weekday,
    now_minutes: minutes,
    current,
    recent: recent.map(({ ...entry }) => entry),
    suggestion,
    timetable_count: slots.length,
    class_teacher_sections: classTeacherSections,
    can_upload_class_diary: classTeacherSections.length > 0,
  };
}
