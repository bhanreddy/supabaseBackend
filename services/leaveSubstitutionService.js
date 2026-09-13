import sql from '../db.js';
import { resolveSchoolDay } from './workingDayResolver.js';
import logger from '../utils/logger.js';
import { getSchoolAutomationRule, RULE_KEYS } from './automationRuleService.js';
import { rankSubstitutionCandidates } from './substitutionRankingService.js';
import { sendNotificationToUsers } from './notificationService.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function weekdayForDate(date) {
  return DAYS[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
}

function enumerateDatesBetween(startDateStr, endDateStr) {
  const dates = [];
  const curr = new Date(startDateStr);
  const end = new Date(endDateStr);
  while (curr <= end) {
    dates.push(curr.toISOString().slice(0, 10));
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

/**
 * Handle approved staff leave: resolve affected periods and rank substitute candidates.
 */
export async function handleStaffLeaveApproved({ schoolId, leaveId, applicantId, startDate, endDate }) {
  if (!schoolId || !leaveId || !applicantId || !startDate || !endDate) {
    logger.warn({ schoolId, leaveId, applicantId }, 'Missing required params for leave substitution handoff');
    return { success: false, reason: 'INVALID_PARAMS' };
  }

  // 1. Resolve staff record
  const [teacher] = await sql`
    SELECT st.id AS staff_id, p.display_name, st.staff_code, u.id AS user_id
    FROM users u
    JOIN staff st ON u.person_id = st.person_id
    JOIN persons p ON st.person_id = p.id
    WHERE u.id = ${applicantId} AND u.school_id = ${schoolId}
  `;

  if (!teacher) {
    logger.warn({ schoolId, applicantId }, 'Staff record not found for leave applicant');
    return { success: false, reason: 'STAFF_NOT_FOUND' };
  }

  // 2. Fetch automation rule
  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.AUTOMATED_SUBSTITUTION);
  const autoAssign = Boolean(rule?.trigger_config?.auto_assign);

  const dates = enumerateDatesBetween(startDate, endDate);
  const affectedSlotsCreated = [];

  for (const date of dates) {
    const dayStatus = await resolveSchoolDay(schoolId, date);
    if (!dayStatus.timetableEnabled && !dayStatus.isSpecialWorkingDay) {
      continue;
    }

    const [context] = await sql`
      SELECT ay.id AS academic_year_id, s.timetable_mode
      FROM academic_years ay
      JOIN schools s ON s.id = ay.school_id
      WHERE ay.school_id = ${schoolId}
        AND ${date}::date BETWEEN ay.start_date AND ay.end_date
      ORDER BY ay.start_date DESC
      LIMIT 1
    `;

    if (!context) continue;

    const timetableDay = dayStatus.timetableDay || (context.timetable_mode === 'per_day' ? weekdayForDate(date) : 'monday');

    // Teaching slots for the absent teacher
    const slots = await sql`
      SELECT
        ts.id AS slot_id, ts.class_section_id, ts.period_number,
        ts.subject_id, ts.start_time, ts.end_time,
        c.name AS class_name, sec.name AS section_name,
        sub.name AS subject_name
      FROM timetable_slots ts
      JOIN class_sections cs ON cs.id = ts.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections sec ON sec.id = cs.section_id
      JOIN subjects sub ON sub.id = ts.subject_id
      WHERE ts.school_id = ${schoolId}
        AND ts.teacher_id = ${teacher.staff_id}
        AND ts.academic_year_id = ${context.academic_year_id}
        AND LOWER(ts.day_of_week::text) = ${timetableDay}
        AND ts.deleted_at IS NULL
      ORDER BY ts.period_number
    `;

    for (const slot of slots) {
      // Check if substitution record already exists for this slot + date
      const [existingCover] = await sql`
        SELECT id, is_auto_suggested
        FROM timetable_substitutions
        WHERE timetable_slot_id = ${slot.slot_id}
          AND substitution_date = ${date}
          AND school_id = ${schoolId}
          AND cancelled_at IS NULL
      `;

      if (existingCover) {
        continue; // Do not duplicate existing assignment
      }

      // Fetch candidate pool using candidate ranking engine query
      const candidates = await sql`
        SELECT
          st.id, st.staff_code, p.photo_url,
          COALESCE(NULLIF(p.display_name, ''), p.first_name, st.staff_code) AS teacher_name,
          ${slot.subject_name}::text AS subject_name,
          EXISTS (
            SELECT 1 FROM timetable_slots own_subject
            WHERE own_subject.teacher_id = st.id
              AND own_subject.academic_year_id = ${context.academic_year_id}
              AND own_subject.subject_id = ${slot.subject_id}
              AND own_subject.deleted_at IS NULL
          ) AS subject_match,
          EXISTS (
            SELECT 1 FROM timetable_slots known_class
            WHERE known_class.teacher_id = st.id
              AND known_class.academic_year_id = ${context.academic_year_id}
              AND known_class.class_section_id = ${slot.class_section_id}
              AND known_class.deleted_at IS NULL
          ) AS class_familiarity,
          EXISTS (
            SELECT 1 FROM class_sections home_class
            WHERE home_class.id = ${slot.class_section_id}
              AND home_class.class_teacher_id = st.id
              AND home_class.deleted_at IS NULL
          ) AS is_class_teacher,
          (
            SELECT COUNT(DISTINCT day_slot.period_number)::int
            FROM timetable_slots day_slot
            WHERE day_slot.teacher_id = st.id
              AND day_slot.academic_year_id = ${context.academic_year_id}
              AND LOWER(day_slot.day_of_week::text) = ${timetableDay}
              AND day_slot.deleted_at IS NULL
          ) AS daily_load,
          (
            SELECT COUNT(*)::int
            FROM timetable_slots adjacent
            WHERE adjacent.teacher_id = st.id
              AND adjacent.academic_year_id = ${context.academic_year_id}
              AND LOWER(adjacent.day_of_week::text) = ${timetableDay}
              AND adjacent.period_number IN (${Number(slot.period_number) - 1}, ${Number(slot.period_number) + 1})
              AND adjacent.deleted_at IS NULL
          ) AS adjacent_load,
          (
            SELECT COUNT(*)::int
            FROM timetable_substitutions recent
            WHERE recent.school_id = ${schoolId}
              AND recent.substitute_teacher_id = st.id
              AND recent.cancelled_at IS NULL
              AND recent.substitution_date BETWEEN (${date}::date - INTERVAL '30 days') AND ${date}::date
          ) AS recent_substitution_count,
          EXISTS (
            SELECT 1 FROM timetable_slots conflict
            WHERE conflict.teacher_id = st.id
              AND conflict.academic_year_id = ${context.academic_year_id}
              AND LOWER(conflict.day_of_week::text) = ${timetableDay}
              AND conflict.period_number = ${slot.period_number}
              AND conflict.deleted_at IS NULL
          ) AS has_timetable_conflict,
          EXISTS (
            SELECT 1 FROM timetable_substitutions sub_conflict
            WHERE sub_conflict.substitute_teacher_id = st.id
              AND sub_conflict.substitution_date = ${date}
              AND sub_conflict.school_id = ${schoolId}
              AND sub_conflict.cancelled_at IS NULL
              AND EXISTS (
                SELECT 1 FROM timetable_slots cover_slot
                WHERE cover_slot.id = sub_conflict.timetable_slot_id
                  AND cover_slot.period_number = ${slot.period_number}
                  AND cover_slot.deleted_at IS NULL
              )
          ) AS has_substitution_conflict,
          EXISTS (
            SELECT 1 FROM leave_applications la
            JOIN users lu ON la.applicant_id = lu.id
            WHERE lu.person_id = st.person_id
              AND lu.school_id = ${schoolId}
              AND la.school_id = ${schoolId}
              AND la.status = 'approved'
              AND ${date}::date BETWEEN la.start_date AND la.end_date
          ) AS is_on_leave
        FROM staff st
        JOIN persons p ON p.id = st.person_id
        LEFT JOIN staff_statuses ss ON ss.id = st.status_id
        WHERE st.school_id = ${schoolId}
          AND st.id <> ${teacher.staff_id}
          AND st.deleted_at IS NULL
          AND (ss.id IS NULL OR ss.code = 'active')
          AND EXISTS (
            SELECT 1 FROM timetable_slots active_slot
            WHERE active_slot.teacher_id = st.id
              AND active_slot.academic_year_id = ${context.academic_year_id}
              AND active_slot.deleted_at IS NULL
          )
      `;

      // Filter hard-unavailable teachers (conflict or on leave)
      const available = candidates.filter((c) => !c.has_timetable_conflict && !c.has_substitution_conflict && !c.is_on_leave);
      const ranked = rankSubstitutionCandidates(available);
      const topCandidate = ranked.length > 0 ? ranked[0] : null;

      const isAutoSuggested = !autoAssign;
      const substituteTeacherId = autoAssign && topCandidate ? topCandidate.id : null;

      const [savedCover] = await sql`
        INSERT INTO timetable_substitutions (
          school_id,
          academic_year_id,
          timetable_slot_id,
          substitution_date,
          period_number,
          absent_teacher_id,
          substitute_teacher_id,
          suggested_teacher_id,
          created_by,
          reason,
          is_auto_suggested,
          leave_application_id,
          created_at
        )
        VALUES (
          ${schoolId},
          ${context.academic_year_id},
          ${slot.slot_id},
          ${date},
          ${slot.period_number},
          ${teacher.staff_id},
          ${substituteTeacherId},
          ${topCandidate?.id || null},
          ${null},
          ${autoAssign ? 'Automated leave substitution' : 'Leave auto-recommendation'},
          ${isAutoSuggested},
          ${leaveId},
          now()
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      `;
      if (!savedCover) continue;

      affectedSlotsCreated.push({
        substitutionId: savedCover.id,
        date,
        slotId: slot.slot_id,
        periodNumber: slot.period_number,
        className: `${slot.class_name} ${slot.section_name}`,
        subjectName: slot.subject_name,
        topCandidateName: topCandidate?.teacher_name || 'None available',
        assigned: autoAssign && substituteTeacherId != null,
      });

      // If auto-assigned, notify substitute teacher
      if (autoAssign && substituteTeacherId) {
        const [subUser] = await sql`
          SELECT u.id FROM users u
          JOIN staff st ON u.person_id = st.person_id
          WHERE st.id = ${substituteTeacherId} AND u.school_id = ${schoolId}
          LIMIT 1
        `;

        if (subUser) {
          await sendNotificationToUsers(
            [subUser.id],
            'SUBSTITUTION_ASSIGNED',
            {
              periodNumber: String(slot.period_number),
              className: `${slot.class_name} ${slot.section_name}`,
              subjectName: slot.subject_name,
              originalTeacher: teacher.display_name || teacher.staff_code,
              date,
            },
            { schoolId, deepLink: '/staff/timetable' }
          ).catch((e) => logger.warn({ err: e.message }, 'Failed to send substitution notification'));
        }
      }
    }
  }

  logger.info({
    schoolId,
    leaveId,
    affectedCount: affectedSlotsCreated.length,
    autoAssign,
  }, 'Staff leave substitution handoff processed');

  return {
    success: true,
    affectedCount: affectedSlotsCreated.length,
    slots: affectedSlotsCreated,
  };
}

/**
 * Handle cancelled or rejected staff leave: cleanly cancel unassigned/auto-suggested substitution slots.
 */
export async function handleStaffLeaveCancelled({ schoolId, leaveId }) {
  if (!schoolId || !leaveId) return { success: false };

  const cancelled = await sql`
    UPDATE timetable_substitutions
    SET cancelled_at = now()
    WHERE school_id = ${schoolId}
      AND leave_application_id = ${leaveId}
      AND (is_auto_suggested = true OR substitution_date >= CURRENT_DATE)
      AND cancelled_at IS NULL
    RETURNING id
  `;

  logger.info({ schoolId, leaveId, count: cancelled.length }, 'Cancelled auto-suggested substitution slots for leave');
  return { success: true, cancelledCount: cancelled.length };
}
