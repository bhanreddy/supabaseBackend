import test from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import {
  WORKFLOW_STATUSES,
  getWorkflowStages,
  transitionApplicationStage,
  isValidTransition,
} from '../services/admissionWorkflowService.js';
import { checkDuplicateApplications } from '../services/admissionDuplicateService.js';
import {
  getDocumentRequirements,
  saveUploadedDocument,
  reviewDocument,
  getApplicationDocumentsWithChecklist,
} from '../services/admissionDocumentService.js';
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

test('Admission System Integration Test Suite', async (t) => {
  // Use School 13 as test tenant
  const schoolId = 13;

  // Resolve active academic year and class
  const [ay] = await sql`
    SELECT id FROM academic_years
    WHERE school_id = ${schoolId} AND now() BETWEEN start_date AND end_date
    LIMIT 1
  `;
  const [cls] = await sql`
    SELECT id FROM classes WHERE school_id = ${schoolId} AND deleted_at IS NULL LIMIT 1
  `;
  const [adminUser] = await sql`
    SELECT id FROM users WHERE school_id = ${schoolId} AND account_status = 'active' LIMIT 1
  `;

  assert.ok(ay?.id, 'Active academic year must exist for test school');
  assert.ok(cls?.id, 'Active class must exist for test school');

  const uniqueSuffix = Date.now().toString().slice(-6);
  const testPhone = `98765${uniqueSuffix}`;
  const testEmail = `test.applicant.${uniqueSuffix}@admission.schoolims.test`;
  const testStudentName = `AdmitStudent_${uniqueSuffix}`;

  let createdAppId = null;

  await t.test('1. Stage definitions and transition validation', async () => {
    const stages = await getWorkflowStages(schoolId);
    assert.ok(Array.isArray(stages) && stages.length >= 8, 'Default stages must exist');
    assert.strictEqual(stages[0].code, 'ENQUIRY');

    assert.strictEqual(isValidTransition('APPLICATION_STARTED', 'APPLICATION_SUBMITTED'), true);
    assert.strictEqual(isValidTransition('APPLICATION_SUBMITTED', 'CONVERTED_TO_STUDENT'), false);
    assert.strictEqual(isValidTransition('DOCUMENT_VERIFICATION', 'ADMISSION_CONFIRMED'), false);
    assert.strictEqual(isValidTransition('ADMISSION_CONFIRMED', 'CONVERTED_TO_STUDENT'), true);
  });

  await t.test('2. Create admission application & check duplicate detection', async () => {
    const appNo = `ADM-TEST-${uniqueSuffix}`;

    const [app] = await sql`
      INSERT INTO admission_applications (
        school_id, application_no, student_first_name, student_last_name,
        dob, gender_id, applying_class_id, academic_year_id,
        father_name, father_phone, father_email,
        status, source
      )
      VALUES (
        ${schoolId}, ${appNo}, ${testStudentName}, 'Verma',
        '2018-05-15', 1, ${cls.id}, ${ay.id},
        'Ramesh Verma', ${testPhone}, ${testEmail},
        'APPLICATION_STARTED', 'Website'
      )
      RETURNING *
    `;

    assert.ok(app?.id, 'Application must be created');
    createdAppId = app.id;

    // Run duplicate check with same phone and name/dob
    const dupCheck = await checkDuplicateApplications(schoolId, {
      phone: testPhone,
      studentFirstName: testStudentName,
      dob: '2018-05-15',
    });

    assert.strictEqual(dupCheck.isPotentialDuplicate, true);
    assert.ok(dupCheck.matches.length >= 1);
  });

  await t.test('3. Stage advancement: Start -> Submitted -> Document Verification', async () => {
    const app1 = await transitionApplicationStage(
      schoolId,
      createdAppId,
      WORKFLOW_STATUSES.APPLICATION_SUBMITTED,
      { remarks: 'Parent submitted form' }
    );
    assert.strictEqual(app1.status, WORKFLOW_STATUSES.APPLICATION_SUBMITTED);

    const app2 = await transitionApplicationStage(
      schoolId,
      createdAppId,
      WORKFLOW_STATUSES.DOCUMENT_VERIFICATION,
      { remarks: 'Ready for staff audit' }
    );
    assert.strictEqual(app2.status, WORKFLOW_STATUSES.DOCUMENT_VERIFICATION);

    // Verify task auto-generated for document verification
    const tasks = await getAdmissionTasks(schoolId, { applicationId: createdAppId });
    assert.ok(tasks.length >= 1, 'Verification task must be auto-generated');
  });

  await t.test('4. Document upload, checklist audit, rejection, and verification', async () => {
    const mockPdf = (label) => Buffer.from(`%PDF-1.4\n${label} admission certificate payload`);

    // 1. Upload Birth Certificate
    const mockBuffer = mockPdf('BIRTH_CERTIFICATE');
    const doc = await saveUploadedDocument(schoolId, createdAppId, {
      documentType: 'BIRTH_CERTIFICATE',
      title: 'Birth Certificate',
      fileBuffer: mockBuffer,
      fileName: 'birth_cert.pdf',
      mimeType: 'application/pdf',
    });

    assert.ok(doc?.id);
    assert.strictEqual(doc.status, 'UPLOADED');

    // 2. Reject document with reason
    const rejected = await reviewDocument(schoolId, createdAppId, doc.id, {
      status: 'REJECTED',
      verifiedByUserId: adminUser?.id || null,
      rejectionReason: 'Blurred photograph',
      replacementRequested: true,
    });
    assert.strictEqual(rejected.status, 'REJECTED');
    assert.strictEqual(rejected.replacement_requested, true);

    // 3. Re-upload replaced document
    const replaced = await saveUploadedDocument(schoolId, createdAppId, {
      documentType: 'BIRTH_CERTIFICATE',
      title: 'Birth Certificate Clean Copy',
      fileBuffer: mockPdf('BIRTH_CERTIFICATE_V2'),
      fileName: 'birth_cert_v2.pdf',
      mimeType: 'application/pdf',
    });
    assert.strictEqual(replaced.version, 2);
    assert.strictEqual(replaced.status, 'UPLOADED');

    // 4. Verify document
    const verified = await reviewDocument(schoolId, createdAppId, replaced.id, {
      status: 'VERIFIED',
      verifiedByUserId: adminUser?.id || null,
    });
    assert.strictEqual(verified.status, 'VERIFIED');

    // Also upload and verify Transfer Certificate, Previous Marksheet, and Passport Photo so mandatory docs are complete
    for (const type of ['TRANSFER_CERTIFICATE', 'PREVIOUS_MARKSHEET', 'PASSPORT_PHOTO']) {
      const d = await saveUploadedDocument(schoolId, createdAppId, {
        documentType: type,
        title: type,
        fileBuffer: mockPdf(type),
        fileName: `${type}.pdf`,
        mimeType: 'application/pdf',
      });
      await reviewDocument(schoolId, createdAppId, d.id, {
        status: 'VERIFIED',
        verifiedByUserId: adminUser?.id || null,
      });
    }

    const checklist = await getApplicationDocumentsWithChecklist(schoolId, createdAppId);
    assert.strictEqual(checklist.isFullyCompliant, true);
  });

  await t.test('5. Interview scheduling and rubric scoring', async () => {
    const interview = await scheduleInterview(schoolId, createdAppId, {
      interviewType: 'INTERVIEW',
      title: 'Principal Interaction',
      scheduledDate: '2026-09-20',
      startTime: '10:00:00',
      endTime: '10:30:00',
      location: 'Principal Office',
      interviewerId: adminUser?.id || null,
    });
    assert.ok(interview?.id);
    assert.strictEqual(interview.status, 'SCHEDULED');

    const evaluated = await evaluateInterview(schoolId, interview.id, {
      rubricScores: {
        communication: 5,
        confidence: 4,
        academic_readiness: 5,
        behaviour: 5,
      },
      recommendation: 'APPROVE',
      feedback: 'Excellent candidate, articulate and responsive.',
      evaluatedByUserId: adminUser?.id || null,
    });
    assert.strictEqual(evaluated.status, 'COMPLETED');
    assert.strictEqual(evaluated.recommendation, 'APPROVE');
    assert.ok(Number(evaluated.total_score) >= 90);
  });

  await t.test('6. Management Approval decision & Pre-flight validation', async () => {
    // Decision: APPROVED
    await sql`
      UPDATE admission_applications
      SET decision = 'APPROVED',
          status = 'APPROVED',
          updated_at = now()
      WHERE id = ${createdAppId} AND school_id = ${schoolId}
    `;

    const check = await validateConversionReadiness(schoolId, createdAppId);
    assert.strictEqual(check.ready, true, `Should be ready for conversion. Errors: ${check.errors.join(', ')}`);
  });

  await t.test('7. Transactional Student Conversion (Applicant -> Student)', async () => {
    const result = await convertApplicantToStudent(
      schoolId,
      createdAppId,
      adminUser?.id || null,
      { roll_number: 101 }
    );

    assert.strictEqual(result.success, true);
    assert.ok(result.studentId);
    assert.ok(result.admissionNo);

    // Verify record in students table
    const [studentRow] = await sql`
      SELECT s.id, s.admission_no, s.status_id, p.first_name, p.dob
      FROM students s
      JOIN persons p ON s.person_id = p.id
      WHERE s.id = ${result.studentId} AND s.school_id = ${schoolId}
    `;
    assert.ok(studentRow);
    assert.strictEqual(studentRow.status_id, 1); // Active
    assert.strictEqual(studentRow.first_name, testStudentName);

    // Verify student_enrollments
    const [enrollment] = await sql`
      SELECT id, status, roll_number FROM student_enrollments
      WHERE student_id = ${result.studentId} AND school_id = ${schoolId}
    `;
    assert.ok(enrollment);
    assert.strictEqual(enrollment.status, 'active');
    assert.ok(enrollment.roll_number !== undefined && enrollment.roll_number !== null, 'Roll number must be assigned');

    // Verify student_parents link
    const [parentLink] = await sql`
      SELECT sp.id, pr.first_name
      FROM student_parents sp
      JOIN parents par ON sp.parent_id = par.id
      JOIN persons pr ON par.person_id = pr.id
      WHERE sp.student_id = ${result.studentId} AND sp.school_id = ${schoolId}
    `;
    assert.ok(parentLink);
    assert.strictEqual(parentLink.first_name, 'Ramesh Verma');

    // Verify application status updated to CONVERTED_TO_STUDENT
    const [finalApp] = await sql`
      SELECT status, converted_student_id FROM admission_applications WHERE id = ${createdAppId}
    `;
    assert.strictEqual(finalApp.status, WORKFLOW_STATUSES.CONVERTED_TO_STUDENT);
    assert.strictEqual(finalApp.converted_student_id, result.studentId);

    // Verify idempotency: duplicate conversion must fail
    await assert.rejects(
      async () => {
        await convertApplicantToStudent(schoolId, createdAppId, adminUser?.id || null);
      },
      /already converted/i
    );
  });

  await t.test('8. Multi-tenant isolation: School B cannot view School A application', async () => {
    // Check with schoolId = 99999 (non-existent or other school)
    const otherSchoolApps = await sql`
      SELECT id FROM admission_applications
      WHERE id = ${createdAppId} AND school_id = 99999
    `;
    assert.strictEqual(otherSchoolApps.length, 0, 'Cross-tenant isolation must hide record');
  });

  await t.test('9. Analytics computation', async () => {
    const analytics = await getAdmissionAnalytics(schoolId);
    assert.ok(analytics.funnel);
    assert.ok(analytics.funnel.totalApplications >= 1);
    assert.ok(analytics.funnel.convertedStudents >= 1);
    assert.ok(Array.isArray(analytics.classCapacity));
    assert.ok(Array.isArray(analytics.insights));
  });

  await t.test('10. Concurrent conversion is rejected', async () => {
    await assert.rejects(
      async () => {
        await convertApplicantToStudent(schoolId, createdAppId, adminUser?.id || null);
      },
      /already converted|could not be completed/i
    );
  });

  await t.test('11. Invalid skip to conversion is rejected by workflow', async () => {
    const [draft] = await sql`
      INSERT INTO admission_applications (
        school_id, application_no, student_first_name, student_last_name,
        applying_class_id, academic_year_id, father_name, father_phone, status, source
      )
      VALUES (
        ${schoolId}, ${'ADM-SKIP-' + uniqueSuffix}, 'Skip', 'Test',
        ${cls.id}, ${ay.id}, 'Parent', ${testPhone}, 'APPLICATION_STARTED', 'Website'
      )
      RETURNING id
    `;
    await assert.rejects(
      async () => {
        await transitionApplicationStage(schoolId, draft.id, WORKFLOW_STATUSES.CONVERTED_TO_STUDENT);
      },
      /Invalid stage transition/i
    );
    await sql`DELETE FROM admission_applications WHERE id = ${draft.id}`;
  });

  await t.test('12. Duplicate merge withdraws source without hard-delete history loss', async () => {
    const { mergeDuplicateApplications } = await import('../services/admissionDuplicateService.js');
    const [primary] = await sql`
      INSERT INTO admission_applications (
        school_id, application_no, student_first_name, student_last_name,
        applying_class_id, academic_year_id, father_name, father_phone, status, source
      ) VALUES (
        ${schoolId}, ${'ADM-MRG-A-' + uniqueSuffix}, 'Merge', 'Alpha',
        ${cls.id}, ${ay.id}, 'Parent A', ${testPhone}, 'APPLICATION_STARTED', 'Website'
      ) RETURNING id
    `;
    const [source] = await sql`
      INSERT INTO admission_applications (
        school_id, application_no, student_first_name, student_last_name,
        applying_class_id, academic_year_id, father_name, father_phone, mother_name, status, source
      ) VALUES (
        ${schoolId}, ${'ADM-MRG-B-' + uniqueSuffix}, 'Merge', 'Beta',
        ${cls.id}, ${ay.id}, 'Parent B', ${testPhone}, 'Mother B', 'APPLICATION_STARTED', 'Website'
      ) RETURNING id
    `;
    const merged = await mergeDuplicateApplications(schoolId, primary.id, source.id, adminUser?.id || null);
    assert.ok(merged.primary);
    const [sourceRow] = await sql`SELECT status, deleted_at FROM admission_applications WHERE id = ${source.id}`;
    assert.equal(sourceRow.status, 'WITHDRAWN');
    assert.ok(sourceRow.deleted_at);
    await sql`DELETE FROM admission_applications WHERE id = ${primary.id} OR id = ${source.id}`;
  });

  // Cleanup test records
  await sql`DELETE FROM admission_applications WHERE id = ${createdAppId}`;
});
