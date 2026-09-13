import express from 'express';
import multer from 'multer';
import sql, { supabaseAdmin } from '../db.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { sendSuccess } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  WORKFLOW_STATUSES,
  getWorkflowStages,
  transitionApplicationStage,
} from '../services/admissionWorkflowService.js';
import {
  getDocumentRequirements,
  saveUploadedDocument,
  reviewDocument,
  getApplicationDocumentsWithChecklist,
} from '../services/admissionDocumentService.js';
import { checkDuplicateApplications, mergeDuplicateApplications } from '../services/admissionDuplicateService.js';
import {
  validateConversionReadiness,
  convertApplicantToStudent,
} from '../services/admissionConversionService.js';
import {
  createAdmissionTask,
  getAdmissionTasks,
  completeAdmissionTask,
  scanAndFlagSlaBreaches,
} from '../services/admissionTaskService.js';
import {
  scheduleInterview,
  evaluateInterview,
  getInterviews,
} from '../services/admissionInterviewService.js';
import { getAdmissionAnalytics } from '../services/admissionAnalyticsService.js';
import { sendAdmissionNotification } from '../services/admissionNotificationHelper.js';
import {
  presentApplication,
  presentChecklist,
  findApplicantApplication,
  nextAdmissionSerial,
  formatEnquiryNo,
  formatApplicationNo,
  httpError,
  stageCodeForStatus,
  generateApplicantPassword,
  computeApplicationProgress,
  buildSmartNextAction,
  presentWorkflowTimeline,
  APPLICANT_FULL_EDIT_STATUSES,
  APPLICANT_PARTIAL_EDIT_STATUSES,
} from '../services/admissionHelpers.js';
import { createSchoolScopedAuthUser, SchoolEmailConflictError } from '../utils/schoolEmail.js';
import { admissionPublicLimiter } from '../middleware/rateLimiter.js';
import logger from '../utils/logger.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

// =========================================================================
// 1. PUBLIC ROUTES (Enquiry, Duplicate Check, Public Form Configuration)
// =========================================================================

/**
 * GET /api/v1/admissions/public/form-config
 * Public form metadata: classes, current academic year, document checklist
 */
router.get('/public/form-config', admissionPublicLimiter, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  if (!schoolId) {
    return res.status(400).json({ error: 'school_id is required' });
  }

  const [school] = await sql`
    SELECT id, name, code FROM schools WHERE id = ${schoolId}
  `;
  if (!school) {
    return res.status(404).json({ error: 'School not found' });
  }

  const classes = await sql`
    SELECT id, name FROM classes WHERE school_id = ${schoolId} AND deleted_at IS NULL ORDER BY name ASC
  `;

  const [activeYear] = await sql`
    SELECT id, name, start_date, end_date FROM academic_years
    WHERE school_id = ${schoolId} AND now() BETWEEN start_date AND end_date
    LIMIT 1
  `;

  const docRequirements = await getDocumentRequirements(schoolId);
  const stages = await getWorkflowStages(schoolId);

  const [settings] = await sql`
    SELECT is_admission_open, application_fee, allow_online_payment
    FROM admission_settings WHERE school_id = ${schoolId}
  `;

  const genders = await sql`SELECT id, name FROM genders ORDER BY id`;
  const sources = ['Website', 'Walk-in', 'Phone', 'Referral', 'Existing Parent', 'Advertisement', 'Social Media', 'School Event', 'Other'];

  sendSuccess(res, schoolId, {
    school,
    classes,
    academicYear: activeYear || null,
    documentRequirements: docRequirements,
    workflowStages: stages,
    settings: settings || { is_admission_open: true, application_fee: 0 },
    genders,
    sources,
  });
}));

/**
 * POST /api/v1/admissions/public/duplicate-check
 * Check if prospective applicant exists before creating record
 */
router.post('/public/duplicate-check', admissionPublicLimiter, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { phone, email, studentFirstName, studentLastName, dob, tcNumber } = req.body;

  const result = await checkDuplicateApplications(schoolId, {
    phone,
    email,
    studentFirstName,
    studentLastName,
    dob,
    tcNumber,
  });

  sendSuccess(res, schoolId, result);
}));

/**
 * POST /api/v1/admissions/public/enquiry
 * Create initial prospective enquiry lead & provision applicant account
 */
