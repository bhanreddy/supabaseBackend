import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function weekdayForDate(date) {
  return DAYS[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
}

async function schoolCalendarContext(exec, schoolId) {
  const [row] = await exec`
    SELECT
      to_char(
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
      ) AS today,
      school.timetable_mode
    FROM schools school
    WHERE school.id = ${schoolId}
  `;
  if (!row) return null;

  const [year] = await exec`
    SELECT id, code
    FROM academic_years
    WHERE school_id = ${schoolId}
      AND ${row.today}::date BETWEEN start_date AND end_date
    ORDER BY start_date DESC
    LIMIT 1
  `;
  if (!year) return null;

  return {
    today: row.today,
    academicYearId: year.id,
    academicYearCode: year.code,
    timetableDay: row.timetable_mode === 'per_day' ? weekdayForDate(row.today) : 'monday',
  };
}

async function resolveStaff(req, res) {
  const requestedStaffId = typeof req.query.staff_id === 'string'
    ? req.query.staff_id.trim()
    : '';

  if (requestedStaffId) {
    if (!UUID_RE.test(requestedStaffId)) {
      res.status(400).json({ error: 'Invalid staff_id' });
      return null;
    }
    if (
      req.staffPortalAccess &&
      String(req.staffPortalAccess.target_staff_id) !== requestedStaffId
    ) {
      res.status(403).json({ error: 'Staff portal target mismatch' });
      return null;
    }
    const isAdmin = req.user.roles.includes('admin');
    if (!isAdmin && !req.staffPortalAccess) {
      res.status(403).json({ error: 'Forbidden', code: 'FORBIDDEN' });
      return null;
    }
    const [staff] = await sql`
      SELECT id, person_id
      FROM staff
      WHERE id = ${requestedStaffId}
        AND school_id = ${req.schoolId}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (!staff) res.status(404).json({ error: 'Staff profile not found' });
    return staff || null;
  }

  const [staff] = await sql`
    SELECT id, person_id
    FROM staff
    WHERE person_id = ${req.user.person_id}
      AND school_id = ${req.schoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!staff) res.status(404).json({ error: 'Staff profile not found' });
  return staff || null;
}

/**
 * The portfolio roster is deliberately server-resolved. It is the teacher's
 * exact-date period-1 cover, permanent period-1 class, or homeroom class (in
 * that priority order). Clients never supply a class id.
 */
async function resolveFirstClass(exec, { schoolId, staffId, calendar }) {
  const [classSection] = await exec`
    WITH eligible_class AS (
      SELECT
        cs.id, c.name AS class_name, section.name AS section_name,
        1 AS priority, 'substitution'::text AS source
      FROM timetable_substitutions cover
      JOIN timetable_slots slot ON slot.id = cover.timetable_slot_id
      JOIN class_sections cs ON cs.id = slot.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections section ON section.id = cs.section_id
      WHERE cover.school_id = ${schoolId}
        AND cover.academic_year_id = ${calendar.academicYearId}
        AND cover.substitution_date = ${calendar.today}
        AND cover.substitute_teacher_id = ${staffId}
        AND cover.period_number = 1
        AND cover.cancelled_at IS NULL
        AND cs.school_id = ${schoolId}
        AND cs.deleted_at IS NULL

      UNION ALL

      SELECT
        cs.id, c.name AS class_name, section.name AS section_name,
        2 AS priority, 'period_1'::text AS source
      FROM timetable_slots slot
      JOIN class_sections cs ON cs.id = slot.class_section_id
      JOIN classes c ON c.id = cs.class_id
      JOIN sections section ON section.id = cs.section_id
      WHERE slot.school_id = ${schoolId}
        AND slot.academic_year_id = ${calendar.academicYearId}
        AND slot.teacher_id = ${staffId}
        AND slot.period_number = 1
        AND LOWER(slot.day_of_week::text) = ${calendar.timetableDay}
        AND slot.deleted_at IS NULL
        AND cs.school_id = ${schoolId}
        AND cs.deleted_at IS NULL

      UNION ALL

      SELECT
        cs.id, c.name AS class_name, section.name AS section_name,
        3 AS priority, 'class_teacher'::text AS source
      FROM class_sections cs
      JOIN classes c ON c.id = cs.class_id
      JOIN sections section ON section.id = cs.section_id
      WHERE cs.school_id = ${schoolId}
        AND cs.academic_year_id = ${calendar.academicYearId}
        AND cs.class_teacher_id = ${staffId}
        AND cs.deleted_at IS NULL
    )
    SELECT id, class_name, section_name, source
    FROM eligible_class
    ORDER BY priority, id
    LIMIT 1
  `;
  return classSection || null;
}

async function requestContext(req, res) {
  const [staff, calendar] = await Promise.all([
    resolveStaff(req, res),
    schoolCalendarContext(sql, req.schoolId),
  ]);
  if (!staff) return null;
  if (!calendar) {
    res.status(404).json({ error: 'No active academic year found' });
    return null;
  }

  const classSection = await resolveFirstClass(sql, {
    schoolId: req.schoolId,
    staffId: staff.id,
    calendar,
  });
  return { staff, calendar, classSection };
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const context = await requestContext(req, res);
  if (!context) return;
  const { calendar, classSection } = context;

  if (!classSection) {
    return sendSuccess(res, req.schoolId, {
      date: calendar.today,
      academic_year: calendar.academicYearCode,
      class_section: null,
      students: [],
    });
  }

  const students = await sql`
    SELECT
      student.id, student.admission_no, enrollment.roll_number,
      person.display_name, person.photo_url,
      to_char(person.dob, 'YYYY-MM-DD') AS dob,
      gender.name AS gender,
      COALESCE(attendance.total_days, 0)::int AS attendance_total,
      COALESCE(attendance.present_equivalent, 0)::float AS attendance_present,
      COALESCE(attendance.percentage, 0)::float AS attendance_percentage,
      COALESCE(result.exam_count, 0)::int AS result_exam_count,
      COALESCE(result.percentage, 0)::float AS result_percentage,
      COALESCE(complaint.total, 0)::int AS complaint_count,
      COALESCE(visit.total, 0)::int AS parent_visit_count
    FROM student_enrollments enrollment
    JOIN students student
      ON student.id = enrollment.student_id
     AND student.school_id = ${req.schoolId}
     AND student.deleted_at IS NULL
    JOIN persons person ON person.id = student.person_id
    LEFT JOIN genders gender ON gender.id = person.gender_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int AS total_days,
        SUM(
          CASE
            WHEN daily.status IN ('present', 'late') THEN 1
            WHEN daily.status = 'half_day' THEN 0.5
            ELSE 0
          END
        )::float AS present_equivalent,
        ROUND(
          100 * SUM(
            CASE
              WHEN daily.status IN ('present', 'late') THEN 1
              WHEN daily.status = 'half_day' THEN 0.5
              ELSE 0
            END
          )::numeric / NULLIF(COUNT(*), 0),
          1
        ) AS percentage
      FROM daily_attendance daily
      WHERE daily.student_enrollment_id = enrollment.id
        AND daily.school_id = ${req.schoolId}
        AND daily.deleted_at IS NULL
    ) attendance ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT exam.id)::int AS exam_count,
        ROUND(
          100 * SUM(CASE WHEN mark.is_absent THEN 0 ELSE mark.marks_obtained END)::numeric
          / NULLIF(SUM(exam_subject.max_marks), 0),
          1
        ) AS percentage
      FROM marks mark
      JOIN exam_subjects exam_subject
        ON exam_subject.id = mark.exam_subject_id
       AND exam_subject.school_id = ${req.schoolId}
       AND exam_subject.deleted_at IS NULL
      JOIN exams exam
        ON exam.id = exam_subject.exam_id
       AND exam.school_id = ${req.schoolId}
       AND exam.academic_year_id = ${calendar.academicYearId}
       AND exam.deleted_at IS NULL
       AND exam.status != 'cancelled'
       AND exam.results_published = TRUE
      WHERE mark.student_enrollment_id = enrollment.id
        AND mark.school_id = ${req.schoolId}
    ) result ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS total
      FROM complaints
      WHERE school_id = ${req.schoolId}
        AND raised_for_student_id = student.id
        AND deleted_at IS NULL
    ) complaint ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS total
      FROM parent_visits
      WHERE school_id = ${req.schoolId}
        AND student_id = student.id
        AND deleted_at IS NULL
    ) visit ON true
    WHERE enrollment.school_id = ${req.schoolId}
      AND enrollment.academic_year_id = ${calendar.academicYearId}
      AND enrollment.class_section_id = ${classSection.id}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
      AND ${calendar.today}::date BETWEEN enrollment.start_date
        AND COALESCE(enrollment.end_date, '9999-12-31'::date)
    ORDER BY enrollment.roll_number ASC NULLS LAST, person.display_name
  `;

  return sendSuccess(res, req.schoolId, {
    date: calendar.today,
    academic_year: calendar.academicYearCode,
    class_section: classSection,
    students,
  });
}));

