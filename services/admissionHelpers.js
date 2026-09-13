import crypto from 'node:crypto';
import sql from '../db.js';

export function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  return err;
}

export function presentApplication(app) {
  if (!app) return app;
  return {
    ...app,
    application_number: app.application_no,
    parent_phone: app.father_phone || app.mother_phone || app.guardian_phone || null,
    parent_email: app.father_email || app.mother_email || app.guardian_email || null,
    decision_status: app.decision,
  };
}

export function presentChecklist(summary) {
  if (!summary) return summary;
  const checklist = (summary.checklist || []).map((item) => ({
    ...item,
    title: item.displayName || item.title,
    document: item.uploadedDoc || item.document || null,
  }));
  const verifiedCount = summary.verifiedCount || 0;
  const mandatoryCount = summary.mandatoryCount || 0;
  return {
    ...summary,
    checklist,
    verifiedDocuments: verifiedCount,
    requiredDocuments: mandatoryCount,
    pendingDocuments: Math.max(0, mandatoryCount - verifiedCount),
  };
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const MIME_MAGIC = [
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.length >= 4 && b.slice(0, 4).toString('utf8') === '%PDF' },
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.length >= 12 && b.slice(0, 4).toString('utf8') === 'RIFF' && b.slice(8, 12).toString('utf8') === 'WEBP' },
];

export function validateAdmissionUpload({ fileBuffer, mimeType, fileSizeBytes, allowedExtensions = ['pdf', 'jpg', 'jpeg', 'png'], maxSizeMb = 5 }) {
  if (!fileBuffer || !fileBuffer.length) {
    throw httpError('Upload failed. Your application has not been affected. Please retry.', 400);
  }
  if (fileBuffer.length < 16) {
    throw httpError('The uploaded file appears to be corrupted or empty. Please retry with a valid document.', 400);
  }
  const maxBytes = Math.round(Number(maxSizeMb || 5) * 1024 * 1024);
  if ((fileSizeBytes || fileBuffer.length) > maxBytes) {
    throw httpError(`File is too large. Maximum size is ${maxSizeMb} MB.`, 400);
  }

  const detected = MIME_MAGIC.find((m) => m.test(fileBuffer));
  if (!detected) {
    throw httpError('Unsupported or corrupted file. Please upload a PDF, JPG, or PNG.', 400);
  }

  const claimed = String(mimeType || '').toLowerCase();
  if (claimed && claimed !== 'application/octet-stream' && claimed !== detected.mime && !(claimed === 'image/jpg' && detected.mime === 'image/jpeg')) {
    throw httpError('File type does not match the file contents. Please upload a genuine PDF or image.', 400);
  }

  const allowed = (allowedExtensions || []).map((e) => String(e).toLowerCase().replace('.', ''));
  if (allowed.length && !allowed.includes(detected.ext) && !(detected.ext === 'jpg' && allowed.includes('jpeg'))) {
    throw httpError(`This document type only accepts: ${allowed.join(', ')}.`, 400);
  }

  return { mimeType: detected.mime, extension: detected.ext };
}

export async function nextAdmissionSerial(tx, schoolId, kind) {
  const db = tx || sql;
  await db`
    INSERT INTO admission_counters (school_id, enquiry_seq, application_seq)
    VALUES (${schoolId}, 0, 0)
    ON CONFLICT (school_id) DO NOTHING
  `;

  if (kind === 'enquiry') {
    const [row] = await db`
      UPDATE admission_counters
      SET enquiry_seq = enquiry_seq + 1, updated_at = now()
      WHERE school_id = ${schoolId}
      RETURNING enquiry_seq
    `;
    return row.enquiry_seq;
  }

  const [row] = await db`
    UPDATE admission_counters
    SET application_seq = application_seq + 1, updated_at = now()
    WHERE school_id = ${schoolId}
    RETURNING application_seq
  `;
  return row.application_seq;
}

export function formatEnquiryNo(year, seq) {
  return `ENQ-${year}-${String(seq).padStart(4, '0')}`;
}

export function formatApplicationNo(year, seq) {
  return `ADM-${year}-${String(seq).padStart(5, '0')}`;
}

