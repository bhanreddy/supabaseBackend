import sql from '../db.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function weekdayForDate(date) {
  return DAYS[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
}

/**
 * Resolves the school's configured timezone.
 * Defaults to 'Asia/Kolkata'.
 */
export async function getSchoolTimezone(exec, schoolId) {
  const [row] = await exec`
    SELECT timezone.name
    FROM school_settings setting
    JOIN pg_timezone_names timezone ON timezone.name = setting.value
    WHERE setting.school_id = ${schoolId}
      AND setting.key = 'school_timezone'
    LIMIT 1
  `;
  return row?.name || 'Asia/Kolkata';
}

/**
 * Returns today's date formatted as YYYY-MM-DD in the school's timezone.
 */
export async function getTodayInSchoolTimezone(exec, schoolId) {
  const [row] = await exec`
    SELECT to_char(
      now() AT TIME ZONE COALESCE(
        (
          SELECT timezone.name
          FROM school_settings setting
          JOIN pg_timezone_names timezone ON timezone.name = setting.value
          WHERE setting.school_id = ${schoolId}
            AND setting.key = 'school_timezone'
          LIMIT 1
        ),
        'Asia/Kolkata'
      ),
      'YYYY-MM-DD'
    ) AS date
  `;
  return row.date;
}

/**
 * Determines the first afternoon period number (sort_order) for the school.
 */
export async function getFirstAfternoonPeriodNumber(exec, schoolId) {
  const [row] = await exec`
    SELECT p.sort_order
    FROM periods p
    WHERE p.school_id = ${schoolId}
      AND COALESCE(p.is_break, false) = false
      AND p.sort_order > COALESCE(
        (SELECT sort_order FROM periods
          WHERE school_id = ${schoolId} AND name ILIKE '%lunch%'
          ORDER BY sort_order DESC LIMIT 1),
        (SELECT sort_order FROM periods
          WHERE school_id = ${schoolId} AND is_break = true
          ORDER BY (end_time - start_time) DESC, start_time LIMIT 1),
        (SELECT MIN(sort_order) - 1 FROM periods
          WHERE school_id = ${schoolId}
            AND COALESCE(is_break, false) = false
            AND start_time >= TIME '13:00')
      )
    ORDER BY p.sort_order
    LIMIT 1
  `;
  return row ? Number(row.sort_order) : 5;
}

/**
 * Resolves the academic year and effective timetable day for a given date.
 */
export async function getScheduleContext(exec, schoolId, date) {
  const [row] = await exec`
    SELECT ay.id AS academic_year_id, s.timetable_mode
    FROM academic_years ay
    JOIN schools s ON s.id = ay.school_id
    WHERE ay.school_id = ${schoolId}
      AND ${date}::date BETWEEN ay.start_date AND ay.end_date
    ORDER BY ay.start_date DESC
    LIMIT 1
  `;
  if (!row) return null;
  return {
    academicYearId: row.academic_year_id,
    mode: row.timetable_mode === 'per_day' ? 'per_day' : 'uniform',
    timetableDay: row.timetable_mode === 'per_day' ? weekdayForDate(date) : 'monday',
  };
}

/**
 * Automatically identifies all unavailable teachers for a selected school date.
 * Priority:
 *   1. Approved leave records (primary). Works even when attendance is not used.
 *   2. Staff attendance absent / half_day (supplemental, never overrides leave).
 *
 * Returns a deduplicated map of unavailable staff.
 */
