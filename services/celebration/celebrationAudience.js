import sql from '../../db.js';

/**
 * Attaches staff/student/parent class context needed by celebration visibility
 * policy. Never trusts client-supplied audience fields as the source of truth.
 *
 * @param {number} schoolId
 * @param {object|null} user
 * @returns {Promise<object|null>}
 */
export async function enrichCelebrationViewer(schoolId, user) {
  if (!user || !schoolId) return user || null;

  const personId = user.person_id || user.personId || null;
  const merged = {
    ...user,
    schoolId: user.schoolId || user.school_id || schoolId,
    school_id: user.school_id || user.schoolId || schoolId,
  };

  const existingStudentIds = [
    merged.student_id,
    merged.studentId,
    ...(Array.isArray(merged.studentIds) ? merged.studentIds : []),
  ].filter(Boolean).map(String);

  const classSectionIds = new Set(
    [merged.class_section_id, merged.classSectionId, ...(merged.classSectionIds || [])]
      .filter(Boolean)
      .map(String),
  );
  const classIds = new Set(
    [merged.class_id, merged.classId, ...(merged.classIds || [])].filter(Boolean).map(String),
  );
  const sectionIds = new Set(
    [merged.section_id, merged.sectionId, ...(merged.sectionIds || [])].filter(Boolean).map(String),
  );

  if (!personId) {
    merged.studentIds = [...new Set(existingStudentIds)];
    merged.classSectionIds = [...classSectionIds];
    merged.classIds = [...classIds];
    merged.sectionIds = [...sectionIds];
    return merged;
  }

  try {
    const [staffRow, studentRow, linked] = await Promise.all([
      sql`
        SELECT id
        FROM staff
        WHERE school_id = ${schoolId}
          AND person_id = ${personId}
          AND deleted_at IS NULL
        LIMIT 1
      `.then((rows) => rows[0] || null),
      sql`
        SELECT id
        FROM students
        WHERE school_id = ${schoolId}
          AND person_id = ${personId}
          AND deleted_at IS NULL
        LIMIT 1
      `.then((rows) => rows[0] || null),
      sql`
        SELECT
          s.id AS student_id,
          se.class_section_id,
          cs.class_id,
          cs.section_id
        FROM parents par
        JOIN student_parents sp
          ON sp.parent_id = par.id
          AND sp.school_id = ${schoolId}
          AND sp.deleted_at IS NULL
        JOIN students s
          ON s.id = sp.student_id
          AND s.school_id = ${schoolId}
          AND s.deleted_at IS NULL
        LEFT JOIN student_enrollments se
          ON se.student_id = s.id
          AND se.school_id = ${schoolId}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
        LEFT JOIN class_sections cs ON cs.id = se.class_section_id
        WHERE par.person_id = ${personId}
          AND par.school_id = ${schoolId}
          AND par.deleted_at IS NULL
      `,
    ]);

    if (staffRow?.id) {
      merged.staff_id = staffRow.id;
      merged.staffId = staffRow.id;
    }
    if (studentRow?.id) {
      merged.student_id = studentRow.id;
      merged.studentId = studentRow.id;
      existingStudentIds.push(String(studentRow.id));
    }

    for (const row of linked) {
      if (row.student_id) existingStudentIds.push(String(row.student_id));
      if (row.class_section_id) classSectionIds.add(String(row.class_section_id));
      if (row.class_id) classIds.add(String(row.class_id));
      if (row.section_id) sectionIds.add(String(row.section_id));
    }
  } catch (error) {
    // Audience enrichment failure must not block banners; policy will fail closed.
  }

  merged.studentIds = [...new Set(existingStudentIds)];
  merged.classSectionIds = [...classSectionIds];
  merged.classIds = [...classIds];
  merged.sectionIds = [...sectionIds];
  if (!merged.class_section_id && merged.classSectionIds[0]) {
    merged.class_section_id = merged.classSectionIds[0];
    merged.classSectionId = merged.classSectionIds[0];
  }
  return merged;
}
