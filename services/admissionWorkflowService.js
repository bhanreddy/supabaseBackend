import sql from '../db.js';
import logger from '../utils/logger.js';

export const WORKFLOW_STATUSES = Object.freeze({
  ENQUIRY_CREATED: 'ENQUIRY_CREATED',
  APPLICATION_STARTED: 'APPLICATION_STARTED',
  APPLICATION_INCOMPLETE: 'APPLICATION_INCOMPLETE',
  APPLICATION_SUBMITTED: 'APPLICATION_SUBMITTED',
  DOCUMENT_COLLECTION: 'DOCUMENT_COLLECTION',
  DOCUMENT_VERIFICATION: 'DOCUMENT_VERIFICATION',
  VERIFICATION_REQUIRED: 'VERIFICATION_REQUIRED',
  VERIFICATION_COMPLETED: 'VERIFICATION_COMPLETED',
  INTERVIEW_SCHEDULED: 'INTERVIEW_SCHEDULED',
  INTERVIEW_COMPLETED: 'INTERVIEW_COMPLETED',
  TEST_SCHEDULED: 'TEST_SCHEDULED',
  TEST_COMPLETED: 'TEST_COMPLETED',
  APPLICATION_UNDER_REVIEW: 'APPLICATION_UNDER_REVIEW',
  APPROVED: 'APPROVED',
  WAITLISTED: 'WAITLISTED',
  CONDITIONALLY_APPROVED: 'CONDITIONALLY_APPROVED',
  FEE_PENDING: 'FEE_PENDING',
  FEE_PAID: 'FEE_PAID',
  ADMISSION_CONFIRMED: 'ADMISSION_CONFIRMED',
  CONVERTED_TO_STUDENT: 'CONVERTED_TO_STUDENT',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
  EXPIRED: 'EXPIRED',
});