router.post('/public/enquiry', admissionPublicLimiter, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const {
    parent_name,
    student_name,
    phone,
    email,
    interested_class_id,
    academic_year_id,
    source = 'Website',
    notes = '',
    create_applicant_account = true,
    password = null,
    force_new = false,
  } = req.body;

  if (!parent_name?.trim() || !student_name?.trim() || !phone?.trim()) {
    return res.status(400).json({ error: 'Parent name, student name, and phone are required' });
  }

  const [portalSettings] = await sql`
    SELECT is_admission_open FROM admission_settings WHERE school_id = ${schoolId}
  `;
  if (portalSettings && portalSettings.is_admission_open === false) {
    return res.status(403).json({ error: 'Admissions are currently closed for this school.' });
  }

  const duplicates = await checkDuplicateApplications(schoolId, {
    phone,
    email,
    studentFirstName: student_name.trim().split(' ')[0],
    studentLastName: student_name.trim().split(' ').slice(1).join(' '),
  });
  if (duplicates.isPotentialDuplicate && !force_new) {
    return sendSuccess(res, schoolId, {
      isPotentialDuplicate: true,
      duplicates,
      message: 'A possible existing application was found. Continue the existing application or confirm to create a new one.',
    });
  }

  // Resolve academic year if not provided
  let targetYearId = academic_year_id;
  if (!targetYearId) {
    const [ay] = await sql`
      SELECT id FROM academic_years
      WHERE school_id = ${schoolId} AND now() BETWEEN start_date AND end_date
      LIMIT 1
    `;
    targetYearId = ay?.id || null;
  }

  const currentYear = new Date().getFullYear();
  let enquiryNo;
  try {
    const seq = await nextAdmissionSerial(sql, schoolId, 'enquiry');
    enquiryNo = formatEnquiryNo(currentYear, seq);
  } catch {
    const enquiryCount = await sql`SELECT COUNT(*) as count FROM admission_enquiries WHERE school_id = ${schoolId}`;
    enquiryNo = formatEnquiryNo(currentYear, Number(enquiryCount[0]?.count || 0) + 1);
  }

  const [enquiry] = await sql`
    INSERT INTO admission_enquiries (
      school_id, enquiry_no, parent_name, student_name, phone,
      email, interested_class_id, academic_year_id, source, notes, status
    )
    VALUES (
      ${schoolId}, ${enquiryNo}, ${parent_name.trim()}, ${student_name.trim()}, ${phone.trim()},
      ${email ? email.trim().toLowerCase() : null}, ${interested_class_id || null},
      ${targetYearId}, ${source}, ${notes}, 'NEW'
    )
    RETURNING *
  `;

  // Provision applicant user account if requested
  let applicantUserId = null;
  let applicantCredentials = null;

  if (create_applicant_account) {
    const applicantEmail = email?.trim().toLowerCase() ||
      `applicant.${phone.replace(/\D/g, '').slice(-10)}@admission.schoolims.internal`;
    const applicantPassword = password?.trim() || generateApplicantPassword();
    let issuedNewPassword = true;

    try {
      const applicantEmailNormalized = applicantEmail;
      try {
        const created = await createSchoolScopedAuthUser(supabaseAdmin, {
          schoolId,
          email: applicantEmailNormalized,
          password: applicantPassword,
          userMetadata: {
            first_name: parent_name.trim(),
            role: 'applicant',
          },
        });
        if (created?.data?.user) {
          applicantUserId = created.data.user.id;
        }
      } catch (createErr) {
        if (createErr instanceof SchoolEmailConflictError || /already/i.test(createErr.message || '')) {
          const [existingAuth] = await sql`
            SELECT id, email FROM auth.users WHERE lower(email) = ${applicantEmailNormalized} LIMIT 1
          `;
          if (existingAuth?.id) {
            applicantUserId = existingAuth.id;
            issuedNewPassword = false;
          }
        } else {
          throw createErr;
        }
      }

      if (applicantUserId) {
        let [existingPerson] = await sql`
          SELECT p.id FROM persons p
          JOIN users u ON u.person_id = p.id
          WHERE u.id = ${applicantUserId}
        `;

        let personId = existingPerson?.id;
        if (!personId) {
          const [newPerson] = await sql`
            INSERT INTO persons (school_id, first_name, last_name, gender_id)
            VALUES (${schoolId}, ${parent_name.trim()}, 'Parent', 3)
            RETURNING id
          `;
          personId = newPerson.id;
        }

        await sql`
          INSERT INTO users (id, school_id, person_id, account_status)
          VALUES (${applicantUserId}, ${schoolId}, ${personId}, 'active')
          ON CONFLICT (id) DO NOTHING
        `;

        const [appRole] = await sql`
          SELECT id FROM roles WHERE school_id = ${schoolId} AND code = 'applicant' AND deleted_at IS NULL
        `;
        if (appRole) {
          await sql`
            INSERT INTO user_roles (school_id, user_id, role_id)
            VALUES (${schoolId}, ${applicantUserId}, ${appRole.id})
            ON CONFLICT (user_id, role_id) DO NOTHING
          `;
        }

        applicantCredentials = {
          email: applicantEmail,
          password: issuedNewPassword ? applicantPassword : undefined,
          existingAccount: !issuedNewPassword,
          loginUrl: '/admission/login',
        };
      }
    } catch (authErr) {
      logger.warn({ err: authErr.message }, 'Could not provision applicant user login');
    }
  }

  // Pre-generate draft application from enquiry
  let draftApp = null;
  if (interested_class_id && targetYearId) {
    let appNo;
    try {
      const seq = await nextAdmissionSerial(sql, schoolId, 'application');
      appNo = formatApplicationNo(currentYear, seq);
    } catch {
      const appCount = await sql`SELECT COUNT(*) as count FROM admission_applications WHERE school_id = ${schoolId}`;
      appNo = formatApplicationNo(currentYear, Number(appCount[0]?.count || 0) + 1);
    }

    // Split student name
    const parts = student_name.trim().split(' ');
    const firstName = parts[0] || 'Student';
    const lastName = parts.slice(1).join(' ') || 'Applicant';

    const [firstStage] = await sql`
      SELECT id FROM admission_workflow_stages
      WHERE school_id = ${schoolId} AND sequence_order = 1
      LIMIT 1
    `;

    const [createdApp] = await sql`
      INSERT INTO admission_applications (
        school_id, application_no, enquiry_id, applicant_user_id,
        student_first_name, student_last_name, applying_class_id, academic_year_id,
        father_name, father_phone, father_email,
        status, current_stage_id, source
      )
      VALUES (
        ${schoolId}, ${appNo}, ${enquiry.id}, ${applicantUserId},
        ${firstName}, ${lastName}, ${interested_class_id}, ${targetYearId},
        ${parent_name.trim()}, ${phone.trim()}, ${email ? email.trim().toLowerCase() : null},
        'APPLICATION_STARTED', ${firstStage?.id || null}, ${source}
      )
      RETURNING *
    `;

    draftApp = createdApp;

    // Link enquiry to application
    await sql`
      UPDATE admission_enquiries
      SET status = 'CONVERTED_TO_APPLICATION',
          converted_application_id = ${createdApp.id},
          updated_at = now()
      WHERE id = ${enquiry.id}
    `;
  }

  sendSuccess(res, schoolId, {
    enquiry,
    application: draftApp,
    applicantCredentials,
    message: 'Enquiry created successfully. You can now complete the admission application.',
  }, 201);
}));

/**
 * POST /api/v1/admissions/public/resolve-identifier
 * Resolves an application number, enquiry number, or phone to the registered login email
 */
router.post('/public/resolve-identifier', admissionPublicLimiter, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { identifier } = req.body;
  if (!identifier?.trim()) {
    return res.status(400).json({ error: 'Identifier is required' });
  }

  const clean = identifier.trim();

  // Search applications by application_number, student email, or parent phone
  const [foundApp] = await sql`
    SELECT a.id, a.application_no, a.father_email, a.father_phone, a.mother_email, a.mother_phone, u.id as user_id, au.email
    FROM admission_applications a
    LEFT JOIN users u ON a.applicant_user_id = u.id
    LEFT JOIN auth.users au ON u.id = au.id
    WHERE a.school_id = ${schoolId}
      AND (
        UPPER(a.application_no) = UPPER(${clean})
        OR a.father_email ILIKE ${clean}
        OR a.mother_email ILIKE ${clean}
        OR a.father_phone = ${clean}
        OR a.mother_phone = ${clean}
      )
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT 1
  `;

  const resolvedEmail = foundApp?.email || foundApp?.father_email || foundApp?.mother_email;
  if (resolvedEmail) {
    return sendSuccess(res, schoolId, {
      resolvedEmail,
      applicationNumber: foundApp.application_no,
    });
  }

  // Also check enquiries
  const [foundEnq] = await sql`
    SELECT e.id, e.enquiry_no, e.email, e.phone
    FROM admission_enquiries e
    WHERE e.school_id = ${schoolId}
      AND (
        UPPER(e.enquiry_no) = UPPER(${clean})
        OR e.email ILIKE ${clean}
        OR e.phone = ${clean}
      )
    ORDER BY e.created_at DESC
    LIMIT 1
  `;

  if (foundEnq?.email) {
    return sendSuccess(res, schoolId, {
      resolvedEmail: foundEnq.email,
      enquiryNumber: foundEnq.enquiry_no,
    });
  }

  res.status(404).json({ error: 'No application or enquiry found with this identifier' });
}));

// =========================================================================
// 2. APPLICANT SELF-SERVICE ROUTES (Authenticated as Applicant or Student Parent)
// =========================================================================

/**
 * GET /api/v1/admissions/my-application
 * Retrieve logged-in applicant's application dossier & live status
 */