export async function findApplicantApplication(schoolId, userId, email = null) {
  const [byUser] = await sql`
    SELECT a.*, c.name as class_name, ay.name as academic_year_name,
           s.name as current_stage_name, s.code as current_stage_code, s.color as stage_color
    FROM admission_applications a
    LEFT JOIN classes c ON a.applying_class_id = c.id
    LEFT JOIN academic_years ay ON a.academic_year_id = ay.id
    LEFT JOIN admission_workflow_stages s ON a.current_stage_id = s.id
    WHERE a.school_id = ${schoolId}
      AND a.applicant_user_id = ${userId}
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT 1
  `;
  if (byUser) return byUser;

  if (!email) return null;

  const matches = await sql`
    SELECT a.*, c.name as class_name, ay.name as academic_year_name,
           s.name as current_stage_name, s.code as current_stage_code, s.color as stage_color
    FROM admission_applications a
    LEFT JOIN classes c ON a.applying_class_id = c.id
    LEFT JOIN academic_years ay ON a.academic_year_id = ay.id
    LEFT JOIN admission_workflow_stages s ON a.current_stage_id = s.id
    WHERE a.school_id = ${schoolId}
      AND a.deleted_at IS NULL
      AND a.applicant_user_id IS NULL
      AND (lower(a.father_email) = ${email.toLowerCase()} OR lower(a.mother_email) = ${email.toLowerCase()} OR lower(a.guardian_email) = ${email.toLowerCase()})
    ORDER BY a.created_at DESC
    LIMIT 2
  `;

  if (matches.length === 1) return matches[0];
  return null;
}

export function stageCodeForStatus(status) {
  const map = {
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
  };
  return map[status] || status;
}

export async function claimIdempotency(schoolId, key, action, entityId = null) {
  if (!key) return true;
  const [row] = await sql`
    INSERT INTO admission_idempotency_keys (school_id, idempotency_key, action, entity_id)
    VALUES (${schoolId}, ${key}, ${action}, ${entityId})
    ON CONFLICT (school_id, idempotency_key) DO NOTHING
    RETURNING idempotency_key
  `;
  return Boolean(row);
}

export function renderTemplate(template, vars = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    const value = vars[name];
    return value == null ? '' : String(value);
  });
}

export const APPLICANT_FULL_EDIT_STATUSES = [
  'ENQUIRY_CREATED',
  'APPLICATION_STARTED',
  'APPLICATION_INCOMPLETE',
];

export const APPLICANT_PARTIAL_EDIT_STATUSES = [
  'DOCUMENT_COLLECTION',
  'VERIFICATION_REQUIRED',
  'CONDITIONALLY_APPROVED',
];

export function generateApplicantPassword() {
  return `Adm-${crypto.randomBytes(9).toString('base64url')}`;
}

export function computeApplicationProgress(app, stages = [], checklist = null) {
  if (!app) return 0;
  if (app.status === 'CONVERTED_TO_STUDENT' || app.status === 'ADMISSION_CONFIRMED') return 100;
  if (app.status === 'REJECTED' || app.status === 'WITHDRAWN' || app.status === 'EXPIRED') {
    return app.status === 'REJECTED' ? 100 : 20;
  }

  const activeStages = (stages || []).filter((s) => s.is_active !== false);
  if (activeStages.length > 0) {
    const currentCode = stageCodeForStatus(app.status);
    let idx = activeStages.findIndex((s) => s.code === currentCode);
    if (idx < 0) idx = 0;
    const base = Math.round(((idx + 1) / activeStages.length) * 100);
    const docsBoost = checklist?.isFullyCompliant ? 0 : 0;
    return Math.min(99, Math.max(8, base + docsBoost));
  }

  const submitted = !['ENQUIRY_CREATED', 'APPLICATION_STARTED', 'APPLICATION_INCOMPLETE'].includes(app.status);
  const docsDone = Boolean(checklist?.isFullyCompliant);
  const decided = ['APPROVED', 'CONDITIONALLY_APPROVED', 'FEE_PENDING', 'FEE_PAID'].includes(app.status)
    || app.decision === 'APPROVED';
  let pct = 12;
  if (submitted) pct += 28;
  if (docsDone) pct += 28;
  if (decided) pct += 22;
  return Math.min(95, pct);
}