export async function getUnavailableTeachers(exec, { schoolId, date }) {
  // 1. Approved leave records (Primary)
  const leaveRows = await exec`
    SELECT
      la.id AS leave_id,
      la.status AS leave_status,
      la.start_date,
      la.end_date,
      st.id AS staff_id,
      st.staff_code,
      COALESCE(NULLIF(p.display_name, ''), p.first_name, st.staff_code) AS teacher_name
    FROM leave_applications la
    JOIN users u ON u.id = la.applicant_id AND u.school_id = ${schoolId} AND u.deleted_at IS NULL
    JOIN staff st ON st.person_id = u.person_id AND st.school_id = ${schoolId} AND st.deleted_at IS NULL
    JOIN persons p ON p.id = st.person_id
    WHERE la.school_id = ${schoolId}
      AND la.status = 'approved'
      AND ${date}::date BETWEEN la.start_date AND la.end_date
  `;

  // 2. Staff attendance records (Supplemental)
  const attendanceRows = await exec`
    SELECT
      sa.id AS attendance_id,
      sa.status AS attendance_status,
      st.id AS staff_id,
      st.staff_code,
      COALESCE(NULLIF(p.display_name, ''), p.first_name, st.staff_code) AS teacher_name
    FROM staff_attendance sa
    JOIN staff st ON st.id = sa.staff_id AND st.school_id = ${schoolId} AND st.deleted_at IS NULL
    JOIN persons p ON p.id = st.person_id
    WHERE sa.school_id = ${schoolId}
      AND sa.attendance_date = ${date}::date
      AND sa.status IN ('absent', 'half_day')
      AND sa.deleted_at IS NULL
  `;

  // Check if attendance has been recorded for this date at all
  const [attCheck] = await exec`
    SELECT EXISTS(
      SELECT 1 FROM staff_attendance
      WHERE school_id = ${schoolId}
        AND attendance_date = ${date}::date
        AND deleted_at IS NULL
    ) AS attendance_recorded
  `;
  const attendanceRecorded = Boolean(attCheck?.attendance_recorded);

  // Build deduplicated union ("Leave first, attendance second")
  const unavailableMap = new Map();

  for (const row of leaveRows) {
    unavailableMap.set(row.staff_id, {
      id: row.staff_id,
      teacher_name: row.teacher_name,
      staff_code: row.staff_code,
      sources: ['leave'],
      source_label: 'Leave',
      leave_status: row.leave_status,
      attendance_status: null,
      is_half_day: false,
      affected_slots_count: 0,
    });
  }

  for (const row of attendanceRows) {
    const existing = unavailableMap.get(row.staff_id);
    const isHalfDay = row.attendance_status === 'half_day';
    const attLabel = isHalfDay ? 'Attendance: Half Day' : 'Attendance: Absent';

    if (existing) {
      // Deduplicate: teacher identified via leave, attendance supplements
      existing.sources.push('attendance');
      existing.attendance_status = row.attendance_status;
      existing.source_label = `Leave, ${attLabel}`;
    } else {
      unavailableMap.set(row.staff_id, {
        id: row.staff_id,
        teacher_name: row.teacher_name,
        staff_code: row.staff_code,
        sources: ['attendance'],
        source_label: attLabel,
        leave_status: null,
        attendance_status: row.attendance_status,
        is_half_day: isHalfDay,
        affected_slots_count: 0,
      });
    }
  }

  return {
    unavailableTeachers: [...unavailableMap.values()],
    unavailableMap,
    attendanceRecorded,
  };
}

/**
 * Discovers affected classes and returns the complete Substitution Board.
 */