router.get('/my-application', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;

  const app = await findApplicantApplication(schoolId, userId, req.user.email);
  if (!app) {
    return res.status(404).json({ error: 'No admission application found for your account' });
  }

  const documentChecklist = presentChecklist(await getApplicationDocumentsWithChecklist(schoolId, app.id));

  // Fetch scheduled interviews
  const interviews = await sql`
    SELECT id, interview_type, title, scheduled_date, start_time, end_time,
           location, mode, online_meeting_url, status
    FROM admission_interviews
    WHERE application_id = ${app.id} AND school_id = ${schoolId}
    ORDER BY scheduled_date ASC
  `;

  // Fetch communication messages
  const messages = await sql`
    SELECT id, sender_type, message_type, subject, message, created_at
    FROM admission_communications
    WHERE application_id = ${app.id} AND school_id = ${schoolId}
    ORDER BY created_at DESC
    LIMIT 20
  `;

  // Fetch workflow timeline
  const timeline = await sql`
    SELECT h.id, h.from_status, h.to_status, h.remarks, h.entered_at,
           s.name as stage_name
    FROM admission_application_stage_history h
    LEFT JOIN admission_workflow_stages s ON h.to_stage_id = s.id
    WHERE h.application_id = ${app.id} AND h.school_id = ${schoolId}
    ORDER BY h.entered_at ASC
  `;

  const stages = await getWorkflowStages(schoolId);
  const smartNextAction = buildSmartNextAction(app, { checklist: documentChecklist, interviews });
  const progressPercent = computeApplicationProgress(app, stages, documentChecklist);
  const workflowTimeline = presentWorkflowTimeline(stages, app, timeline);

  sendSuccess(res, schoolId, {
    application: presentApplication(app),
    documentChecklist,
    interviews,
    messages,
    timeline,
    workflowTimeline,
    workflowStages: stages,
    progressPercent,
    smartNextAction,
  });
}));

/**
 * PUT /api/v1/admissions/my-application
 * Autosave or update application draft details
 */
router.put('/my-application', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;

  const existing = await findApplicantApplication(schoolId, userId, req.user.email);
  if (!existing) {
    return res.status(404).json({ error: 'Application not found' });
  }

  if (existing.status === WORKFLOW_STATUSES.CONVERTED_TO_STUDENT) {
    return res.status(400).json({ error: 'Cannot modify a converted application' });
  }
  const canFullyEdit = APPLICANT_FULL_EDIT_STATUSES.includes(existing.status);
  const canPartialEdit = APPLICANT_PARTIAL_EDIT_STATUSES.includes(existing.status);
  if (!canFullyEdit && !canPartialEdit) {
    return res.status(400).json({ error: 'This application can no longer be edited. Contact the school if you need a correction.' });
  }

  const {
    student_first_name, student_middle_name, student_last_name, dob, gender_id,
    blood_group_id, religion_id, category_id, aadhaar_number, student_photo_url,
    applying_class_id, academic_year_id,
    father_name, father_phone, father_email, father_occupation,
    mother_name, mother_phone, mother_email, mother_occupation,
    guardian_name, guardian_phone, guardian_email, guardian_relation, primary_contact,
    address_line1, address_line2, city, state, pincode,
    has_previous_school, previous_school_name, previous_board, previous_class, previous_academic_year, tc_number,
    transport_required, pickup_location, preferred_route, hostel_required,
    sibling_studying_here, sibling_name, sibling_class, sibling_admission_no,
    medical_conditions, emergency_contact_name, emergency_contact_phone, custom_data,
  } = req.body;

  const [updated] = await sql`
    UPDATE admission_applications
    SET student_first_name = COALESCE(${student_first_name}, student_first_name),
        student_middle_name = COALESCE(${student_middle_name}, student_middle_name),
        student_last_name = COALESCE(${student_last_name}, student_last_name),
        dob = COALESCE(${dob ? sql`${dob}::date` : null}, dob),
        gender_id = COALESCE(${gender_id}, gender_id),
        blood_group_id = COALESCE(${blood_group_id}, blood_group_id),
        religion_id = COALESCE(${religion_id}, religion_id),
        category_id = COALESCE(${category_id}, category_id),
        aadhaar_number = COALESCE(${aadhaar_number}, aadhaar_number),
        student_photo_url = COALESCE(${student_photo_url}, student_photo_url),
        applying_class_id = COALESCE(${canFullyEdit ? applying_class_id : null}, applying_class_id),
        academic_year_id = COALESCE(${canFullyEdit ? academic_year_id : null}, academic_year_id),
        father_name = COALESCE(${father_name}, father_name),
        father_phone = COALESCE(${father_phone}, father_phone),
        father_email = COALESCE(${father_email}, father_email),
        father_occupation = COALESCE(${father_occupation}, father_occupation),
        mother_name = COALESCE(${mother_name}, mother_name),
        mother_phone = COALESCE(${mother_phone}, mother_phone),
        mother_email = COALESCE(${mother_email}, mother_email),
        mother_occupation = COALESCE(${mother_occupation}, mother_occupation),
        guardian_name = COALESCE(${guardian_name}, guardian_name),
        guardian_phone = COALESCE(${guardian_phone}, guardian_phone),
        guardian_email = COALESCE(${guardian_email}, guardian_email),
        guardian_relation = COALESCE(${guardian_relation}, guardian_relation),
        primary_contact = COALESCE(${primary_contact}, primary_contact),
        address_line1 = COALESCE(${address_line1}, address_line1),
        address_line2 = COALESCE(${address_line2}, address_line2),
        city = COALESCE(${city}, city),
        state = COALESCE(${state}, state),
        pincode = COALESCE(${pincode}, pincode),
        has_previous_school = COALESCE(${has_previous_school}, has_previous_school),
        previous_school_name = COALESCE(${previous_school_name}, previous_school_name),
        previous_board = COALESCE(${previous_board}, previous_board),
        previous_class = COALESCE(${previous_class}, previous_class),
        previous_academic_year = COALESCE(${previous_academic_year}, previous_academic_year),
        tc_number = COALESCE(${tc_number}, tc_number),
        transport_required = COALESCE(${transport_required}, transport_required),
        pickup_location = COALESCE(${pickup_location}, pickup_location),
        preferred_route = COALESCE(${preferred_route}, preferred_route),
        hostel_required = COALESCE(${hostel_required}, hostel_required),
        sibling_studying_here = COALESCE(${sibling_studying_here}, sibling_studying_here),
        sibling_name = COALESCE(${sibling_name}, sibling_name),
        sibling_class = COALESCE(${sibling_class}, sibling_class),
        sibling_admission_no = COALESCE(${sibling_admission_no}, sibling_admission_no),
        medical_conditions = COALESCE(${medical_conditions}, medical_conditions),
        emergency_contact_name = COALESCE(${emergency_contact_name}, emergency_contact_name),
        emergency_contact_phone = COALESCE(${emergency_contact_phone}, emergency_contact_phone),
        custom_data = COALESCE(${custom_data ? sql.json(custom_data) : null}, custom_data),
        updated_at = now()
    WHERE id = ${existing.id} AND school_id = ${schoolId}
    RETURNING *
  `;

  sendSuccess(res, schoolId, { application: presentApplication(updated), message: 'Draft saved' });
}));

