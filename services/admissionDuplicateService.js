import sql from '../db.js';

/**
 * Scan database for potential duplicate admission applications or existing student records.
 */
export async function checkDuplicateApplications(schoolId, {
  phone = '',
  email = '',
  studentFirstName = '',
  studentLastName = '',
  dob = null,
  previousSchoolName = '',
  tcNumber = '',
  excludeApplicationId = null,
}) {
  const matches = [];
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedFirstName = String(studentFirstName || '').trim().toLowerCase();
  const normalizedLastName = String(studentLastName || '').trim().toLowerCase();
  const normalizedTc = String(tcNumber || '').trim();

  // 1. Check existing admission applications by phone
  if (normalizedPhone && normalizedPhone.length >= 10) {
    const phoneMatches = await sql`
      SELECT id, application_no, status, student_first_name, student_last_name,
             father_phone, mother_phone, father_email, applying_class_id, created_at
      FROM admission_applications
      WHERE school_id = ${schoolId}
        AND deleted_at IS NULL
        ${excludeApplicationId ? sql`AND id != ${excludeApplicationId}` : sql``}
        AND (
          father_phone ILIKE ${'%' + normalizedPhone.slice(-10) + '%'} OR
          mother_phone ILIKE ${'%' + normalizedPhone.slice(-10) + '%'}
        )
      LIMIT 5
    `;

    for (const row of phoneMatches) {
      matches.push({
        id: row.id,
        entityType: 'APPLICATION',
        matchType: 'PHONE_MATCH',
        confidence: 'HIGH',
        applicationNo: row.application_no,
        studentName: [row.student_first_name, row.student_last_name].filter(Boolean).join(' '),
        status: row.status,
        createdAt: row.created_at,
        details: `Matching contact phone found on application ${row.application_no}`,
      });
    }
  }

  // 2b. Email match
  if (normalizedEmail) {
    const emailMatches = await sql`
      SELECT id, application_no, status, student_first_name, student_last_name, created_at
      FROM admission_applications
      WHERE school_id = ${schoolId}
        AND deleted_at IS NULL
        ${excludeApplicationId ? sql`AND id != ${excludeApplicationId}` : sql``}
        AND (
          lower(father_email) = ${normalizedEmail} OR
          lower(mother_email) = ${normalizedEmail} OR
          lower(guardian_email) = ${normalizedEmail}
        )
      LIMIT 5
    `;
    for (const row of emailMatches) {
      if (!matches.some((m) => m.id === row.id)) {
        matches.push({
          id: row.id,
          entityType: 'APPLICATION',
          matchType: 'EMAIL_MATCH',
          confidence: 'HIGH',
          applicationNo: row.application_no,
          studentName: [row.student_first_name, row.student_last_name].filter(Boolean).join(' '),
          status: row.status,
          createdAt: row.created_at,
          details: `Matching email found on application ${row.application_no}`,
        });
      }
    }
  }

  // 2. Check existing admission applications by student name and DOB
  if (normalizedFirstName && dob) {
    const nameDobMatches = await sql`
      SELECT id, application_no, status, student_first_name, student_last_name,
             dob, applying_class_id, created_at
      FROM admission_applications
      WHERE school_id = ${schoolId}
        AND deleted_at IS NULL
        ${excludeApplicationId ? sql`AND id != ${excludeApplicationId}` : sql``}
        AND lower(student_first_name) = ${normalizedFirstName}
        AND dob = ${dob}::date
      LIMIT 5
    `;

    for (const row of nameDobMatches) {
      // Avoid duplicate listing
      if (!matches.some((m) => m.id === row.id)) {
        matches.push({
          id: row.id,
          entityType: 'APPLICATION',
          matchType: 'NAME_DOB_MATCH',
          confidence: 'VERY_HIGH',
          applicationNo: row.application_no,
          studentName: [row.student_first_name, row.student_last_name].filter(Boolean).join(' '),
          status: row.status,
          createdAt: row.created_at,
          details: `Matching student name (${row.student_first_name}) and date of birth (${row.dob})`,
        });
      }
    }
  }

  // 3. Check existing enrolled active students (to prevent re-admitting existing students)
  if (normalizedFirstName && dob) {
    const existingStudentMatches = await sql`
      SELECT s.id, s.admission_no, p.first_name, p.last_name, p.dob, c.name as class_name
      FROM students s
      JOIN persons p ON s.person_id = p.id AND p.school_id = ${schoolId} AND p.deleted_at IS NULL
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active'
      LEFT JOIN class_sections cs ON se.class_section_id = cs.id
      LEFT JOIN classes c ON cs.class_id = c.id
      WHERE s.school_id = ${schoolId}
        AND s.deleted_at IS NULL
        AND lower(p.first_name) = ${normalizedFirstName}
        AND p.dob = ${dob}::date
      LIMIT 3
    `;

    for (const row of existingStudentMatches) {
      matches.push({
        id: row.id,
        entityType: 'ENROLLED_STUDENT',
        matchType: 'EXISTING_STUDENT_MATCH',
        confidence: 'VERY_HIGH',
        admissionNo: row.admission_no,
        studentName: [row.first_name, row.last_name].filter(Boolean).join(' '),
        className: row.class_name || 'Enrolled',
        details: `Student already actively enrolled in school with Admission No ${row.admission_no}`,
      });
    }
  }

  return {
    isPotentialDuplicate: matches.length > 0,
    matchCount: matches.length,
    matches,
  };
}

