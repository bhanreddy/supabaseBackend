import sql from '../db.js';
import logger from '../utils/logger.js';

export const DEFAULT_REQUIRED_DOCUMENTS = [
  { document_type: 'BIRTH_CERTIFICATE', display_name: 'Birth Certificate', is_required: true },
  { document_type: 'TRANSFER_CERTIFICATE', display_name: 'Transfer Certificate (TC)', is_required: true },
  { document_type: 'PREVIOUS_MARKSHEET', display_name: 'Previous Marksheet / Report Card', is_required: true },
  { document_type: 'PASSPORT_PHOTO', display_name: 'Passport Size Photographs', is_required: true },
];

/**
 * Retrieve configured or default required document types for a school
 */
export async function getRequiredDocuments(schoolId) {
  const custom = await sql`
    SELECT document_type, display_name, is_required
    FROM school_document_requirements
    WHERE school_id = ${schoolId}
    ORDER BY created_at ASC
  `;

  if (custom && custom.length > 0) {
    return custom.filter((d) => d.is_required);
  }
  return DEFAULT_REQUIRED_DOCUMENTS;
}

/**
 * Get missing documents list for active students in a school
 */
export async function getMissingDocumentsList(schoolId, { classId = null, sectionId = null, search = '' } = {}) {
  const requiredDocs = await getRequiredDocuments(schoolId);
  const requiredMap = new Map(requiredDocs.map((d) => [d.document_type, d.display_name]));
  const requiredTypes = Array.from(requiredMap.keys());

  // Fetch active students with enrollment and parent info
  const students = await sql`
    SELECT
      s.id AS student_id,
      s.admission_no,
      p.display_name AS student_name,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      -- Primary guardian contact
      (
        SELECT json_build_object(
          'parent_name', parent_p.display_name,
          'phone', pc.contact_value
        )
        FROM student_parents sp
        JOIN parents pr ON sp.parent_id = pr.id AND pr.school_id = ${schoolId} AND pr.deleted_at IS NULL
        JOIN persons parent_p ON pr.person_id = parent_p.id AND parent_p.school_id = ${schoolId} AND parent_p.deleted_at IS NULL
        LEFT JOIN person_contacts pc ON parent_p.id = pc.person_id AND pc.contact_type = 'phone' AND pc.is_primary = true AND pc.school_id = ${schoolId} AND pc.deleted_at IS NULL
        WHERE sp.student_id = s.id AND sp.school_id = ${schoolId} AND sp.deleted_at IS NULL
        LIMIT 1
      ) AS guardian_contact
    FROM students s
    JOIN persons p ON p.id = s.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    LEFT JOIN student_enrollments se ON se.student_id = s.id
    LEFT JOIN class_sections cs ON cs.id = se.class_section_id
    LEFT JOIN classes c ON c.id = cs.class_id
    LEFT JOIN sections sec ON sec.id = cs.section_id
    WHERE s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
      AND s.status_id = 1
      ${classId ? sql`AND c.id = ${classId}` : sql``}
      ${sectionId ? sql`AND sec.id = ${sectionId}` : sql``}
      ${search ? sql`AND (p.display_name ILIKE ${'%' + search + '%'} OR s.admission_no ILIKE ${'%' + search + '%'})` : sql``}
    ORDER BY c.name ASC NULLS LAST, sec.name ASC NULLS LAST, p.display_name ASC
  `;

  if (!students.length) {
    return [];
  }

  // Fetch all submitted / verified documents for these students
  const studentIds = students.map((s) => s.student_id);
  const docs = await sql`
    SELECT student_id, document_type, status, file_url, title
    FROM student_documents
    WHERE school_id = ${schoolId}
      AND student_id IN ${sql(studentIds)}
      AND status IN ('SUBMITTED', 'VERIFIED')
  `;

  const docsByStudent = new Map();
  for (const doc of docs) {
    if (!docsByStudent.has(doc.student_id)) {
      docsByStudent.set(doc.student_id, new Set());
    }
    docsByStudent.get(doc.student_id).add(doc.document_type);
  }

  const result = [];
  for (const student of students) {
    const submittedSet = docsByStudent.get(student.student_id) || new Set();
    const missing = [];

    for (const reqType of requiredTypes) {
      if (!submittedSet.has(reqType)) {
        missing.push({
          document_type: reqType,
          display_name: requiredMap.get(reqType) || reqType,
        });
      }
    }

    if (missing.length > 0) {
      result.push({
        student_id: student.student_id,
        admission_no: student.admission_no,
        student_name: student.student_name,
        class_name: student.class_name || 'Unassigned',
        section_name: student.section_name || 'Unassigned',
        guardian_name: student.guardian_contact?.parent_name || 'N/A',
        guardian_phone: student.guardian_contact?.phone || 'N/A',
        missing_documents: missing,
        missing_count: missing.length,
        submitted_count: submittedSet.size,
        required_count: requiredTypes.length,
        compliance_pct: Math.round(((requiredTypes.length - missing.length) / requiredTypes.length) * 100),
      });
    }
  }

  return result;
}