router.get('/:studentId', requireAuth, asyncHandler(async (req, res) => {
  const studentId = String(req.params.studentId || '');
  if (!UUID_RE.test(studentId)) {
    return res.status(400).json({ error: 'Invalid student id' });
  }

  const context = await requestContext(req, res);
  if (!context) return;
  const { calendar, classSection } = context;
  if (!classSection) return res.status(404).json({ error: 'No first class is assigned' });

  const [student] = await sql`
    SELECT
      student.id, student.admission_no, student.pen_number, student.apar_number,
      to_char(student.admission_date, 'YYYY-MM-DD') AS admission_date,
      student.village,
      person.display_name, person.first_name, person.middle_name, person.last_name,
      person.photo_url, to_char(person.dob, 'YYYY-MM-DD') AS dob,
      gender.name AS gender, country.name AS nationality,
      category.name AS category, religion.name AS religion, blood.name AS blood_group,
      status.code AS student_status,
      enrollment.id AS enrollment_id, enrollment.roll_number,
      class.name AS class_name, section.name AS section_name,
      year.code AS academic_year,
      (
        SELECT contact_value FROM person_contacts
        WHERE person_id = person.id AND contact_type = 'phone'
          AND deleted_at IS NULL
        ORDER BY is_primary DESC, created_at
        LIMIT 1
      ) AS phone,
      (
        SELECT contact_value FROM person_contacts
        WHERE person_id = person.id AND contact_type = 'email'
          AND deleted_at IS NULL
        ORDER BY is_primary DESC, created_at
        LIMIT 1
      ) AS email,
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'id', parent.id,
              'name', parent_person.display_name,
              'relationship', relationship.name,
              'occupation', parent.occupation,
              'phone', (
                SELECT contact_value FROM person_contacts
                WHERE person_id = parent_person.id AND contact_type = 'phone'
                  AND deleted_at IS NULL
                ORDER BY is_primary DESC, created_at
                LIMIT 1
              ),
              'email', (
                SELECT contact_value FROM person_contacts
                WHERE person_id = parent_person.id AND contact_type = 'email'
                  AND deleted_at IS NULL
                ORDER BY is_primary DESC, created_at
                LIMIT 1
              ),
              'is_primary', link.is_primary_contact,
              'is_guardian', link.is_legal_guardian
            )
            ORDER BY link.is_primary_contact DESC, parent_person.display_name
          )
          FROM student_parents link
          JOIN parents parent
            ON parent.id = link.parent_id
           AND parent.school_id = ${req.schoolId}
           AND parent.deleted_at IS NULL
          JOIN persons parent_person ON parent_person.id = parent.person_id
          LEFT JOIN relationship_types relationship ON relationship.id = link.relationship_id
          WHERE link.student_id = student.id
            AND link.school_id = ${req.schoolId}
            AND link.deleted_at IS NULL
        ),
        '[]'::json
      ) AS parents
    FROM student_enrollments enrollment
    JOIN students student
      ON student.id = enrollment.student_id
     AND student.school_id = ${req.schoolId}
     AND student.deleted_at IS NULL
    JOIN persons person ON person.id = student.person_id
    JOIN class_sections class_section ON class_section.id = enrollment.class_section_id
    JOIN classes class ON class.id = class_section.class_id
    JOIN sections section ON section.id = class_section.section_id
    JOIN academic_years year ON year.id = enrollment.academic_year_id
    LEFT JOIN genders gender ON gender.id = person.gender_id
    LEFT JOIN countries country ON country.code = person.nationality_code
    LEFT JOIN student_categories category ON category.id = student.category_id
    LEFT JOIN religions religion ON religion.id = student.religion_id
    LEFT JOIN blood_groups blood ON blood.id = student.blood_group_id
    LEFT JOIN student_statuses status ON status.id = student.status_id
    WHERE student.id = ${studentId}
      AND enrollment.school_id = ${req.schoolId}
      AND enrollment.academic_year_id = ${calendar.academicYearId}
      AND enrollment.class_section_id = ${classSection.id}
      AND enrollment.status = 'active'
      AND enrollment.deleted_at IS NULL
      AND ${calendar.today}::date BETWEEN enrollment.start_date
        AND COALESCE(enrollment.end_date, '9999-12-31'::date)
    LIMIT 1
  `;
  if (!student) return res.status(404).json({ error: 'Student is not in your first class' });

  const [[attendance], [counts], results, [school]] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS total_days,
        COUNT(*) FILTER (WHERE daily.status = 'present')::int AS present,
        COUNT(*) FILTER (WHERE daily.status = 'late')::int AS late,
        COUNT(*) FILTER (WHERE daily.status = 'absent')::int AS absent,
        COUNT(*) FILTER (WHERE daily.status = 'half_day')::int AS half_day,
        ROUND(
          100 * SUM(
            CASE
              WHEN daily.status IN ('present', 'late') THEN 1
              WHEN daily.status = 'half_day' THEN 0.5
              ELSE 0
            END
          )::numeric / NULLIF(COUNT(*), 0),
          1
        )::float AS percentage
      FROM daily_attendance daily
      WHERE daily.student_enrollment_id = ${student.enrollment_id}
        AND daily.school_id = ${req.schoolId}
        AND daily.deleted_at IS NULL
    `,
    sql`
      SELECT
        (
          SELECT COUNT(*)::int FROM complaints
          WHERE school_id = ${req.schoolId}
            AND raised_for_student_id = ${studentId}
            AND deleted_at IS NULL
        ) AS complaints,
        (
          SELECT COUNT(*)::int FROM parent_visits
          WHERE school_id = ${req.schoolId}
            AND student_id = ${studentId}
            AND deleted_at IS NULL
        ) AS parent_visits
    `,
    sql`
      SELECT
        exam.id AS exam_id, exam.name AS exam_name, exam.exam_type,
        to_char(exam.start_date, 'YYYY-MM-DD') AS exam_date,
        COUNT(*)::int AS subjects_count,
        SUM(CASE WHEN mark.is_absent THEN 0 ELSE mark.marks_obtained END)::float AS obtained,
        SUM(exam_subject.max_marks)::float AS maximum,
        ROUND(
          100 * SUM(CASE WHEN mark.is_absent THEN 0 ELSE mark.marks_obtained END)::numeric
          / NULLIF(SUM(exam_subject.max_marks), 0),
          1
        )::float AS percentage
      FROM marks mark
      JOIN exam_subjects exam_subject
        ON exam_subject.id = mark.exam_subject_id
       AND exam_subject.school_id = ${req.schoolId}
       AND exam_subject.deleted_at IS NULL
      JOIN exams exam
        ON exam.id = exam_subject.exam_id
       AND exam.school_id = ${req.schoolId}
       AND exam.academic_year_id = ${calendar.academicYearId}
       AND exam.deleted_at IS NULL
       AND exam.status != 'cancelled'
       AND exam.results_published = TRUE
      WHERE mark.student_enrollment_id = ${student.enrollment_id}
        AND mark.school_id = ${req.schoolId}
      GROUP BY exam.id, exam.name, exam.exam_type, exam.start_date
      ORDER BY exam.start_date DESC NULLS LAST, exam.name
    `,
    sql`
      SELECT name, address, logo_url
      FROM schools
      WHERE id = ${req.schoolId}
    `,
  ]);

  const resultMaximum = results.reduce((total, result) => total + Number(result.maximum || 0), 0);
  const resultObtained = results.reduce((total, result) => total + Number(result.obtained || 0), 0);
  const resultPercentage = resultMaximum > 0
    ? Math.round((resultObtained / resultMaximum) * 1000) / 10
    : 0;

  return sendSuccess(res, req.schoolId, {
    date: calendar.today,
    school,
    class_section: classSection,
    student,
    attendance: {
      total_days: Number(attendance?.total_days) || 0,
      present: Number(attendance?.present) || 0,
      late: Number(attendance?.late) || 0,
      absent: Number(attendance?.absent) || 0,
      half_day: Number(attendance?.half_day) || 0,
      percentage: Number(attendance?.percentage) || 0,
    },
    results: {
      percentage: resultPercentage,
      exam_count: results.length,
      preview: results.slice(0, 5),
    },
    counts: {
      complaints: Number(counts?.complaints) || 0,
      parent_visits: Number(counts?.parent_visits) || 0,
    },
  });
}));

export default router;