/**
 * Merge a duplicate application into a primary application.
 * Documents and communications are copied; the source is withdrawn, never hard-deleted.
 */
export async function mergeDuplicateApplications(schoolId, primaryId, sourceId, actorId = null) {
  if (!primaryId || !sourceId || primaryId === sourceId) {
    const err = new Error('Provide two different application ids to merge');
    err.status = 400;
    throw err;
  }

  return sql.begin(async (tx) => {
    const [primary] = await tx`
      SELECT * FROM admission_applications
      WHERE id = ${primaryId} AND school_id = ${schoolId} AND deleted_at IS NULL
      FOR UPDATE
    `;
    const [source] = await tx`
      SELECT * FROM admission_applications
      WHERE id = ${sourceId} AND school_id = ${schoolId} AND deleted_at IS NULL
      FOR UPDATE
    `;

    if (!primary || !source) {
      const err = new Error('One or both applications were not found in this school');
      err.status = 404;
      throw err;
    }
    if (primary.status === 'CONVERTED_TO_STUDENT' || source.status === 'CONVERTED_TO_STUDENT') {
      const err = new Error('Converted applications cannot be merged');
      err.status = 400;
      throw err;
    }

    const fill = (field) => (primary[field] == null || primary[field] === '' ? source[field] : primary[field]);
    await tx`
      UPDATE admission_applications
      SET student_middle_name = COALESCE(student_middle_name, ${source.student_middle_name}),
          dob = COALESCE(dob, ${source.dob}),
          gender_id = COALESCE(gender_id, ${source.gender_id}),
          father_name = COALESCE(NULLIF(father_name, ''), ${source.father_name}),
          father_phone = COALESCE(NULLIF(father_phone, ''), ${source.father_phone}),
          father_email = COALESCE(NULLIF(father_email, ''), ${source.father_email}),
          mother_name = COALESCE(NULLIF(mother_name, ''), ${source.mother_name}),
          mother_phone = COALESCE(NULLIF(mother_phone, ''), ${source.mother_phone}),
          address_line1 = COALESCE(NULLIF(address_line1, ''), ${source.address_line1}),
          city = COALESCE(NULLIF(city, ''), ${source.city}),
          applicant_user_id = COALESCE(applicant_user_id, ${source.applicant_user_id}),
          enquiry_id = COALESCE(enquiry_id, ${source.enquiry_id}),
          updated_at = now()
      WHERE id = ${primaryId} AND school_id = ${schoolId}
    `;

    const sourceDocs = await tx`
      SELECT * FROM admission_documents
      WHERE application_id = ${sourceId} AND school_id = ${schoolId}
    `;
    for (const doc of sourceDocs) {
      const [exists] = await tx`
        SELECT id FROM admission_documents
        WHERE application_id = ${primaryId} AND school_id = ${schoolId} AND document_type = ${doc.document_type}
        LIMIT 1
      `;
      if (!exists) {
        await tx`
          INSERT INTO admission_documents (
            school_id, application_id, document_type, title, file_url, file_size_bytes, mime_type,
            status, version, file_hash, original_file_name, storage_path
          )
          VALUES (
            ${schoolId}, ${primaryId}, ${doc.document_type}, ${doc.title}, ${doc.file_url},
            ${doc.file_size_bytes}, ${doc.mime_type}, ${doc.status}, ${doc.version},
            ${doc.file_hash || null}, ${doc.original_file_name || null}, ${doc.storage_path || null}
          )
        `;
      }
    }

    await tx`
      UPDATE admission_communications
      SET application_id = ${primaryId}
      WHERE application_id = ${sourceId} AND school_id = ${schoolId}
    `;
    await tx`
      UPDATE admission_notes
      SET application_id = ${primaryId}
      WHERE application_id = ${sourceId} AND school_id = ${schoolId}
    `;

    await tx`
      UPDATE admission_applications
      SET status = 'WITHDRAWN',
          deleted_at = now(),
          updated_at = now()
      WHERE id = ${sourceId} AND school_id = ${schoolId}
    `;

    await tx`
      INSERT INTO admission_audit_logs (
        school_id, application_id, actor_id, actor_role, action, from_state, to_state, reason, details
      )
      VALUES (
        ${schoolId}, ${primaryId}, ${actorId}, 'staff', 'APPLICATIONS_MERGED',
        ${source.status}, ${primary.status},
        ${'Merged duplicate ' + source.application_no + ' into ' + primary.application_no},
        ${sql.json({ source_id: sourceId, source_application_no: source.application_no })}
      )
    `;

    const [updated] = await tx`SELECT * FROM admission_applications WHERE id = ${primaryId}`;
    return { primary: updated, mergedFrom: source.application_no };
  });
}