// Allowed state transitions map
const VALID_TRANSITIONS = {
  [WORKFLOW_STATUSES.ENQUIRY_CREATED]: [
    WORKFLOW_STATUSES.APPLICATION_STARTED,
    WORKFLOW_STATUSES.WITHDRAWN,
    WORKFLOW_STATUSES.EXPIRED,
  ],
  [WORKFLOW_STATUSES.APPLICATION_STARTED]: [
    WORKFLOW_STATUSES.APPLICATION_INCOMPLETE,
    WORKFLOW_STATUSES.APPLICATION_SUBMITTED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.APPLICATION_INCOMPLETE]: [
    WORKFLOW_STATUSES.APPLICATION_STARTED,
    WORKFLOW_STATUSES.APPLICATION_SUBMITTED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.APPLICATION_SUBMITTED]: [
    WORKFLOW_STATUSES.DOCUMENT_COLLECTION,
    WORKFLOW_STATUSES.DOCUMENT_VERIFICATION,
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.WITHDRAWN,
    WORKFLOW_STATUSES.REJECTED,
  ],
  [WORKFLOW_STATUSES.DOCUMENT_COLLECTION]: [
    WORKFLOW_STATUSES.DOCUMENT_VERIFICATION,
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.DOCUMENT_VERIFICATION]: [
    WORKFLOW_STATUSES.VERIFICATION_COMPLETED,
    WORKFLOW_STATUSES.VERIFICATION_REQUIRED,
    WORKFLOW_STATUSES.INTERVIEW_SCHEDULED,
    WORKFLOW_STATUSES.TEST_SCHEDULED,
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.REJECTED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.VERIFICATION_REQUIRED]: [
    WORKFLOW_STATUSES.DOCUMENT_COLLECTION,
    WORKFLOW_STATUSES.DOCUMENT_VERIFICATION,
    WORKFLOW_STATUSES.REJECTED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.VERIFICATION_COMPLETED]: [
    WORKFLOW_STATUSES.INTERVIEW_SCHEDULED,
    WORKFLOW_STATUSES.TEST_SCHEDULED,
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.APPROVED,
    WORKFLOW_STATUSES.WAITLISTED,
    WORKFLOW_STATUSES.CONDITIONALLY_APPROVED,
    WORKFLOW_STATUSES.REJECTED,
  ],
  [WORKFLOW_STATUSES.INTERVIEW_SCHEDULED]: [
    WORKFLOW_STATUSES.INTERVIEW_COMPLETED,
    WORKFLOW_STATUSES.INTERVIEW_SCHEDULED, // reschedule
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.INTERVIEW_COMPLETED]: [
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.APPROVED,
    WORKFLOW_STATUSES.WAITLISTED,
    WORKFLOW_STATUSES.CONDITIONALLY_APPROVED,
    WORKFLOW_STATUSES.REJECTED,
  ],
  [WORKFLOW_STATUSES.TEST_SCHEDULED]: [
    WORKFLOW_STATUSES.TEST_COMPLETED,
    WORKFLOW_STATUSES.TEST_SCHEDULED, // reschedule
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.TEST_COMPLETED]: [
    WORKFLOW_STATUSES.INTERVIEW_SCHEDULED,
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW,
    WORKFLOW_STATUSES.APPROVED,
    WORKFLOW_STATUSES.WAITLISTED,
    WORKFLOW_STATUSES.REJECTED,
  ],
  [WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW]: [
    WORKFLOW_STATUSES.APPROVED,
    WORKFLOW_STATUSES.CONDITIONALLY_APPROVED,
    WORKFLOW_STATUSES.WAITLISTED,
    WORKFLOW_STATUSES.REJECTED,
    WORKFLOW_STATUSES.DOCUMENT_COLLECTION,
    WORKFLOW_STATUSES.INTERVIEW_SCHEDULED,
  ],
  [WORKFLOW_STATUSES.CONDITIONALLY_APPROVED]: [
    WORKFLOW_STATUSES.DOCUMENT_COLLECTION,
    WORKFLOW_STATUSES.DOCUMENT_VERIFICATION,
    WORKFLOW_STATUSES.APPROVED,
    WORKFLOW_STATUSES.REJECTED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.WAITLISTED]: [
    WORKFLOW_STATUSES.APPROVED,
    WORKFLOW_STATUSES.CONDITIONALLY_APPROVED,
    WORKFLOW_STATUSES.REJECTED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.APPROVED]: [
    WORKFLOW_STATUSES.FEE_PENDING,
    WORKFLOW_STATUSES.FEE_PAID,
    WORKFLOW_STATUSES.ADMISSION_CONFIRMED,
    WORKFLOW_STATUSES.CONVERTED_TO_STUDENT,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.FEE_PENDING]: [
    WORKFLOW_STATUSES.FEE_PAID,
    WORKFLOW_STATUSES.ADMISSION_CONFIRMED,
    WORKFLOW_STATUSES.WITHDRAWN,
    WORKFLOW_STATUSES.EXPIRED,
  ],
  [WORKFLOW_STATUSES.FEE_PAID]: [
    WORKFLOW_STATUSES.ADMISSION_CONFIRMED,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.ADMISSION_CONFIRMED]: [
    WORKFLOW_STATUSES.CONVERTED_TO_STUDENT,
    WORKFLOW_STATUSES.WITHDRAWN,
  ],
  [WORKFLOW_STATUSES.CONVERTED_TO_STUDENT]: [], // Terminal state in admission lifecycle
  [WORKFLOW_STATUSES.REJECTED]: [
    WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW, // Appeal / Management override
  ],
  [WORKFLOW_STATUSES.WITHDRAWN]: [],
  [WORKFLOW_STATUSES.EXPIRED]: [
    WORKFLOW_STATUSES.APPLICATION_STARTED, // Re-open
  ],
};

/**
 * Validate whether a status transition is permitted.
 */