export async function getSubstitutionBoardData(exec, { schoolId, date, scope = 'affected' }) {
  const [context, { unavailableTeachers, unavailableMap, attendanceRecorded }] = await Promise.all([
    getScheduleContext(exec, schoolId, date),
    getUnavailableTeachers(exec, { schoolId, date }),
  ]);

  if (!context) {
    return {
      date,
      academic_year_id: null,
      timetable_day: weekdayForDate(date),
      timetable_mode: 'uniform',
      periods: [],
      slots: [],
      teachers: [],
      unavailable_teachers: unavailableTeachers,
      attendance_recorded: attendanceRecorded,
      summary: {
        total_slots: 0,
        covered_slots: 0,
        uncovered_slots: 0,
        unavailable_teachers_count: unavailableTeachers.length,
      },
    };
  }

  const firstAfternoonPeriod = await getFirstAfternoonPeriodNumber(exec, schoolId);

  // Fetch all configured periods including breaks
  const periods = await exec`
    SELECT id, name, start_time, end_time, sort_order, COALESCE(is_break, false) AS is_break
    FROM periods
    WHERE school_id = ${schoolId}
    ORDER BY sort_order, start_time
  `;

  // Fetch scheduled slots for the day with teacher and substitution cover info
  const allSlots = await exec`
    SELECT
      ts.id AS slot_id, ts.class_section_id, ts.period_number,
      ts.start_time, ts.end_time, ts.room_no,
      COALESCE(p.is_break, false) AS is_break,
      p.name AS period_name,
      c.name AS class_name, sec.name AS section_name,
      sub.id AS subject_id, sub.name AS subject_name,
      ts.teacher_id AS regular_teacher_id,
      COALESCE(NULLIF(tp.display_name, ''), tp.first_name, regular_staff.staff_code) AS regular_teacher_name,
      cover.id AS substitution_id, cover.reason,
      cover.substitute_teacher_id,
      cover.is_auto_suggested,
      cover.leave_application_id,
      COALESCE(NULLIF(cp.display_name, ''), cp.first_name, cover_staff.staff_code) AS substitute_teacher_name,
      cover.created_at AS assigned_at
    FROM timetable_slots ts
    JOIN class_sections cs ON cs.id = ts.class_section_id
    JOIN classes c ON c.id = cs.class_id
    JOIN sections sec ON sec.id = cs.section_id
    JOIN subjects sub ON sub.id = ts.subject_id
    LEFT JOIN periods p ON p.school_id = ts.school_id AND p.sort_order = ts.period_number
    LEFT JOIN staff regular_staff ON regular_staff.id = ts.teacher_id
    LEFT JOIN persons tp ON tp.id = regular_staff.person_id
    LEFT JOIN timetable_substitutions cover
      ON cover.timetable_slot_id = ts.id
      AND cover.school_id = ${schoolId}
      AND cover.substitution_date = ${date}
      AND cover.cancelled_at IS NULL
    LEFT JOIN staff cover_staff ON cover_staff.id = cover.substitute_teacher_id
    LEFT JOIN persons cp ON cp.id = cover_staff.person_id
    WHERE ts.school_id = ${schoolId}
      AND cs.school_id = ${schoolId}
      AND ts.academic_year_id = ${context.academicYearId}
      AND LOWER(ts.day_of_week::text) = ${context.timetableDay}
      AND ts.deleted_at IS NULL
    ORDER BY ts.period_number, c.name, sec.name
  `;

  // Annotate each slot with unavailability metadata and filter according to scope
  const operationalSlots = [];
  const visibleSlots = [];
  const teacherAffectedCounts = new Map();

  for (const slot of allSlots) {
    const teacherId = slot.regular_teacher_id;
    const unavailableEntry = teacherId ? unavailableMap.get(teacherId) : null;
    let isAffected = false;
    let unavailabilitySources = null;
    let unavailabilityLabel = null;

    if (unavailableEntry) {
      if (unavailableEntry.is_half_day) {
        // Half-day attendance: only afternoon periods require cover
        if (slot.period_number >= firstAfternoonPeriod) {
          isAffected = true;
          unavailabilitySources = unavailableEntry.sources;
          unavailabilityLabel = unavailableEntry.source_label;
        }
      } else {
        // Full day unavailable
        isAffected = true;
        unavailabilitySources = unavailableEntry.sources;
        unavailabilityLabel = unavailableEntry.source_label;
      }
    }

    if (isAffected && teacherId) {
      teacherAffectedCounts.set(teacherId, (teacherAffectedCounts.get(teacherId) || 0) + 1);
    }

    // Slots with active substitutions are always included
    const hasActiveCover = Boolean(slot.substitution_id && slot.substitute_teacher_id);
    if (!isAffected && hasActiveCover) {
      unavailabilitySources = ['manual'];
      unavailabilityLabel = 'Manual Substitution';
    }

    const annotatedSlot = {
      ...slot,
      unavailability_sources: unavailabilitySources,
      unavailability_label: unavailabilityLabel,
    };

    // Operational rows are leave/absence slots plus any active cover.
    // Ordinary timetable rows are picker-only and must not become uncovered counts.
    if (isAffected || hasActiveCover) operationalSlots.push(annotatedSlot);
    if (scope === 'all' || isAffected || hasActiveCover) visibleSlots.push(annotatedSlot);
  }

  // Update affected counts on unavailable teachers
  for (const teacher of unavailableTeachers) {
    teacher.affected_slots_count = teacherAffectedCounts.get(teacher.id) || 0;
  }

  // Covered slots: slots with a confirmed substitute teacher.
  // Summary always uses operational rows, even when scope=all returns the full day.
  const coveredSlotsCount = operationalSlots.filter((s) => Boolean(s.substitution_id && s.substitute_teacher_name)).length;
  const uncoveredSlotsCount = operationalSlots.length - coveredSlotsCount;

  // Build the list of teachers for quick filtering
  const teachers = unavailableTeachers.map((t) => ({
    id: t.id,
    teacher_name: t.teacher_name,
  }));

  return {
    date,
    academic_year_id: context.academicYearId,
    timetable_day: context.timetableDay,
    timetable_mode: context.mode,
    periods,
    slots: visibleSlots,
    teachers,
    unavailable_teachers: unavailableTeachers,
    attendance_recorded: attendanceRecorded,
    summary: {
      total_slots: operationalSlots.length,
      covered_slots: coveredSlotsCount,
      uncovered_slots: uncoveredSlotsCount,
      unavailable_teachers_count: unavailableTeachers.length,
    },
  };
}