export function buildSmartNextAction(app, { checklist, interviews } = {}) {
  if (!app) {
    return {
      type: 'NO_ACTION_REQUIRED',
      title: 'Application Under Review',
      description: 'Your application is currently being reviewed by school authorities.',
    };
  }

  if (app.status === 'CONVERTED_TO_STUDENT') {
    return {
      type: 'COMPLETED',
      title: 'Admission Confirmed!',
      description: 'Congratulations! Your admission has been successfully confirmed and your student account is active.',
      actionKey: 'OPEN_PORTAL',
    };
  }

  if (app.status === 'REJECTED') {
    return {
      type: 'NO_ACTION_REQUIRED',
      title: 'Application not approved',
      description: app.decision_reason || 'The school has completed review of this application.',
    };
  }

  if (app.status === 'WITHDRAWN') {
    return {
      type: 'NO_ACTION_REQUIRED',
      title: 'Application withdrawn',
      description: 'This application is no longer active.',
    };
  }

  const items = checklist?.checklist || [];
  const rejectedDocs = items.filter((c) => c.uploadedDoc?.status === 'REJECTED' || c.status === 'REJECTED');
  const missingMandatoryDocs = items.filter((c) => c.isMandatory && !c.uploadedDoc);

  if (rejectedDocs.length > 0) {
    return {
      type: 'ACTION_REQUIRED',
      title: 'Action Required: Re-upload Rejected Document',
      description: `Please re-upload: ${rejectedDocs.map((d) => d.displayName || d.title).join(', ')}. Reason: ${rejectedDocs[0]?.uploadedDoc?.rejection_reason || 'Image unclear'}`,
      actionKey: 'UPLOAD_DOCUMENT',
      targetDocType: rejectedDocs[0]?.documentType,
    };
  }

  if (['ENQUIRY_CREATED', 'APPLICATION_STARTED', 'APPLICATION_INCOMPLETE'].includes(app.status)) {
    return {
      type: 'ACTION_REQUIRED',
      title: 'Complete your application',
      description: 'Please finish the remaining application sections and submit to the school.',
      actionKey: 'COMPLETE_FORM',
    };
  }

  if (missingMandatoryDocs.length > 0) {
    return {
      type: 'ACTION_REQUIRED',
      title: 'Action Required: Upload Missing Document',
      description: `Please upload mandatory documents: ${missingMandatoryDocs.map((d) => d.displayName || d.title).join(', ')}`,
      actionKey: 'UPLOAD_DOCUMENT',
      targetDocType: missingMandatoryDocs[0]?.documentType,
    };
  }

  if (app.status === 'CONDITIONALLY_APPROVED' && app.conditional_requirements) {
    return {
      type: 'ACTION_REQUIRED',
      title: 'Conditional approval — complete remaining items',
      description: app.conditional_requirements,
      actionKey: 'UPLOAD_DOCUMENT',
    };
  }

  const upcoming = (interviews || []).find((i) => i.status === 'SCHEDULED');
  if (upcoming) {
    return {
      type: 'ACTION_REQUIRED',
      title: `Interview scheduled: ${upcoming.scheduled_date} ${upcoming.start_time || ''}`.trim(),
      description: `${upcoming.title || 'Interaction'} at ${upcoming.location || 'School'}. Please arrive on time.`,
      actionKey: 'VIEW_INTERVIEW',
    };
  }

  if (app.status === 'FEE_PENDING') {
    return {
      type: 'ACTION_REQUIRED',
      title: 'Action Required: Admission Fee Payment',
      description: 'Your application is approved. Please pay the admission confirmation fee to reserve your seat.',
      actionKey: 'PAY_FEE',
    };
  }

  if (app.status === 'WAITLISTED') {
    return {
      type: 'NO_ACTION_REQUIRED',
      title: 'You are on the waitlist',
      description: app.waitlist_rank
        ? `Your waitlist priority is #${app.waitlist_rank}. We will notify you if a seat becomes available.`
        : 'We will notify you if a seat becomes available for your selected class.',
    };
  }

  return {
    type: 'NO_ACTION_REQUIRED',
    title: 'Application Under Review',
    description: 'Your application is currently being reviewed by school authorities. No action is required from you at this time.',
    deadline: app.sla_due_at,
  };
}

export function presentWorkflowTimeline(stages = [], app = {}, history = []) {
  const currentCode = stageCodeForStatus(app.status);
  const currentIdx = stages.findIndex((s) => s.code === currentCode);
  return stages.map((stage, idx) => {
    const hist = [...history].reverse().find((h) => h.stage_name === stage.name || stageCodeForStatus(h.to_status) === stage.code);
    let state = 'upcoming';
    if (app.status === 'CONVERTED_TO_STUDENT' || idx < currentIdx) state = 'done';
    else if (idx === currentIdx) state = 'current';
    return {
      code: stage.code,
      name: stage.name,
      color: stage.color,
      sequence_order: stage.sequence_order,
      state,
      entered_at: hist?.entered_at || null,
      remarks: hist?.remarks || null,
    };
  });
}

export async function getStaffUserIdsByRoles(schoolId, roleCodes = ['admin', 'principal']) {
  const rows = await sql`
    SELECT DISTINCT u.id
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = ${schoolId}
    JOIN roles r ON r.id = ur.role_id AND r.school_id = ${schoolId} AND r.deleted_at IS NULL
    WHERE u.school_id = ${schoolId}
      AND u.account_status = 'active'
      AND r.code = ANY(${roleCodes})
  `;
  return rows.map((r) => r.id);
}
