import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole } from '../middleware/requireRole.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';

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

/**
 * Admin portfolio: school-wide authority over every active enrollment in the
 * current academic year. Optional class_section_id narrows the roster.
 */
router.get(
  '/',
  requireAuth,
  requireRole('admin', 'principal'),
  asyncHandler(async (req, res) => {
    const calendar = await schoolCalendarContext(sql, req.schoolId);
    if (!calendar) {
      return res.status(404).json({ error: 'No active academic year found' });
    }

    const requestedClassSectionId = typeof req.query.class_section_id === 'string'
      ? req.query.class_section_id.trim()
      : '';
    if (requestedClassSectionId && !UUID_RE.test(requestedClassSectionId)) {
      return res.status(400).json({ error: 'Invalid class_section_id' });
    }

    const classSections = await sql`
      SELECT
        cs.id,
        c.name AS class_name,
        section.name AS section_name,
        COUNT(enrollment.id)::int AS student_count
      FROM class_sections cs
      JOIN classes c ON c.id = cs.class_id
      JOIN sections section ON section.id = cs.section_id
      LEFT JOIN student_enrollments enrollment
        ON enrollment.class_section_id = cs.id
       AND enrollment.school_id = ${req.schoolId}
       AND enrollment.academic_year_id = ${calendar.academicYearId}
       AND enrollment.status = 'active'
       AND enrollment.deleted_at IS NULL
       AND ${calendar.today}::date BETWEEN enrollment.start_date
         AND COALESCE(enrollment.end_date, '9999-12-31'::date)
       AND EXISTS (
         SELECT 1
         FROM students active_student
         WHERE active_student.id = enrollment.student_id
           AND active_student.school_id = ${req.schoolId}
           AND active_student.deleted_at IS NULL
           AND active_student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
       )
      WHERE cs.school_id = ${req.schoolId}
        AND cs.academic_year_id = ${calendar.academicYearId}
        AND cs.deleted_at IS NULL
      GROUP BY cs.id, c.name, section.name, c.sort_order
      ORDER BY c.sort_order NULLS LAST, c.name, section.name
    `;

    let classSection = null;
    if (requestedClassSectionId) {
      classSection = classSections.find((row) => String(row.id) === requestedClassSectionId) || null;
      if (!classSection) {
        return res.status(404).json({ error: 'Class section not found' });
      }
    }

    const students = await sql`
      SELECT
        student.id, student.admission_no, enrollment.roll_number,
        person.display_name, person.photo_url,
        to_char(person.dob, 'YYYY-MM-DD') AS dob,
        gender.name AS gender,
        class.name AS class_name,
        section.name AS section_name,
        enrollment.class_section_id,
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
       AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
      JOIN persons person ON person.id = student.person_id
      JOIN class_sections class_section ON class_section.id = enrollment.class_section_id
      JOIN classes class ON class.id = class_section.class_id
      JOIN sections section ON section.id = class_section.section_id
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
        AND enrollment.status = 'active'
        AND enrollment.deleted_at IS NULL
        AND ${calendar.today}::date BETWEEN enrollment.start_date
          AND COALESCE(enrollment.end_date, '9999-12-31'::date)
        AND (
          ${requestedClassSectionId || null}::uuid IS NULL
          OR enrollment.class_section_id = ${requestedClassSectionId || null}::uuid
        )
      ORDER BY class.sort_order NULLS LAST, class.name, section.name,
        enrollment.roll_number ASC NULLS LAST, person.display_name
    `;

    return sendSuccess(res, req.schoolId, {
      date: calendar.today,
      academic_year: calendar.academicYearCode,
      class_section: classSection
        ? {
            id: classSection.id,
            class_name: classSection.class_name,
            section_name: classSection.section_name,
            source: 'admin',
          }
        : null,
      class_sections: classSections.map((row) => ({
        id: row.id,
        class_name: row.class_name,
        section_name: row.section_name,
        student_count: row.student_count,
      })),
      students,
    });
  })
);

router.get(
  '/:studentId',
  requireAuth,
  requireRole('admin', 'principal'),
  asyncHandler(async (req, res) => {
    const studentId = String(req.params.studentId || '');
    if (!UUID_RE.test(studentId)) {
      return res.status(400).json({ error: 'Invalid student id' });
    }

    const calendar = await schoolCalendarContext(sql, req.schoolId);
    if (!calendar) {
      return res.status(404).json({ error: 'No active academic year found' });
    }

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
        class_section.id AS class_section_id,
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
       AND student.status_id = ${ACTIVE_STUDENT_STATUS_ID}
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
        AND enrollment.status = 'active'
        AND enrollment.deleted_at IS NULL
        AND ${calendar.today}::date BETWEEN enrollment.start_date
          AND COALESCE(enrollment.end_date, '9999-12-31'::date)
      LIMIT 1
    `;
    if (!student) {
      return res.status(404).json({ error: 'Student not found in the active academic year' });
    }

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
      class_section: {
        id: student.class_section_id,
        class_name: student.class_name,
        section_name: student.section_name,
        source: 'admin',
      },
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
  })
);

export default router;