/**
 * A manual substitution is cover for a teacher who is not on approved leave
 * or marked unavailable for that period. Those assignments need a reason.
 */
export function requiresManualSubstitutionReason(unavailableEntry, periodNumber, firstAfternoonPeriod) {
  if (!unavailableEntry) return true;
  if (unavailableEntry.is_half_day && Number(periodNumber) < Number(firstAfternoonPeriod)) return true;
  return false;
}

/**
 * Validates whether a candidate teacher is eligible to substitute for a specific slot on a date.
 * Reusable for candidates endpoint and assignment creation/update.
 */
export async function validateSubstituteAvailability(exec, {
  schoolId,
  date,
  slot,
  substituteTeacherId,
  academicYearId,
  timetableDay,
  excludeSubstitutionId = null,
}) {
  if (slot.absent_teacher_id === substituteTeacherId) {
    return {
      available: false,
      status: 400,
      error: 'The regular teacher cannot substitute for their own class',
    };
  }

  // Check if substitute teacher is active and teaches in current academic year
  const [activeTeacher] = await exec`
    SELECT u.id
    FROM staff st
    LEFT JOIN staff_statuses ss ON ss.id = st.status_id
    JOIN users u ON u.person_id = st.person_id
      AND u.school_id = ${schoolId}
      AND u.deleted_at IS NULL
      AND u.account_status = 'active'
    WHERE st.id = ${substituteTeacherId}
      AND st.school_id = ${schoolId}
      AND st.deleted_at IS NULL
      AND (ss.id IS NULL OR ss.code = 'active')
      AND EXISTS (
        SELECT 1 FROM timetable_slots teaching
        WHERE teaching.teacher_id = st.id
          AND teaching.academic_year_id = ${academicYearId}
          AND teaching.deleted_at IS NULL
      )
    LIMIT 1
  `;
  if (!activeTeacher) {
    return {
      available: false,
      status: 400,
      error: 'Selected teacher is inactive or is not scheduled to teach this academic year',
    };
  }

  const firstAfternoonPeriod = await getFirstAfternoonPeriodNumber(exec, schoolId);

  // Check conflicts and unavailability
  const [conflict] = await exec`
    SELECT
      -- 1. Regular class conflict
      EXISTS (
        SELECT 1 FROM timetable_slots busy
        WHERE busy.teacher_id = ${substituteTeacherId}
          AND busy.academic_year_id = ${academicYearId}
          AND LOWER(busy.day_of_week::text) = ${timetableDay}
          AND busy.period_number = ${slot.period_number}
          AND busy.deleted_at IS NULL
      ) AS has_regular_class,

      -- 2. Other substitution duty clash in same period
      EXISTS (
        SELECT 1 FROM timetable_substitutions other_cover
        WHERE other_cover.school_id = ${schoolId}
          AND other_cover.substitution_date = ${date}
          AND other_cover.substitute_teacher_id = ${substituteTeacherId}
          AND other_cover.period_number = ${slot.period_number}
          AND other_cover.cancelled_at IS NULL
          AND (${excludeSubstitutionId}::uuid IS NULL OR other_cover.id <> ${excludeSubstitutionId}::uuid)
      ) AS has_other_cover,

      -- 3. Approved leave for this date
      EXISTS (
        SELECT 1 FROM leave_applications la
        JOIN users lu ON la.applicant_id = lu.id
        WHERE lu.person_id = (SELECT person_id FROM staff WHERE id = ${substituteTeacherId})
          AND la.school_id = ${schoolId}
          AND la.status = 'approved'
          AND ${date}::date BETWEEN la.start_date AND la.end_date
      ) AS is_on_leave,

      -- 4. Attendance absent
      EXISTS (
        SELECT 1 FROM staff_attendance sa
        WHERE sa.school_id = ${schoolId}
          AND sa.staff_id = ${substituteTeacherId}
          AND sa.attendance_date = ${date}
          AND sa.status = 'absent'
          AND sa.deleted_at IS NULL
      ) AS is_absent,

      -- 5. Attendance half-day during afternoon period
      EXISTS (
        SELECT 1 FROM staff_attendance sa
        WHERE sa.school_id = ${schoolId}
          AND sa.staff_id = ${substituteTeacherId}
          AND sa.attendance_date = ${date}
          AND sa.status = 'half_day'
          AND ${slot.period_number} >= ${firstAfternoonPeriod}
          AND sa.deleted_at IS NULL
      ) AS is_half_day_afternoon,

      -- 6. Declared absent in another substitution
      EXISTS (
        SELECT 1 FROM timetable_substitutions absent_cover
        WHERE absent_cover.school_id = ${schoolId}
          AND absent_cover.substitution_date = ${date}
          AND absent_cover.absent_teacher_id = ${substituteTeacherId}
          AND absent_cover.cancelled_at IS NULL
      ) AS declared_absent
  `;

  if (conflict.has_regular_class || conflict.has_other_cover) {
    return {
      available: false,
      status: 409,
      error: 'That teacher is no longer free in this period. Refresh and choose another teacher.',
    };
  }

  if (conflict.is_on_leave) {
    return {
      available: false,
      status: 409,
      error: 'That teacher is on approved leave for the selected date.',
    };
  }

  if (conflict.is_absent) {
    return {
      available: false,
      status: 409,
      error: 'That teacher is marked absent for the selected date.',
    };
  }

  if (conflict.is_half_day_afternoon) {
    return {
      available: false,
      status: 409,
      error: 'That teacher is on half-day attendance and is unavailable in the afternoon.',
    };
  }

  if (conflict.declared_absent) {
    return {
      available: false,
      status: 409,
      error: 'That teacher has been declared absent for the selected date.',
    };
  }

  return { available: true };
}