/**
 * Summarize student document compliance overall and grouped by grade/class
 */
export async function getComplianceSummary(schoolId) {
  const requiredDocs = await getRequiredDocuments(schoolId);
  const requiredCount = requiredDocs.length;
  const missingList = await getMissingDocumentsList(schoolId);

  // Total active students count
  const [totalRow] = await sql`
    SELECT COUNT(*)::int AS count
    FROM students
    WHERE school_id = ${schoolId}
      AND deleted_at IS NULL
      AND status_id = 1
  `;
  const totalStudents = totalRow?.count || 0;
  const missingCount = missingList.length;
  const compliantCount = Math.max(0, totalStudents - missingCount);
  const complianceRate = totalStudents > 0 ? Math.round((compliantCount / totalStudents) * 100) : 100;

  // Breakdown by class
  const classBreakdownMap = new Map();
  for (const item of missingList) {
    const key = item.class_name;
    if (!classBreakdownMap.has(key)) {
      classBreakdownMap.set(key, { class_name: key, missing_count: 0, missing_students: [] });
    }
    const entry = classBreakdownMap.get(key);
    entry.missing_count += 1;
    if (entry.missing_students.length < 5) {
      entry.missing_students.push({
        student_id: item.student_id,
        student_name: item.student_name,
        missing_count: item.missing_count,
      });
    }
  }

  return {
    total_students: totalStudents,
    compliant_students: compliantCount,
    non_compliant_students: missingCount,
    compliance_rate_pct: complianceRate,
    required_documents: requiredDocs,
    required_documents_count: requiredCount,
    by_class: Array.from(classBreakdownMap.values()),
  };
}

/**
 * Send reminder to parent/guardian for missing admission documents
 */
export async function sendDocumentReminder(schoolId, studentId, { actorId = null, customMessage = null } = {}) {
  const [student] = await sql`
    SELECT
      s.id,
      s.admission_no,
      p.display_name AS student_name,
      (
        SELECT json_build_object(
          'parent_name', parent_p.display_name,
          'phone', pc.contact_value
        )
        FROM student_parents sp
        JOIN parents pr ON sp.parent_id = pr.id AND pr.school_id = ${schoolId} AND pr.deleted_at IS NULL
        JOIN persons parent_p ON pr.person_id = parent_p.id AND parent_p.school_id = ${schoolId} AND parent_p.deleted_at IS NULL
        LEFT JOIN person_contacts pc ON parent_p.id = pc.person_id AND pc.contact_type = 'phone' AND pc.is_primary = true AND pc.school_id = ${schoolId} AND pc.deleted_at IS NULL
        WHERE sp.student_id = s.id AND sp.school_id = ${schoolId} AND sp.deleted_at IS NULL
        LIMIT 1
      ) AS guardian_contact
    FROM students s
    JOIN persons p ON p.id = s.person_id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
    WHERE s.id = ${studentId} AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
    LIMIT 1
  `;

  if (!student) {
    throw new Error('STUDENT_NOT_FOUND');
  }

  const requiredDocs = await getRequiredDocuments(schoolId);
  const existingDocs = await sql`
    SELECT document_type
    FROM student_documents
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
      AND status IN ('SUBMITTED', 'VERIFIED')
  `;
  const submittedSet = new Set(existingDocs.map((d) => d.document_type));
  const missing = requiredDocs
    .filter((d) => !submittedSet.has(d.document_type))
    .map((d) => d.display_name);

  if (missing.length === 0) {
    return {
      success: true,
      reminded: false,
      message: 'All required documents have already been submitted.',
    };
  }

  const message =
    customMessage ||
    `Dear Parent, please submit the pending admission documents for ${student.student_name}: ${missing.join(', ')}. Kindly submit to the school office at the earliest.`;

  // Log in audit_logs
  await sql`
    INSERT INTO audit_logs (
      school_id,
      user_id,
      action,
      entity_type,
      entity_id,
      new_data,
      created_at
    )
    VALUES (
      ${schoolId},
      ${actorId},
      'admission.document_reminder_sent',
      'students',
      ${studentId}::text,
      ${sql.json({
        student_name: student.student_name,
        admission_no: student.admission_no,
        guardian: student.guardian_contact,
        missing_documents: missing,
        message,
        sent_at: new Date().toISOString(),
      })},
      now()
    )
  `;

  logger.info(`[DocumentReminder] Sent reminder for student ${studentId} to guardian ${student.guardian_contact?.parent_name || 'N/A'}`);

  return {
    success: true,
    reminded: true,
    student_id: studentId,
    student_name: student.student_name,
    guardian_phone: student.guardian_contact?.phone || null,
    missing_documents: missing,
    message,
  };
}
