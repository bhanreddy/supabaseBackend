import express from 'express';
import sql from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';
import { RollNumberValidationError, validateRollAssignments } from '../utils/rollNumbers.js';

const router = express.Router();

async function resolveClassTeacher(exec, req, { lock = false } = {}) {
  const [staff] = await exec`
    SELECT id
    FROM staff
    WHERE school_id = ${req.schoolId}
      AND deleted_at IS NULL
      AND (
        id = ${req.user?.staff_id || null}
        OR person_id = ${req.user?.person_id || null}
      )
    ORDER BY (id = ${req.user?.staff_id || null}) DESC
    LIMIT 1
  `;
  if (!staff) return { staff: null, classSection: null };

  const rows = await exec`
    SELECT
      cs.id,
      cs.academic_year_id,
      cs.manual_roll_numbers,
      cs.roll_number_start,
      c.name AS class_name,
      sec.name AS section_name,
      ay.code AS academic_year
    FROM class_sections cs
    JOIN classes c ON c.id = cs.class_id AND c.school_id = cs.school_id
    JOIN sections sec ON sec.id = cs.section_id AND sec.school_id = cs.school_id
    JOIN academic_years ay ON ay.id = cs.academic_year_id AND ay.school_id = cs.school_id
    WHERE cs.school_id = ${req.schoolId}
      AND cs.class_teacher_id = ${staff.id}
      AND CURRENT_DATE BETWEEN ay.start_date AND ay.end_date
    ORDER BY c.sort_order NULLS LAST, c.name, sec.name
    LIMIT 1
    ${lock ? sql`FOR UPDATE OF cs` : sql``}
  `;

  return { staff, classSection: rows[0] || null };
}

async function loadRoster(exec, req, classSection, { lock = false } = {}) {
  return exec`
    SELECT
      se.id AS enrollment_id,
      s.id AS student_id,
      s.admission_no,
      se.roll_number,
      p.display_name AS student_name,
      p.photo_url
    FROM student_enrollments se
    JOIN students s ON s.id = se.student_id
      AND s.school_id = se.school_id
      AND s.deleted_at IS NULL
      AND s.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    JOIN persons p ON p.id = s.person_id AND p.school_id = s.school_id
    WHERE se.school_id = ${req.schoolId}
      AND se.class_section_id = ${classSection.id}
      AND se.academic_year_id = ${classSection.academic_year_id}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND CURRENT_DATE BETWEEN se.start_date AND COALESCE(se.end_date, '9999-12-31'::date)
    ORDER BY se.roll_number ASC NULLS LAST, LOWER(p.display_name), s.admission_no
    ${lock ? sql`FOR UPDATE OF se` : sql``}
  `;
}

function noClassTeacherResponse(res) {
  return res.status(404).json({
    error: 'No class is assigned to you as class teacher for the current academic year.',
    code: 'CLASS_TEACHER_ASSIGNMENT_REQUIRED',
  });
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { classSection } = await resolveClassTeacher(sql, req);
  if (!classSection) return noClassTeacherResponse(res);

  const students = await loadRoster(sql, req, classSection);
  return sendSuccess(res, req.schoolId, {
    class_section: classSection,
    students,
  });
}));

router.put('/', requireAuth, asyncHandler(async (req, res) => {
  try {
    const saved = await sql.begin(async (tx) => {
      const { classSection } = await resolveClassTeacher(tx, req, { lock: true });
      if (!classSection) return null;

      await tx`SELECT pg_advisory_xact_lock(hashtext(${classSection.id}::text), hashtext(${classSection.academic_year_id}::text))`;
      const roster = await loadRoster(tx, req, classSection, { lock: true });
      if (roster.length === 0) {
        throw new RollNumberValidationError('This class has no active students.', 'EMPTY_CLASS_ROSTER');
      }

      const validated = validateRollAssignments(
        req.body?.assignments,
        roster.map((student) => student.enrollment_id),
      );

      await tx`
        UPDATE class_sections
        SET manual_roll_numbers = true,
            roll_number_start = ${validated.start}
        WHERE id = ${classSection.id}
          AND school_id = ${req.schoolId}
      `;

      // Clear the class range before assigning it so swaps cannot violate the
      // active-enrollment unique index halfway through the transaction.
      await tx`
        UPDATE student_enrollments
        SET roll_number = NULL
        WHERE class_section_id = ${classSection.id}
          AND academic_year_id = ${classSection.academic_year_id}
          AND school_id = ${req.schoolId}
          AND status = 'active'
          AND deleted_at IS NULL
      `;

      for (const assignment of validated.assignments) {
        await tx`
          UPDATE student_enrollments
          SET roll_number = ${assignment.roll_number}
          WHERE id = ${assignment.enrollment_id}
            AND class_section_id = ${classSection.id}
            AND academic_year_id = ${classSection.academic_year_id}
            AND school_id = ${req.schoolId}
            AND status = 'active'
            AND deleted_at IS NULL
        `;
      }

      return {
        class_section: {
          ...classSection,
          manual_roll_numbers: true,
          roll_number_start: validated.start,
        },
        students: await loadRoster(tx, req, classSection),
        range: { start: validated.start, end: validated.end },
      };
    });

    if (!saved) return noClassTeacherResponse(res);
    return sendSuccess(res, req.schoolId, {
      ...saved,
      message: `Roll numbers ${saved.range.start}-${saved.range.end} saved successfully.`,
    });
  } catch (error) {
    if (error instanceof RollNumberValidationError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}));

export default router;
