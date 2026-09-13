import sql from '../db.js';
import logger from '../utils/logger.js';
import { getApplicationDocumentsWithChecklist } from './admissionDocumentService.js';
import { WORKFLOW_STATUSES } from './admissionWorkflowService.js';
import { sendAdmissionNotification } from './admissionNotificationHelper.js';
import { httpError } from './admissionHelpers.js';

/**
 * Generate the next server-side unique admission number for a school.
 */
export async function generateNextAdmissionNumber(tx, schoolId) {
  const [settings] = await tx`
    SELECT admission_number_prefix, admission_number_format, admission_number_seq
    FROM admission_settings
    WHERE school_id = ${schoolId}
    FOR UPDATE
  `;

  const prefix = settings?.admission_number_prefix || 'ADM';
  const format = settings?.admission_number_format || 'ADM/YY/NNNN';
  let seq = settings?.admission_number_seq || 1;

  const currentYear = new Date().getFullYear();
  const shortYear = String(currentYear).slice(-2);

  let candidate = '';
  let isUnique = false;
  let attempts = 0;

  while (!isUnique && attempts < 100) {
    attempts++;
    const paddedSeq = String(seq).padStart(4, '0');
    candidate = format
      .replace(/PREFIX/gi, prefix)
      .replace(/\{YYYY\}/gi, String(currentYear))
      .replace(/\{YEAR\}/gi, String(currentYear))
      .replace(/YYYY/gi, String(currentYear))
      .replace(/\{YY\}/gi, shortYear)
      .replace(/YY/gi, shortYear)
      .replace(/\{SEQ:(\d+)\}/gi, (_, n) => String(seq).padStart(Number(n), '0'))
      .replace(/NNNN/gi, paddedSeq)
      .replace(/NNN/gi, String(seq).padStart(3, '0'));

    // Check if admission_no exists in students table
    const [existing] = await tx`
      SELECT id FROM students
      WHERE school_id = ${schoolId} AND admission_no = ${candidate} AND deleted_at IS NULL
      LIMIT 1
    `;

    if (!existing) {
      isUnique = true;
    } else {
      seq++;
    }
  }

  // Update next sequence in settings
  await tx`
    UPDATE admission_settings
    SET admission_number_seq = ${seq + 1},
        updated_at = now()
    WHERE school_id = ${schoolId}
  `;

  return candidate;
}

/**
 * Pre-flight validation to ensure application is 100% ready for student conversion.
 */