/**
 * POST /api/v1/admissions/my-application/submit
 * Final applicant submission of application
 */
router.post('/my-application/submit', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;

  const app = await findApplicantApplication(schoolId, userId, req.user.email);
  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }

  if (!['ENQUIRY_CREATED', 'APPLICATION_STARTED', 'APPLICATION_INCOMPLETE'].includes(app.status)) {
    return res.status(400).json({ error: 'This application has already been submitted' });
  }

  if (!app.student_first_name?.trim() || !app.applying_class_id) {
    return res.status(400).json({ error: 'Please complete all required fields before submitting' });
  }
  if (!app.dob) {
    return res.status(400).json({ error: 'Student date of birth is required before submitting' });
  }
  const hasParent = (app.father_name && app.father_phone) || (app.mother_name && app.mother_phone) || (app.guardian_name && app.guardian_phone);
  if (!hasParent) {
    return res.status(400).json({ error: 'At least one parent or guardian with name and phone is required' });
  }

  const updated = await transitionApplicationStage(
    schoolId,
    app.id,
    WORKFLOW_STATUSES.APPLICATION_SUBMITTED,
    { actorId: userId, actorRole: 'applicant', remarks: 'Application submitted by parent' }
  );

  await sql`
    UPDATE admission_applications
    SET submitted_at = now()
    WHERE id = ${app.id}
  `;

  if (app.applicant_user_id) {
    await sendAdmissionNotification({
      schoolId,
      applicationId: app.id,
      recipientUserId: app.applicant_user_id,
      type: 'ADMISSION_APPLICATION_SUBMITTED',
      params: {
        application_no: app.application_no,
        student_name: [app.student_first_name, app.student_last_name].filter(Boolean).join(' '),
      },
      subject: `Application submitted: ${app.application_no}`,
      message: `Your admission application ${app.application_no} has been submitted successfully.`,
    });
  }

  sendSuccess(res, schoolId, {
    application: presentApplication(updated),
    message: 'Your admission application has been submitted successfully!',
  });
}));

/**
 * POST /api/v1/admissions/my-application/documents
 * Upload document (supports multipart or base64 JSON payload)
 */
router.post('/my-application/documents', requireAuth, upload.single('file'), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;

  const app = await findApplicantApplication(schoolId, userId, req.user.email);
  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }

  const documentType = req.body.document_type || req.body.documentType;
  const title = req.body.title || documentType;

  if (!documentType) {
    return res.status(400).json({ error: 'document_type is required' });
  }

  let fileBuffer;
  let fileName;
  let mimeType;
  let fileSize;

  if (req.file) {
    fileBuffer = req.file.buffer;
    fileName = req.file.originalname;
    mimeType = req.file.mimetype;
    fileSize = req.file.size;
  } else if (req.body.base64) {
    const raw = req.body.base64.replace(/^data:[^;]+;base64,/, '');
    fileBuffer = Buffer.from(raw, 'base64');
    fileName = req.body.fileName || `${documentType}.pdf`;
    mimeType = req.body.mimeType || 'application/pdf';
    fileSize = fileBuffer.length;
  } else {
    return res.status(400).json({ error: 'No document file provided (file or base64 required)' });
  }

  const saved = await saveUploadedDocument(schoolId, app.id, {
    documentType,
    title,
    fileBuffer,
    fileName,
    mimeType,
    fileSizeBytes: fileSize,
  });

  sendSuccess(res, schoolId, {
    document: saved,
    message: `${title} uploaded successfully`,
  }, 201);
}));

router.post('/my-application/messages', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const app = await findApplicantApplication(schoolId, userId, req.user.email);
  if (!app) return res.status(404).json({ error: 'Application not found' });

  const { subject, message } = req.body;
  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const [created] = await sql`
    INSERT INTO admission_communications (
      school_id, application_id, sender_type, sender_id, message_type, subject, message, channels
    )
    VALUES (
      ${schoolId}, ${app.id}, 'APPLICANT', ${userId}, 'GENERAL_MESSAGE',
      ${subject?.trim() || 'Parent query'}, ${message.trim()}, ARRAY['IN_APP']
    )
    RETURNING *
  `;

  sendSuccess(res, schoolId, { communication: created, message: 'Message sent to admissions office' }, 201);
}));

router.post('/my-application/withdraw', requireAuth, asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const userId = req.user.internal_id || req.user.id;
  const app = await findApplicantApplication(schoolId, userId, req.user.email);
  if (!app) return res.status(404).json({ error: 'Application not found' });
  if (['CONVERTED_TO_STUDENT', 'REJECTED'].includes(app.status)) {
    return res.status(400).json({ error: 'This application can no longer be withdrawn' });
  }

  const updated = await transitionApplicationStage(
    schoolId,
    app.id,
    WORKFLOW_STATUSES.WITHDRAWN,
    { actorId: userId, actorRole: 'applicant', remarks: req.body?.reason || 'Withdrawn by applicant' }
  );
  sendSuccess(res, schoolId, { application: presentApplication(updated), message: 'Application withdrawn' });
}));

// =========================================================================
// 3. STAFF & ADMIN PIPELINE COMMAND CENTER
// =========================================================================

/**
 * GET /api/v1/admissions/pipeline
 * Kanban pipeline view: returns active applications grouped by stage with counts
 */
router.get('/pipeline', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { classId, academicYearId, search } = req.query;

  const stages = await getWorkflowStages(schoolId);

  const applications = await sql`
    SELECT a.id, a.application_no, a.student_first_name, a.student_last_name,
           a.status, a.current_stage_id, a.priority, a.is_sla_breached, a.sla_due_at,
           a.total_score, a.decision, a.created_at, a.submitted_at,
           c.name as class_name,
           a.father_name, a.father_phone, a.mother_name, a.mother_phone
    FROM admission_applications a
    LEFT JOIN classes c ON a.applying_class_id = c.id
    WHERE a.school_id = ${schoolId}
      AND a.deleted_at IS NULL
      ${classId ? sql`AND a.applying_class_id = ${classId}` : sql``}
      ${academicYearId ? sql`AND a.academic_year_id = ${academicYearId}` : sql``}
      ${search ? sql`AND (
        a.application_no ILIKE ${'%' + search + '%'} OR
        a.student_first_name ILIKE ${'%' + search + '%'} OR
        a.student_last_name ILIKE ${'%' + search + '%'} OR
        a.father_name ILIKE ${'%' + search + '%'} OR
        a.father_phone ILIKE ${'%' + search + '%'}
      )` : sql``}
    ORDER BY a.priority = 'URGENT' DESC, a.is_sla_breached DESC, a.created_at DESC
  `;

  // Group applications by stage code or status
  const pipeline = stages.map((stage) => {
    const stageApps = applications.filter((app) =>
      app.current_stage_id === stage.id ||
      app.status === stage.code ||
      stageCodeForStatus(app.status) === stage.code
    );
    return {
      stageId: stage.id,
      stageCode: stage.code,
      stageName: stage.name,
      sequenceOrder: stage.sequence_order,
      color: stage.color,
      count: stageApps.length,
      applications: stageApps.map(presentApplication),
    };
  });

  // Summary header metrics
  const totalCount = applications.length;
  const slaBreachedCount = applications.filter((a) => a.is_sla_breached).length;

  sendSuccess(res, schoolId, {
    pipeline,
    totalCount,
    slaBreachedCount,
  });
}));

