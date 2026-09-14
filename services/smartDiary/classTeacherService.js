import sql from '../../db.js';
import { isUuid } from './validation.js';

export async function loadStaffIdForUser(schoolId, userId) {
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

export async function loadClassTeacherSections(schoolId, staffId) {
  if (!staffId) return [];
  return sql`
    SELECT
      cs.id AS class_section_id,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      ay.name AS academic_year
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN academic_years ay ON cs.academic_year_id = ay.id
    WHERE cs.school_id = ${schoolId}
      AND cs.class_teacher_id = ${staffId}
      AND cs.deleted_at IS NULL
      AND CURRENT_DATE BETWEEN ay.start_date AND ay.end_date
    ORDER BY c.sort_order NULLS LAST, c.name, sec.name
  `;
}

export async function loadAdminClassSections(schoolId) {
  return sql`
    SELECT
      cs.id AS class_section_id,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    JOIN academic_years ay ON cs.academic_year_id = ay.id
    WHERE cs.school_id = ${schoolId}
      AND cs.deleted_at IS NULL
      AND CURRENT_DATE BETWEEN ay.start_date AND ay.end_date
    ORDER BY c.sort_order NULLS LAST, c.name, sec.name
    LIMIT 80
  `;
}

export async function loadClassSubjects(schoolId, classSectionId) {
  if (!isUuid(classSectionId)) return [];
  return sql`
    SELECT DISTINCT s.id, s.name
    FROM subjects s
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM class_subjects csub
          WHERE csub.class_section_id = ${classSectionId}
            AND csub.subject_id = s.id
            AND csub.school_id = ${schoolId}
            AND csub.deleted_at IS NULL
        )
        OR EXISTS (
          SELECT 1 FROM timetable_slots ts
          WHERE ts.class_section_id = ${classSectionId}
            AND ts.subject_id = s.id
            AND ts.school_id = ${schoolId}
            AND ts.deleted_at IS NULL
        )
      )
    ORDER BY s.name
  `;
}

export function isPrivilegedDiaryRole(roles = []) {
  return roles.includes('admin') || roles.includes('principal');
}

export async function assertCanUploadClassDiary({
  schoolId,
  userId,
  roles = [],
  classSectionId,
  staffId = null,
}) {
  if (!isUuid(classSectionId)) {
    return { ok: false, status: 400, error: 'Choose a class.' };
  }
  const [section] = await sql`
    SELECT cs.id, c.name AS class_name, sec.name AS section_name, cs.class_teacher_id
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections sec ON cs.section_id = sec.id
    WHERE cs.id = ${classSectionId}
      AND cs.school_id = ${schoolId}
      AND cs.deleted_at IS NULL
  `;
  if (!section) return { ok: false, status: 404, error: 'Class not found.' };

  if (isPrivilegedDiaryRole(roles)) {
    return { ok: true, section, privileged: true };
  }

  const resolvedStaffId = staffId || await loadStaffIdForUser(schoolId, userId);
  if (!resolvedStaffId || resolvedStaffId !== section.class_teacher_id) {
    return { ok: false, status: 403, error: 'Only the class teacher can upload the full class diary.' };
  }
  return { ok: true, section, privileged: false };
}