export async function validateConversionReadiness(schoolId, applicationId) {
  const [app] = await sql`
    SELECT * FROM admission_applications
    WHERE id = ${applicationId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;

  if (!app) {
    return { ready: false, errors: ['Application not found'] };
  }

  const errors = [];

  // 1. Check if already converted
  if (app.status === WORKFLOW_STATUSES.CONVERTED_TO_STUDENT || app.converted_student_id) {
    return { ready: false, errors: ['Application is already converted to a student'] };
  }

  // 2. Decision must be APPROVED (or later confirmation states)
  if (!['APPROVED', 'FEE_PENDING', 'FEE_PAID', 'ADMISSION_CONFIRMED'].includes(app.status) && app.decision !== 'APPROVED') {
    errors.push(`Application decision must be APPROVED before conversion (currently: ${app.status} / ${app.decision})`);
  }

  const [settings] = await sql`SELECT application_fee FROM admission_settings WHERE school_id = ${schoolId}`;
  const [feeStage] = await sql`
    SELECT id FROM admission_workflow_stages
    WHERE school_id = ${schoolId} AND code = 'FEE_PENDING' AND is_mandatory = true AND is_active = true
    LIMIT 1
  `;
  if (feeStage && Number(settings?.application_fee || 0) > 0 && !['FEE_PAID', 'ADMISSION_CONFIRMED'].includes(app.status)) {
    errors.push('Admission fee must be confirmed before student conversion');
  }

  // 3. Class and Academic Year must be assigned
  if (!app.applying_class_id) {
    errors.push('Applying class is required for student enrollment');
  }
  if (!app.academic_year_id) {
    errors.push('Academic year is required for student enrollment');
  }

  // 4. Student mandatory personal information
  if (!app.student_first_name?.trim()) {
    errors.push('Student first name is missing');
  }
  if (!app.dob) {
    errors.push('Student date of birth is missing');
  }
  if (!app.gender_id) {
    errors.push('Student gender is missing');
  }

  // 5. Parent / Guardian information
  const hasParent = (app.father_name && app.father_phone) ||
                    (app.mother_name && app.mother_phone) ||
                    (app.guardian_name && app.guardian_phone);
  if (!hasParent) {
    errors.push('At least one primary parent or guardian with name and phone number is required');
  }

  // 6. Mandatory documents compliance check
  const docStatus = await getApplicationDocumentsWithChecklist(schoolId, applicationId);
  const unverifiedMandatory = docStatus.checklist.filter(
    (c) => c.isMandatory && c.uploadedDoc?.status !== 'VERIFIED'
  );
  if (unverifiedMandatory.length > 0) {
    const unverifiedNames = unverifiedMandatory.map((u) => u.displayName).join(', ');
    errors.push(`Mandatory documents must be verified prior to conversion: ${unverifiedNames}`);
  }

  return {
    ready: errors.length === 0,
    errors,
    application: app,
    compliance: docStatus,
  };
}

/**
 * Execute transactional applicant to student conversion.
 * Atomic: if any step fails, entire transaction rolls back.
 */
export async function convertApplicantToStudent(schoolId, applicationId, operatorUserId, options = {}) {
  // Pre-flight check
  const check = await validateConversionReadiness(schoolId, applicationId);
  if (!check.ready) {
    throw httpError(`Student conversion could not be completed. ${check.errors.join('; ')}`, 400);
  }

  const app = check.application;

  try {
    const result = await sql.begin(async (tx) => {
    // 1. Lock application row to prevent concurrent conversion
    const [lockedApp] = await tx`
      SELECT id, status, converted_student_id
      FROM admission_applications
      WHERE id = ${applicationId} AND school_id = ${schoolId}
      FOR UPDATE
    `;

    if (lockedApp.status === WORKFLOW_STATUSES.CONVERTED_TO_STUDENT || lockedApp.converted_student_id) {
      throw httpError('This application has already been converted by another operator.', 409);
    }

    // 2. Generate or use specified admission number
    const finalAdmissionNo = options.custom_admission_no?.trim() ||
                             await generateNextAdmissionNumber(tx, schoolId);

    // 3. Create Student Person record
    const [studentPerson] = await tx`
      INSERT INTO persons (
        school_id, first_name, middle_name, last_name, dob, gender_id,
        nationality_code, photo_url
      )
      VALUES (
        ${schoolId}, ${app.student_first_name.trim()},
        ${app.student_middle_name?.trim() || null},
        ${app.student_last_name?.trim() || null},
        ${app.dob}, ${app.gender_id},
        ${app.nationality_code || 'IN'},
        ${app.student_photo_url || null}
      )
      RETURNING id
    `;

    // 4. Create Student core record
    const admissionDate = options.admission_date || new Date().toISOString().split('T')[0];
    const [student] = await tx`
      INSERT INTO students (
        school_id, person_id, admission_no, admission_date, status_id,
        category_id, religion_id, blood_group_id, aadhaar_number,
        tc_number, previous_school
      )
      VALUES (
        ${schoolId}, ${studentPerson.id}, ${finalAdmissionNo}, ${admissionDate}, 1,
        ${app.category_id || null}, ${app.religion_id || null}, ${app.blood_group_id || null},
        ${app.aadhaar_number || null}, ${app.tc_number || null}, ${app.has_previous_school || false}
      )
      RETURNING id, admission_no
    `;

    // 5. Create Student Contact Records (if provided)
    if (app.father_email || app.mother_email) {
      const studentEmail = app.father_email || app.mother_email;
      await tx`
        INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
        VALUES (${schoolId}, ${studentPerson.id}, 'email', ${studentEmail.trim().toLowerCase()}, false)
      `;
    }
    if (app.father_phone || app.mother_phone) {
      const studentPhone = app.father_phone || app.mother_phone;
      await tx`
        INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
        VALUES (${schoolId}, ${studentPerson.id}, 'phone', ${studentPhone.trim()}, false)
      `;
    }

    // 6. Class & Section Enrollment — prefer existing class_section for this class/year
    let targetSectionId = options.section_id || app.assigned_section_id || null;
    let targetClassSectionId = null;

    if (targetSectionId) {
      const [cs] = await tx`
        INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
        VALUES (${schoolId}, ${app.applying_class_id}, ${targetSectionId}, ${app.academic_year_id})
        ON CONFLICT (school_id, class_id, section_id, academic_year_id)
        DO UPDATE SET deleted_at = NULL
        RETURNING id
      `;
      targetClassSectionId = cs?.id;
    } else {
      const [existingCs] = await tx`
        SELECT id, section_id FROM class_sections
        WHERE school_id = ${schoolId}
          AND class_id = ${app.applying_class_id}
          AND academic_year_id = ${app.academic_year_id}
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 1
      `;
      if (existingCs) {
        targetClassSectionId = existingCs.id;
        targetSectionId = existingCs.section_id;
      } else {
        const [firstSection] = await tx`
          SELECT id FROM sections WHERE school_id = ${schoolId} AND deleted_at IS NULL ORDER BY name ASC LIMIT 1
        `;
        if (!firstSection) {
          throw httpError('Student conversion could not be completed. No class section is configured for this grade.', 400);
        }
        targetSectionId = firstSection.id;
        const [cs] = await tx`
          INSERT INTO class_sections (school_id, class_id, section_id, academic_year_id)
          VALUES (${schoolId}, ${app.applying_class_id}, ${targetSectionId}, ${app.academic_year_id})
          ON CONFLICT (school_id, class_id, section_id, academic_year_id)
          DO UPDATE SET deleted_at = NULL
          RETURNING id
        `;
        targetClassSectionId = cs?.id;
      }
    }

    if (!targetClassSectionId) {
      throw httpError('Student conversion could not be completed. Class section could not be resolved.', 400);
    }

    // Create student_enrollments record
    await tx`
      INSERT INTO student_enrollments (
        school_id, student_id, class_section_id, academic_year_id, status,
        start_date, roll_number
      )
      VALUES (
        ${schoolId}, ${student.id}, ${targetClassSectionId}, ${app.academic_year_id},
        'active', ${admissionDate}, ${options.roll_number || null}
      )
    `;

    // 7. Create and Link Parent / Guardian Records
    const parentsToSync = [];
    if (app.father_name?.trim()) {
      parentsToSync.push({
        first_name: app.father_name.trim(),
        relation: 'Father',
        relationship: 'Father',
        phone: app.father_phone?.trim(),
        email: app.father_email?.trim(),
        occupation: app.father_occupation?.trim(),
        is_primary_contact: app.primary_contact === 'father',
        is_legal_guardian: true,
        gender_id: 1, // Male
      });
    }
    if (app.mother_name?.trim()) {
      parentsToSync.push({
        first_name: app.mother_name.trim(),
        relation: 'Mother',
        relationship: 'Mother',
        phone: app.mother_phone?.trim(),
        email: app.mother_email?.trim(),
        occupation: app.mother_occupation?.trim(),
        is_primary_contact: app.primary_contact === 'mother',
        is_legal_guardian: true,
        gender_id: 2, // Female
      });
    }
    if (app.guardian_name?.trim() && !parentsToSync.length) {
      parentsToSync.push({
        first_name: app.guardian_name.trim(),
        relation: app.guardian_relation || 'Guardian',
        relationship: 'Guardian',
        phone: app.guardian_phone?.trim(),
        email: app.guardian_email?.trim(),
        is_primary_contact: true,
        is_legal_guardian: true,
        gender_id: 3, // Other
      });
    }

    for (const p of parentsToSync) {
      // Insert Parent Person
      const [parentPerson] = await tx`
        INSERT INTO persons (school_id, first_name, gender_id)
        VALUES (${schoolId}, ${p.first_name}, ${p.gender_id})
        RETURNING id
      `;

      // Insert Parent Entity
      const [parentEntity] = await tx`
        INSERT INTO parents (school_id, person_id, occupation)
        VALUES (${schoolId}, ${parentPerson.id}, ${p.occupation || null})
        RETURNING id
      `;

      // Rel Map: Father=1, Mother=2, Guardian=3
      const relId = p.relation === 'Father' ? 1 : (p.relation === 'Mother' ? 2 : 3);
      await tx`
        INSERT INTO student_parents (
          school_id, student_id, parent_id, relationship_id,
          is_primary_contact, is_legal_guardian
        )
        VALUES (
          ${schoolId}, ${student.id}, ${parentEntity.id}, ${relId},
          ${p.is_primary_contact}, ${p.is_legal_guardian}
        )
      `;

      // Parent Contacts
      if (p.phone) {
        await tx`
          INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
          VALUES (${schoolId}, ${parentPerson.id}, 'phone', ${p.phone}, true)
          ON CONFLICT DO NOTHING
        `;
      }
      if (p.email) {
        await tx`
          INSERT INTO person_contacts (school_id, person_id, contact_type, contact_value, is_primary)
          VALUES (${schoolId}, ${parentPerson.id}, 'email', ${p.email.toLowerCase()}, false)
          ON CONFLICT DO NOTHING
        `;
      }
    }

    // 8. Account Transition: Upgrade applicant user to parent role
    if (app.applicant_user_id) {
      const [parentRole] = await tx`
        SELECT id FROM roles WHERE school_id = ${schoolId} AND code = 'parent' AND deleted_at IS NULL
      `;
      if (parentRole) {
        await tx`
          INSERT INTO user_roles (school_id, user_id, role_id)
          VALUES (${schoolId}, ${app.applicant_user_id}, ${parentRole.id})
          ON CONFLICT (user_id, role_id) DO NOTHING
        `;
      }
    }

    // 9. Update Admission Application Record to CONVERTED_TO_STUDENT
    await tx`
      UPDATE admission_applications
          SET status = ${WORKFLOW_STATUSES.CONVERTED_TO_STUDENT},
          converted_student_id = ${student.id},
          assigned_section_id = ${targetSectionId},
          converted_at = now(),
          converted_by = ${operatorUserId},
          updated_at = now()
      WHERE id = ${applicationId} AND school_id = ${schoolId}
    `;

    // 10. Record in Stage History & Forensic Audit Log
    await tx`
      INSERT INTO admission_application_stage_history (
        school_id, application_id, from_status, to_status, actor_id, remarks
      )
      VALUES (
        ${schoolId}, ${applicationId}, ${app.status}, ${WORKFLOW_STATUSES.CONVERTED_TO_STUDENT},
        ${operatorUserId}, ${'Converted to student with Admission No ' + finalAdmissionNo}
      )
    `;

    await tx`
      INSERT INTO admission_audit_logs (
        school_id, application_id, actor_id, actor_role, action,
        from_state, to_state, reason, details
      )
      VALUES (
        ${schoolId}, ${applicationId}, ${operatorUserId}, 'admin',
        'CONVERTED_TO_STUDENT', ${app.status}, ${WORKFLOW_STATUSES.CONVERTED_TO_STUDENT},
        ${'Official student enrolled with Admission No: ' + finalAdmissionNo},
        ${sql.json({
          student_id: student.id,
          admission_no: finalAdmissionNo,
          class_id: app.applying_class_id,
          academic_year_id: app.academic_year_id,
        })}
      )
    `;

    logger.info({
      schoolId,
      applicationId,
      studentId: student.id,
      admissionNo: finalAdmissionNo,
    }, 'Successfully converted admission applicant to official student');

    return {
      success: true,
      studentId: student.id,
      admissionNo: finalAdmissionNo,
      admissionNumber: finalAdmissionNo,
      applicationNo: app.application_no,
      studentName: [app.student_first_name, app.student_last_name].filter(Boolean).join(' '),
      student: { id: student.id, admission_number: finalAdmissionNo, admission_no: finalAdmissionNo },
    };
    });

    try {
      await sql`
        UPDATE admission_applications
        SET converted_admission_no = ${result.admissionNo}
        WHERE id = ${applicationId} AND school_id = ${schoolId}
      `;
    } catch {
      // optional column from hardening migration
    }

    try {
      await sql`
        INSERT INTO admission_conversion_logs (
          school_id, application_id, student_id, admission_no, actor_id, status, details
        )
        VALUES (
          ${schoolId}, ${applicationId}, ${result.studentId}, ${result.admissionNo}, ${operatorUserId}, 'SUCCESS',
          ${sql.json({ class_id: app.applying_class_id, academic_year_id: app.academic_year_id })}
        )
      `;
    } catch {
      // optional hardening table
    }

    if (app.applicant_user_id) {
      await sendAdmissionNotification({
        schoolId,
        applicationId,
        recipientUserId: app.applicant_user_id,
        type: 'ADMISSION_CONFIRMED',
        params: { admission_no: result.admissionNo },
        subject: `Admission confirmed: ${result.admissionNo}`,
        message: `Congratulations! Admission is confirmed. Official admission number: ${result.admissionNo}.`,
      });
    }

    return result;
  } catch (err) {
    try {
      await sql`
        INSERT INTO admission_conversion_logs (
          school_id, application_id, actor_id, status, error_message
        )
        VALUES (
          ${schoolId}, ${applicationId}, ${operatorUserId}, 'FAILED', ${err.message || 'Conversion failed'}
        )
      `;
    } catch {
      // conversion log table may not exist yet on older environments
    }
    if (err.status || err.statusCode) throw err;
    throw httpError('Student conversion could not be completed. No partial admission record was created.', 500);
  }
}
