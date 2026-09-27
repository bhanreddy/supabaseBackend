import sql from '../../db.js';
import { isUuid } from './validation.js';

/** Staff keep their existing diary permission; family readers need a live enrollment. */
export async function canReadDiaryClass({ schoolId, personId, classSectionId, roles = [], db = sql }) {
  const familyReader = roles.includes('student') || roles.includes('parent');
  const staffReader = roles.some((role) => ['admin', 'principal', 'staff', 'teacher'].includes(role));
  if (!familyReader || staffReader) return true;
  if (!personId || !isUuid(classSectionId)) return false;

  const [row] = await db`
    SELECT EXISTS (
      SELECT 1
      FROM student_enrollments se
      JOIN students s ON s.id = se.student_id
        AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
      JOIN class_sections cs ON cs.id = se.class_section_id
        AND cs.school_id = ${schoolId} AND cs.deleted_at IS NULL
      WHERE se.class_section_id = ${classSectionId}
        AND se.school_id = ${schoolId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
        AND se.start_date <= CURRENT_DATE
        AND (se.end_date IS NULL OR se.end_date >= CURRENT_DATE)
        AND (
          s.person_id = ${personId}
          OR EXISTS (
            SELECT 1
            FROM student_parents sp
            JOIN parents p ON p.id = sp.parent_id
              AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
            WHERE sp.student_id = s.id
              AND sp.school_id = ${schoolId}
              AND sp.deleted_at IS NULL
              AND (sp.valid_from IS NULL OR sp.valid_from <= CURRENT_DATE)
              AND (sp.valid_to IS NULL OR sp.valid_to >= CURRENT_DATE)
              AND p.person_id = ${personId}
          )
        )
    ) AS allowed
  `;
  return row?.allowed === true;
}