/**
 * GET /api/v1/admissions/applications
 * Searchable, filterable, paginated applications list
 */
router.get('/applications', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const {
    classId,
    status,
    search,
    priority,
    isSlaBreached,
    decision,
    limit = 50,
    offset = 0,
  } = req.query;

  const applications = await sql`
    SELECT a.id, a.application_no, a.student_first_name, a.student_last_name, a.dob,
           a.status, a.priority, a.is_sla_breached, a.sla_due_at, a.total_score,
           a.decision, a.created_at, a.submitted_at, a.converted_student_id,
           c.name as class_name, c.id as class_id,
           a.father_name, a.father_phone, a.father_email,
           a.mother_name, a.mother_phone,
           s.name as stage_name, s.color as stage_color
    FROM admission_applications a
    LEFT JOIN classes c ON a.applying_class_id = c.id
    LEFT JOIN admission_workflow_stages s ON a.current_stage_id = s.id
    WHERE a.school_id = ${schoolId}
      AND a.deleted_at IS NULL
      ${classId ? sql`AND a.applying_class_id = ${classId}` : sql``}
      ${status ? sql`AND a.status = ${status}` : sql``}
      ${priority ? sql`AND a.priority = ${priority}` : sql``}
      ${decision ? sql`AND a.decision = ${decision}` : sql``}
      ${isSlaBreached !== undefined && isSlaBreached !== '' ? sql`AND a.is_sla_breached = ${isSlaBreached === 'true'}` : sql``}
      ${search ? sql`AND (
        a.application_no ILIKE ${'%' + search + '%'} OR
        a.student_first_name ILIKE ${'%' + search + '%'} OR
        a.student_last_name ILIKE ${'%' + search + '%'} OR
        a.father_name ILIKE ${'%' + search + '%'} OR
        a.father_phone ILIKE ${'%' + search + '%'} OR
        a.father_email ILIKE ${'%' + search + '%'}
      )` : sql``}
    ORDER BY a.is_sla_breached DESC, a.created_at DESC
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `;

  const [countRow] = await sql`
    SELECT COUNT(*) as total FROM admission_applications
    WHERE school_id = ${schoolId} AND deleted_at IS NULL
  `;

  sendSuccess(res, schoolId, {
    applications: applications.map(presentApplication),
    total: Number(countRow?.total || 0),
    limit: Number(limit),
    offset: Number(offset),
  });
}));