export function isValidTransition(fromStatus, toStatus, isManagementOverride = false) {
  if (isManagementOverride && toStatus !== WORKFLOW_STATUSES.CONVERTED_TO_STUDENT) {
    return true;
  }
  if (!fromStatus) return true;
  const allowed = VALID_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

/**
 * Retrieve all configured workflow stages for a school in sequence order.
 */
export async function getWorkflowStages(schoolId) {
  return await sql`
    SELECT id, code, name, description, sequence_order, is_mandatory, is_active,
           requires_approval, requires_documents, requires_interview, requires_test, requires_fee,
           responsible_role, sla_hours, color
    FROM admission_workflow_stages
    WHERE school_id = ${schoolId} AND is_active = true
    ORDER BY sequence_order ASC
  `;
}

/**
 * Advance or transition an admission application to a new workflow status or stage.
 */
export async function transitionApplicationStage(schoolId, applicationId, targetStatus, {
  actorId = null,
  actorRole = 'staff',
  remarks = '',
  isOverride = false,
  metadata = {},
} = {}) {
  const [app] = await sql`
    SELECT id, school_id, application_no, status, current_stage_id, sla_due_at, applying_class_id
    FROM admission_applications
    WHERE id = ${applicationId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;

  if (!app) {
    throw new Error('Application not found');
  }

  const currentStatus = app.status;
  if (!isValidTransition(currentStatus, targetStatus, isOverride)) {
    throw new Error(`Invalid stage transition from ${currentStatus} to ${targetStatus}`);
  }

  const stageLookupCode = {
    ENQUIRY_CREATED: 'ENQUIRY',
    APPLICATION_STARTED: 'APPLICATION',
    APPLICATION_INCOMPLETE: 'APPLICATION',
    APPLICATION_SUBMITTED: 'APPLICATION',
    DOCUMENT_COLLECTION: 'DOCUMENTS',
    DOCUMENT_VERIFICATION: 'VERIFICATION',
    VERIFICATION_REQUIRED: 'VERIFICATION',
    VERIFICATION_COMPLETED: 'VERIFICATION',
    INTERVIEW_SCHEDULED: 'INTERVIEW',
    INTERVIEW_COMPLETED: 'INTERVIEW',
    TEST_SCHEDULED: 'INTERVIEW',
    TEST_COMPLETED: 'INTERVIEW',
    APPLICATION_UNDER_REVIEW: 'REVIEW',
    APPROVED: 'APPROVAL',
    WAITLISTED: 'APPROVAL',
    CONDITIONALLY_APPROVED: 'APPROVAL',
    REJECTED: 'APPROVAL',
    FEE_PENDING: 'FEE_PENDING',
    FEE_PAID: 'FEE_PENDING',
    ADMISSION_CONFIRMED: 'CONFIRMED',
    CONVERTED_TO_STUDENT: 'CONFIRMED',
  }[targetStatus] || targetStatus;

  const [stage] = await sql`
    SELECT id, code, name, sla_hours, responsible_role
    FROM admission_workflow_stages
    WHERE school_id = ${schoolId}
      AND (code = ${targetStatus} OR code = ${stageLookupCode})
      AND is_active = true
    LIMIT 1
  `;

  // Compute new SLA deadline
  let slaDueAt = null;
  if (stage?.sla_hours) {
    slaDueAt = new Date(Date.now() + stage.sla_hours * 60 * 60 * 1000);
  }

  // Execute stage transition transaction with optimistic concurrency
  const result = await sql.begin(async (tx) => {
    const [updatedApp] = await tx`
      UPDATE admission_applications
      SET status = ${targetStatus},
          current_stage_id = ${stage ? stage.id : app.current_stage_id},
          sla_due_at = ${slaDueAt},
          is_sla_breached = false,
          updated_at = now()
      WHERE id = ${applicationId}
        AND school_id = ${schoolId}
        AND status = ${currentStatus}
        AND deleted_at IS NULL
      RETURNING *
    `;

    if (!updatedApp) {
      throw Object.assign(new Error('This application was updated by another staff member. Please refresh and retry.'), { status: 409 });
    }

    // Record immutable stage history
    await tx`
      INSERT INTO admission_application_stage_history (
        school_id, application_id, from_stage_id, to_stage_id,
        from_status, to_status, actor_id, remarks, metadata
      )
      VALUES (
        ${schoolId}, ${applicationId}, ${app.current_stage_id}, ${stage?.id || null},
        ${currentStatus}, ${targetStatus}, ${actorId}, ${remarks}, ${sql.json(metadata)}
      )
    `;

    // Automatically generate operational task when arriving at specific stages
    if (targetStatus === WORKFLOW_STATUSES.DOCUMENT_VERIFICATION || targetStatus === 'VERIFICATION') {
      await tx`
        INSERT INTO admission_tasks (
          school_id, application_id, title, description, task_type,
          assigned_role, status, due_at
        )
        VALUES (
          ${schoolId}, ${applicationId},
          ${'Verify documents for ' + app.application_no},
          'Review all uploaded certificates and ensure compliance before proceeding.',
          'VERIFY_DOCUMENTS', ${stage?.responsible_role || 'staff'}, 'PENDING',
          ${slaDueAt || new Date(Date.now() + 24 * 3600 * 1000)}
        )
      `;
    } else if (targetStatus === WORKFLOW_STATUSES.APPLICATION_UNDER_REVIEW || targetStatus === 'REVIEW') {
      await tx`
        INSERT INTO admission_tasks (
          school_id, application_id, title, description, task_type,
          assigned_role, status, due_at
        )
        VALUES (
          ${schoolId}, ${applicationId},
          ${'Management Review for ' + app.application_no},
          'Evaluate applicant dossier and record final admission decision.',
          'PRINCIPAL_APPROVAL', 'principal', 'PENDING',
          ${slaDueAt || new Date(Date.now() + 24 * 3600 * 1000)}
        )
      `;
    }

    // Record forensic audit log
    await tx`
      INSERT INTO admission_audit_logs (
        school_id, application_id, actor_id, actor_role,
        action, from_state, to_state, reason, details
      )
      VALUES (
        ${schoolId}, ${applicationId}, ${actorId}, ${actorRole},
        'STAGE_TRANSITION', ${currentStatus}, ${targetStatus}, ${remarks},
        ${sql.json({ isOverride, stage_id: stage?.id || null })}
      )
    `;

    return updatedApp;
  });

  return result;
}
