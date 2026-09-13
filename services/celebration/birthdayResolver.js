import sql from '../../db.js';
import { getSchoolDateContext, DEFAULT_SCHOOL_TIMEZONE } from './celebrationUtils.js';
import logger from '../../utils/logger.js';

/**
 * Retrieves the school's configured timezone from school_settings.
 * @param {number} schoolId
 * @returns {Promise<string>}
 */
export async function getSchoolTimezone(schoolId) {
  try {
    const [row] = await sql`
      SELECT timezone.name AS timezone
      FROM school_settings setting
      JOIN pg_timezone_names timezone ON timezone.name = setting.value
      WHERE setting.school_id = ${schoolId}
        AND setting.key = 'school_timezone'
      LIMIT 1
    `;
    return row?.timezone || DEFAULT_SCHOOL_TIMEZONE;
  } catch {
    return DEFAULT_SCHOOL_TIMEZONE;
  }
}

/**
 * Resolves active student birthdays for a school and target date context.
 *
 * @param {number} schoolId
 * @param {{ month: number, day: number, isNonLeapYearFeb28: boolean }} dateContext
 * @returns {Promise<Array<object>>}
 */
export async function findStudentBirthdays(schoolId, dateContext) {
  const { month, day, isNonLeapYearFeb28 } = dateContext;

  const rows = await sql`
    SELECT DISTINCT ON (s.id)
      s.id AS student_id,
      p.id AS person_id,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.display_name,
      p.photo_url,
      c.id AS class_id,
      c.name AS class_name,
      c.code AS class_code,
      sec.id AS section_id,
      sec.name AS section_name,
      cs.id AS class_section_id,
      cs.class_teacher_id,
      se.roll_number
    FROM students s
    JOIN persons p ON s.person_id = p.id
    JOIN student_statuses st ON s.status_id = st.id
    JOIN student_enrollments se ON se.student_id = s.id
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND se.school_id = ${schoolId}
    JOIN class_sections cs ON se.class_section_id = cs.id
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND p.dob IS NOT NULL
      AND COALESCE(st.is_terminal, false) = false
      AND LOWER(st.code) IN ('active', 'enrolled')
      AND (
        (EXTRACT(MONTH FROM p.dob) = ${month} AND EXTRACT(DAY FROM p.dob) = ${day})
        OR (${isNonLeapYearFeb28} AND EXTRACT(MONTH FROM p.dob) = 2 AND EXTRACT(DAY FROM p.dob) = 29)
      )
    ORDER BY s.id, c.sort_order ASC NULLS LAST, sec.name ASC, p.first_name ASC
  `;

  return rows.map((r) => ({
    eventType: 'BIRTHDAY',
    targetType: 'STUDENT',
    targetId: r.student_id,
    personId: r.person_id,
    schoolId: String(schoolId),
    firstName: r.first_name || '',
    middleName: r.middle_name || '',
    lastName: r.last_name || '',
    displayName: r.display_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Student',
    photoUrl: r.photo_url || null,
    classId: r.class_id || null,
    className: r.class_name || r.class_code || '',
    sectionId: r.section_id || null,
    sectionName: r.section_name || '',
    classSectionId: r.class_section_id || null,
    classTeacherId: r.class_teacher_id || null,
    rollNumber: r.roll_number || null,
  }));
}

/**
 * Resolves active staff birthdays for a school and target date context.
 *
 * @param {number} schoolId
 * @param {{ month: number, day: number, isNonLeapYearFeb28: boolean }} dateContext
 * @returns {Promise<Array<object>>}
 */
export async function findStaffBirthdays(schoolId, dateContext) {
  const { month, day, isNonLeapYearFeb28 } = dateContext;

  const rows = await sql`
    SELECT
      st.id AS staff_id,
      p.id AS person_id,
      p.first_name,
      p.middle_name,
      p.last_name,
      p.display_name,
      p.photo_url,
      sd.name AS designation_name
    FROM staff st
    JOIN persons p ON st.person_id = p.id
    JOIN staff_statuses ss ON st.status_id = ss.id
    LEFT JOIN staff_designations sd ON st.designation_id = sd.id
    WHERE st.school_id = ${schoolId}
      AND st.deleted_at IS NULL
      AND p.deleted_at IS NULL
      AND p.dob IS NOT NULL
      AND LOWER(ss.code) IN ('active', 'on_leave')
      AND (
        (EXTRACT(MONTH FROM p.dob) = ${month} AND EXTRACT(DAY FROM p.dob) = ${day})
        OR (${isNonLeapYearFeb28} AND EXTRACT(MONTH FROM p.dob) = 2 AND EXTRACT(DAY FROM p.dob) = 29)
      )
    ORDER BY p.first_name ASC
  `;

  return rows.map((r) => ({
    eventType: 'BIRTHDAY',
    targetType: 'STAFF',
    targetId: r.staff_id,
    personId: r.person_id,
    schoolId: String(schoolId),
    firstName: r.first_name || '',
    middleName: r.middle_name || '',
    lastName: r.last_name || '',
    displayName: r.display_name || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Staff Member',
    photoUrl: r.photo_url || null,
    designation: r.designation_name || 'Staff',
  }));
}

/**
 * Resolves all eligible birthdays for a school today (in school timezone).
 *
 * @param {{ schoolId: number, asOfDate?: Date, includeStudents?: boolean, includeStaff?: boolean }} options
 * @returns {Promise<{
 *   dateContext: ReturnType<typeof getSchoolDateContext>,
 *   students: Array<object>,
 *   staff: Array<object>
 * }>}
 */
export async function resolveBirthdays({
  schoolId,
  asOfDate = new Date(),
  includeStudents = true,
  includeStaff = true,
} = {}) {
  const timezone = await getSchoolTimezone(schoolId);
  const dateContext = getSchoolDateContext(timezone, asOfDate);

  const [students, staff] = await Promise.all([
    includeStudents ? findStudentBirthdays(schoolId, dateContext) : Promise.resolve([]),
    includeStaff ? findStaffBirthdays(schoolId, dateContext) : Promise.resolve([]),
  ]);

  logger.info({
    event: 'birthday_resolution_completed',
    schoolId,
    localDate: dateContext.localDate,
    studentBirthdayCount: students.length,
    staffBirthdayCount: staff.length,
  });

  return {
    dateContext,
    students,
    staff,
  };
}