router.post('/applications/bulk', requireAuth, requireAnyPermission(['admissions.edit', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { ids, action, confirm, assignedStaffId, targetStatus, remarks } = req.body || {};
  if (!confirm) {
    return res.status(400).json({ error: 'Bulk actions require confirm: true' });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return res.status(400).json({ error: 'Provide 1-100 application ids' });
  }

  const results = [];
  for (const id of ids) {
    try {
      if (action === 'assign') {
        await sql`
          UPDATE admission_applications
          SET assigned_staff_id = ${assignedStaffId || null}, updated_at = now()
          WHERE id = ${id} AND school_id = ${schoolId} AND deleted_at IS NULL
        `;
      } else if (action === 'remind') {
        const [app] = await sql`SELECT applicant_user_id, application_no, status FROM admission_applications WHERE id = ${id} AND school_id = ${schoolId}`;
        if (app?.applicant_user_id) {
          await sendAdmissionNotification({
            schoolId,
            applicationId: id,
            recipientUserId: app.applicant_user_id,
            type: 'ADMISSION_REMINDER',
            params: { application_no: app.application_no, status: app.status },
            subject: `Reminder: ${app.application_no}`,
            message: `Please complete the next step for application ${app.application_no}.`,
          });
        }
      } else if (action === 'transition' && targetStatus) {
        await transitionApplicationStage(schoolId, id, targetStatus, {
          actorId: req.user.internal_id || req.user.id,
          actorRole: req.user.roles?.[0] || 'staff',
          remarks: remarks || 'Bulk transition',
        });
      } else {
        throw httpError('Unsupported bulk action', 400);
      }
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  sendSuccess(res, schoolId, { results, message: 'Bulk action completed' });
}));

router.get('/export', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const type = String(req.query.type || 'applications');
  let rows = [];
  if (type === 'waitlist') {
    rows = await sql`
      SELECT a.application_no, a.student_first_name, a.student_last_name, a.status, a.waitlist_rank, c.name as class_name
      FROM admission_applications a
      LEFT JOIN classes c ON a.applying_class_id = c.id
      WHERE a.school_id = ${schoolId} AND a.deleted_at IS NULL AND a.status = 'WAITLISTED'
      ORDER BY a.waitlist_rank ASC NULLS LAST
    `;
  } else if (type === 'enquiries') {
    rows = await sql`
      SELECT enquiry_no, parent_name, student_name, phone, email, source, status, created_at
      FROM admission_enquiries WHERE school_id = ${schoolId} ORDER BY created_at DESC LIMIT 5000
    `;
  } else {
    rows = await sql`
      SELECT a.application_no, a.student_first_name, a.student_last_name, a.status, a.decision,
             a.father_name, a.father_phone, c.name as class_name, a.created_at
      FROM admission_applications a
      LEFT JOIN classes c ON a.applying_class_id = c.id
      WHERE a.school_id = ${schoolId} AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC LIMIT 5000
    `;
  }

  const keys = rows[0] ? Object.keys(rows[0]) : ['application_no'];
  const csv = [keys.join(','), ...rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="admissions-${type}.csv"`);
  res.send(csv);
}));

router.get('/tasks', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const tasks = await getAdmissionTasks(schoolId, {
    status: req.query.status || null,
    applicationId: req.query.applicationId || null,
    isSlaBreached: req.query.isSlaBreached === 'true' ? true : null,
  });
  sendSuccess(res, schoolId, { tasks });
}));

/**
 * GET /api/v1/admissions/applications/:id
 * Full application dossier for staff review
 */
router.get('/applications/:id', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;

  const [app] = await sql`
    SELECT a.*, c.name as class_name, ay.name as academic_year_name, sec.name as section_name,
           g.name as gender_name, bg.name as blood_group_name, r.name as religion_name,
           sc.name as category_name,
           st.name as stage_name, st.color as stage_color
    FROM admission_applications a
    LEFT JOIN classes c ON a.applying_class_id = c.id
    LEFT JOIN academic_years ay ON a.academic_year_id = ay.id
    LEFT JOIN sections sec ON a.assigned_section_id = sec.id
    LEFT JOIN genders g ON a.gender_id = g.id
    LEFT JOIN blood_groups bg ON a.blood_group_id = bg.id
    LEFT JOIN religions r ON a.religion_id = r.id
    LEFT JOIN student_categories sc ON a.category_id = sc.id
    LEFT JOIN admission_workflow_stages st ON a.current_stage_id = st.id
    WHERE a.id = ${applicationId} AND a.school_id = ${schoolId} AND a.deleted_at IS NULL
  `;

  if (!app) {
    return res.status(404).json({ error: 'Application not found' });
  }

  // Documents with checklist
  const documents = presentChecklist(await getApplicationDocumentsWithChecklist(schoolId, applicationId));

  // Interviews
  const interviews = await getInterviews(schoolId, { applicationId });

  // Tasks
  const tasks = await getAdmissionTasks(schoolId, { applicationId });

  // Private internal staff notes
  const notes = await sql`
    SELECT n.*, p.display_name as author_name
    FROM admission_notes n
    JOIN users u ON n.author_id = u.id
    LEFT JOIN persons p ON u.person_id = p.id
    WHERE n.application_id = ${applicationId} AND n.school_id = ${schoolId}
    ORDER BY n.created_at DESC
  `;

  // Communication history
  const communications = await sql`
    SELECT * FROM admission_communications
    WHERE application_id = ${applicationId} AND school_id = ${schoolId}
    ORDER BY created_at DESC
  `;

  // Audit timeline
  const auditLogs = await sql`
    SELECT l.*, p.display_name as actor_name
    FROM admission_audit_logs l
    LEFT JOIN users u ON l.actor_id = u.id
    LEFT JOIN persons p ON u.person_id = p.id
    WHERE l.application_id = ${applicationId} AND l.school_id = ${schoolId}
    ORDER BY l.created_at DESC
  `;

  // Conversion readiness check
  const conversionReadiness = await validateConversionReadiness(schoolId, applicationId);

  sendSuccess(res, schoolId, {
    application: presentApplication(app),
    documents,
    interviews,
    tasks,
    notes,
    communications,
    auditLogs,
    conversionReadiness,
  });
}));

/**
 * POST /api/v1/admissions/applications/:id/transition
 * Advance workflow stage
 */
router.post('/applications/:id/transition', requireAuth, requireAnyPermission(['admissions.edit', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const { targetStatus, remarks = '', isOverride = false } = req.body;

  if (!targetStatus) {
    return res.status(400).json({ error: 'targetStatus is required' });
  }

  const updated = await transitionApplicationStage(schoolId, applicationId, targetStatus, {
    actorId: req.user.internal_id || req.user.id,
    actorRole: req.user.roles?.[0] || 'staff',
    remarks,
    isOverride,
  });

  sendSuccess(res, schoolId, {
    application: updated,
    message: `Application transitioned to ${targetStatus}`,
  });
}));

/**
 * POST /api/v1/admissions/applications/:id/verify-document
 * Approve or reject an uploaded document
 */
router.post('/applications/:id/verify-document', requireAuth, requireAnyPermission(['admissions.verify', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const { documentId, status, rejectionReason, replacementRequested } = req.body;

  if (!documentId || !status) {
    return res.status(400).json({ error: 'documentId and status are required' });
  }

  const reviewed = await reviewDocument(schoolId, applicationId, documentId, {
    status,
    verifiedByUserId: req.user.internal_id || req.user.id,
    rejectionReason,
    replacementRequested,
  });

  // Automatically notify applicant if document was rejected
  if (status === 'REJECTED') {
    const [app] = await sql`SELECT applicant_user_id FROM admission_applications WHERE id = ${applicationId}`;
    if (app?.applicant_user_id) {
      await sendAdmissionNotification({
        schoolId,
        applicationId,
        recipientUserId: app.applicant_user_id,
        type: 'ADMISSION_DOC_REJECTED',
        params: { doc_name: reviewed.title, reason: rejectionReason || 'Re-upload requested' },
        subject: `Document Re-upload Required: ${reviewed.title}`,
        message: `Your document "${reviewed.title}" was not verified. Reason: ${rejectionReason || 'Please provide a clear image'}. Please log in to replace it.`,
      });
    }
  }

  sendSuccess(res, schoolId, {
    document: reviewed,
    message: `Document marked as ${status}`,
  });
}));

/**
 * POST /api/v1/admissions/applications/:id/schedule-interview
 * Schedule interview slot
 */
router.post('/applications/:id/schedule-interview', requireAuth, requireAnyPermission(['admissions.schedule', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const {
    interviewType, title, scheduledDate, startTime, endTime,
    location, mode, onlineMeetingUrl, interviewerId,
  } = req.body;

  if (!scheduledDate || !startTime || !endTime) {
    return res.status(400).json({ error: 'scheduledDate, startTime, and endTime are required' });
  }

  const interview = await scheduleInterview(schoolId, applicationId, {
    interviewType,
    title,
    scheduledDate,
    startTime,
    endTime,
    location,
    mode,
    onlineMeetingUrl,
    interviewerId: interviewerId || req.user.internal_id || req.user.id,
  });

  // Notify applicant of scheduled interaction
  const [app] = await sql`SELECT applicant_user_id, application_no FROM admission_applications WHERE id = ${applicationId}`;
  if (app?.applicant_user_id) {
    await sendAdmissionNotification({
      schoolId,
      applicationId,
      recipientUserId: app.applicant_user_id,
      type: 'ADMISSION_INTERVIEW_SCHEDULED',
      params: { date: scheduledDate, time: startTime },
      subject: `Interview Scheduled: ${title || 'Interaction'}`,
      message: `Your admission interaction has been scheduled for ${scheduledDate} at ${startTime} (${location || 'School Office'}).`,
    });
  }

  sendSuccess(res, schoolId, {
    interview,
    message: 'Interview scheduled successfully',
  }, 201);
}));

/**
 * POST /api/v1/admissions/applications/:id/evaluate-interview
 * Submit rubric evaluation for interview
 */
router.post('/applications/:id/evaluate-interview', requireAuth, requireAnyPermission(['admissions.schedule', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { interviewId, rubricScores, recommendation, feedback } = req.body;

  if (!interviewId) {
    return res.status(400).json({ error: 'interviewId is required' });
  }

  const evaluated = await evaluateInterview(schoolId, interviewId, {
    rubricScores,
    recommendation,
    feedback,
    evaluatedByUserId: req.user.internal_id || req.user.id,
  });

  sendSuccess(res, schoolId, {
    interview: evaluated,
    message: 'Evaluation submitted successfully',
  });
}));

/**
 * POST /api/v1/admissions/applications/:id/decision
 * Record management admission decision (Approve, Conditional, Waitlist, Reject)
 */
router.post('/applications/:id/decision', requireAuth, requireAnyPermission(['admissions.approve', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const { decision, decisionReason = '', conditionalRequirements = '' } = req.body;

  if (!['APPROVED', 'CONDITIONALLY_APPROVED', 'WAITLISTED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: 'Invalid admission decision' });
  }

  let nextStatus = decision;
  if (decision === 'APPROVED') nextStatus = WORKFLOW_STATUSES.APPROVED;

  const updated = await transitionApplicationStage(schoolId, applicationId, nextStatus, {
    actorId: req.user.internal_id || req.user.id,
    actorRole: req.user.roles?.[0] || 'management',
    remarks: decisionReason || `Decision: ${decision}`,
    isOverride: true,
  });

  await sql`
    UPDATE admission_applications
    SET decision = ${decision},
        decision_reason = ${decisionReason},
        conditional_requirements = ${conditionalRequirements},
        decision_by = ${req.user.internal_id || req.user.id},
        decision_at = now(),
        updated_at = now()
    WHERE id = ${applicationId} AND school_id = ${schoolId}
  `;

  if (decision === 'WAITLISTED') {
    const [rankRow] = await sql`
      SELECT COALESCE(MAX(waitlist_rank), 0) + 1 as next_rank
      FROM admission_applications
      WHERE school_id = ${schoolId} AND applying_class_id = ${updated.applying_class_id} AND status = 'WAITLISTED'
    `;
    await sql`
      UPDATE admission_applications
      SET waitlist_rank = ${rankRow.next_rank}
      WHERE id = ${applicationId} AND school_id = ${schoolId}
    `;
    try {
      await sql`
        INSERT INTO admission_waitlist (school_id, application_id, class_id, academic_year_id, rank, reason)
        VALUES (${schoolId}, ${applicationId}, ${updated.applying_class_id}, ${updated.academic_year_id}, ${rankRow.next_rank}, ${decisionReason || null})
        ON CONFLICT (school_id, application_id)
        DO UPDATE SET rank = EXCLUDED.rank, reason = EXCLUDED.reason, updated_at = now()
      `;
    } catch {
      // waitlist table optional until hardening migration
    }
  }

  await sql`
    INSERT INTO admission_audit_logs (
      school_id, application_id, actor_id, actor_role, action,
      to_state, reason, details
    )
    VALUES (
      ${schoolId}, ${applicationId}, ${req.user.internal_id || req.user.id}, 'management',
      'DECISION_MADE', ${decision}, ${decisionReason || 'Admission decision recorded'},
      ${sql.json({ decision, conditionalRequirements })}
    )
  `;

  const notifyType = decision === 'REJECTED'
    ? 'ADMISSION_REJECTED'
    : decision === 'WAITLISTED'
      ? 'ADMISSION_WAITLISTED'
      : 'ADMISSION_APPROVED';

  if (updated.applicant_user_id) {
    await sendAdmissionNotification({
      schoolId,
      applicationId,
      recipientUserId: updated.applicant_user_id,
      type: notifyType,
      params: { application_no: updated.application_no },
      subject: `Admission Decision: Application ${decision}`,
      message: `Your admission application has been ${decision.toLowerCase().replace('_', ' ')}. ${decisionReason}`,
    });
  }

  sendSuccess(res, schoolId, {
    application: presentApplication(updated),
    message: `Decision recorded: ${decision}`,
  });
}));

/**
 * POST /api/v1/admissions/applications/:id/convert
 * Transactional conversion from Applicant to official Student
 */
router.post('/applications/:id/convert', requireAuth, requireAnyPermission(['admissions.convert', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const { custom_admission_no, section_id, roll_number, admission_date } = req.body;

  const result = await convertApplicantToStudent(
    schoolId,
    applicationId,
    req.user.internal_id || req.user.id,
    { custom_admission_no, section_id, roll_number, admission_date }
  );

  sendSuccess(res, schoolId, {
    ...result,
    message: `Applicant successfully converted to Student with Admission No: ${result.admissionNo}`,
  });
}));

/**
 * POST /api/v1/admissions/applications/:id/notes
 * Add internal staff note (private to staff)
 */
router.post('/applications/:id/notes', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const { note, priority = 'NORMAL' } = req.body;

  if (!note?.trim()) {
    return res.status(400).json({ error: 'Note content is required' });
  }

  const [createdNote] = await sql`
    INSERT INTO admission_notes (
      school_id, application_id, author_id, note, priority, is_private
    )
    VALUES (
      ${schoolId}, ${applicationId}, ${req.user.internal_id || req.user.id},
      ${note.trim()}, ${priority}, true
    )
    RETURNING *
  `;

  sendSuccess(res, schoolId, { note: createdNote, message: 'Note added' }, 201);
}));

/**
 * POST /api/v1/admissions/applications/:id/messages
 * Send message to applicant
 */
router.post('/applications/:id/messages', requireAuth, requireAnyPermission(['admissions.edit', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const { subject, message, messageType = 'GENERAL_MESSAGE' } = req.body;

  if (!subject?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'Subject and message are required' });
  }

  const [app] = await sql`
    SELECT applicant_user_id FROM admission_applications
    WHERE id = ${applicationId} AND school_id = ${schoolId}
  `;

  await sendAdmissionNotification({
    schoolId,
    applicationId,
    recipientUserId: app?.applicant_user_id || null,
    type: messageType,
    subject: subject.trim(),
    message: message.trim(),
  });

  sendSuccess(res, schoolId, { message: 'Message sent to applicant' });
}));

router.post('/applications/:id/merge', requireAuth, requireAnyPermission(['admissions.approve', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { sourceApplicationId, confirm } = req.body || {};
  if (!confirm) {
    return res.status(400).json({ error: 'Merge requires confirm: true' });
  }
  const result = await mergeDuplicateApplications(
    schoolId,
    req.params.id,
    sourceApplicationId,
    req.user.internal_id || req.user.id
  );
  sendSuccess(res, schoolId, {
    application: presentApplication(result.primary),
    mergedFrom: result.mergedFrom,
    message: `Merged ${result.mergedFrom} into the current application`,
  });
}));

router.post('/applications/:id/waitlist/promote', requireAuth, requireAnyPermission(['admissions.approve', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const applicationId = req.params.id;
  const updated = await transitionApplicationStage(schoolId, applicationId, WORKFLOW_STATUSES.APPROVED, {
    actorId: req.user.internal_id || req.user.id,
    actorRole: 'management',
    remarks: req.body?.reason || 'Promoted from waitlist',
    isOverride: true,
  });
  await sql`
    UPDATE admission_applications
    SET decision = 'APPROVED', waitlist_rank = NULL, updated_at = now()
    WHERE id = ${applicationId} AND school_id = ${schoolId}
  `;
  try {
    await sql`
      UPDATE admission_waitlist
      SET promoted_at = now(), promoted_by = ${req.user.internal_id || req.user.id}, updated_at = now()
      WHERE application_id = ${applicationId} AND school_id = ${schoolId}
    `;
  } catch { /* optional table */ }

  if (updated.applicant_user_id) {
    await sendAdmissionNotification({
      schoolId,
      applicationId,
      recipientUserId: updated.applicant_user_id,
      type: 'ADMISSION_APPROVED',
      params: { application_no: updated.application_no },
      subject: 'A seat is now available',
      message: `A seat is now available for application ${updated.application_no}. Please complete admission confirmation.`,
    });
  }
  sendSuccess(res, schoolId, { application: presentApplication(updated), message: 'Applicant promoted from waitlist' });
}));

router.post('/applications/:id/fee-paid', requireAuth, requireAnyPermission(['admissions.edit', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const updated = await transitionApplicationStage(schoolId, req.params.id, WORKFLOW_STATUSES.FEE_PAID, {
    actorId: req.user.internal_id || req.user.id,
    actorRole: 'accounts',
    remarks: req.body?.remarks || 'Admission fee confirmed',
  });
  sendSuccess(res, schoolId, { application: presentApplication(updated), message: 'Fee marked as paid' });
}));
router.get('/analytics', requireAuth, requireAnyPermission(['admissions.view', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const { academicYearId } = req.query;

  // Run SLA breach scan first so metrics are fresh
  await scanAndFlagSlaBreaches(schoolId);

  const analytics = await getAdmissionAnalytics(schoolId, academicYearId);
  sendSuccess(res, schoolId, analytics);
}));

/**
 * GET /api/v1/admissions/settings
 * Workflow and document settings
 */
router.get('/settings', requireAuth, requireAnyPermission(['admissions.settings', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;

  const [settings] = await sql`
    SELECT * FROM admission_settings WHERE school_id = ${schoolId}
  `;
  const stages = await sql`
    SELECT id, code, name, description, sequence_order, is_mandatory, is_active,
           requires_approval, requires_documents, requires_interview, requires_test, requires_fee,
           responsible_role, sla_hours, color
    FROM admission_workflow_stages
    WHERE school_id = ${schoolId}
    ORDER BY sequence_order ASC
  `;
  const docRequirements = await getDocumentRequirements(schoolId);

  const capacities = await sql`
    SELECT c.id as class_id, c.name as class_name,
           COALESCE(cap.total_capacity, 40) as max_capacity,
           COALESCE(cap.total_capacity, 40) as total_capacity,
           COUNT(a.id) FILTER (WHERE a.status = 'CONVERTED_TO_STUDENT') as enrolled_count
    FROM classes c
    LEFT JOIN admission_capacities cap ON cap.class_id = c.id AND cap.school_id = ${schoolId}
    LEFT JOIN admission_applications a ON a.applying_class_id = c.id AND a.school_id = ${schoolId} AND a.deleted_at IS NULL
    WHERE c.school_id = ${schoolId} AND c.deleted_at IS NULL
    GROUP BY c.id, c.name, cap.total_capacity
    ORDER BY c.name
  `;

  sendSuccess(res, schoolId, {
    settings: {
      ...(settings || {}),
      admission_number_pattern: settings?.admission_number_format,
      default_sla_hours_per_stage: settings?.default_sla_hours_per_stage || 48,
    },
    workflowStages: stages,
    documentRequirements: (docRequirements || []).map((d) => ({
      ...d,
      title: d.display_name,
      code: d.document_type,
    })),
    capacities,
  });
}));

/**
 * PUT /api/v1/admissions/settings
 * Update workflow and document settings
 */
router.put('/settings', requireAuth, requireAnyPermission(['admissions.settings', 'admin.manage']), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const body = req.body?.settings || req.body || {};
  const {
    is_admission_open,
    admission_number_prefix,
    admission_number_format,
    admission_number_pattern,
    application_fee,
    allow_online_payment,
    sla_rules,
    scoring_weights,
    default_sla_hours_per_stage,
  } = body;
  const format = admission_number_format || admission_number_pattern || 'ADM/YY/NNNN';

  const [updated] = await sql`
    INSERT INTO admission_settings (
      school_id, is_admission_open, admission_number_prefix, admission_number_format,
      application_fee, allow_online_payment, sla_rules, scoring_weights, updated_at
    )
    VALUES (
      ${schoolId},
      ${is_admission_open !== undefined ? is_admission_open : true},
      ${admission_number_prefix || 'ADM'},
      ${format},
      ${application_fee || 0.00},
      ${allow_online_payment || false},
      ${sla_rules ? sql.json(sla_rules) : sql`'{}'::jsonb`},
      ${scoring_weights ? sql.json(scoring_weights) : sql`'{}'::jsonb`},
      now()
    )
    ON CONFLICT (school_id)
    DO UPDATE SET
      is_admission_open = EXCLUDED.is_admission_open,
      admission_number_prefix = EXCLUDED.admission_number_prefix,
      admission_number_format = EXCLUDED.admission_number_format,
      application_fee = EXCLUDED.application_fee,
      allow_online_payment = EXCLUDED.allow_online_payment,
      sla_rules = EXCLUDED.sla_rules,
      scoring_weights = EXCLUDED.scoring_weights,
      updated_at = now()
    RETURNING *
  `;

  try {
    if (default_sla_hours_per_stage != null) {
      await sql`
        UPDATE admission_settings
        SET default_sla_hours_per_stage = ${Number(default_sla_hours_per_stage) || 48}
        WHERE school_id = ${schoolId}
      `;
    }
  } catch { /* column added in hardening migration */ }

  const capacities = req.body?.capacities || [];
  const [activeYear] = await sql`
    SELECT id FROM academic_years WHERE school_id = ${schoolId} AND now() BETWEEN start_date AND end_date LIMIT 1
  `;
  for (const cap of capacities) {
    if (!cap.class_id) continue;
    await sql`
      INSERT INTO admission_capacities (school_id, class_id, academic_year_id, total_capacity)
      VALUES (${schoolId}, ${cap.class_id}, ${activeYear?.id || null}, ${Number(cap.max_capacity || cap.total_capacity || 40)})
      ON CONFLICT (school_id, class_id, academic_year_id)
      DO UPDATE SET total_capacity = EXCLUDED.total_capacity, updated_at = now()
    `;
  }

  const docs = req.body?.documentRequirements || [];
  for (const doc of docs) {
    if (!doc.id && !doc.document_type && !doc.code) continue;
    await sql`
      UPDATE admission_document_requirements
      SET is_mandatory = ${Boolean(doc.is_mandatory)},
          display_name = COALESCE(${doc.title || doc.display_name || null}, display_name)
      WHERE school_id = ${schoolId}
        AND (id = ${doc.id || null} OR document_type = ${doc.document_type || doc.code || null})
    `;
  }

  const stages = req.body?.workflowStages || [];
  for (const stage of stages) {
    if (!stage.id && !stage.code) continue;
    await sql`
      UPDATE admission_workflow_stages
      SET is_active = COALESCE(${stage.is_active}, is_active),
          is_mandatory = COALESCE(${stage.is_mandatory}, is_mandatory),
          sla_hours = COALESCE(${stage.sla_hours}, sla_hours)
      WHERE school_id = ${schoolId}
        AND (id = ${stage.id || null} OR code = ${stage.code || null})
    `;
  }

  sendSuccess(res, schoolId, { settings: updated, message: 'Settings updated successfully' });
}));

export default router;
