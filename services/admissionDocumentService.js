import sql, { supabaseAdmin } from '../db.js';
import logger from '../utils/logger.js';
import { httpError, sha256Buffer, validateAdmissionUpload } from './admissionHelpers.js';

export const ADMISSION_DOC_BUCKET = 'admission-documents';
let ensureBucketPromise = null;

/**
 * Ensure the admission documents storage bucket exists.
 */
export async function ensureAdmissionDocumentBucket() {
  if (ensureBucketPromise) return ensureBucketPromise;

  ensureBucketPromise = (async () => {
    try {
      const { data: existing } = await supabaseAdmin.storage.getBucket(ADMISSION_DOC_BUCKET);
      if (existing) return;

      const { error } = await supabaseAdmin.storage.createBucket(ADMISSION_DOC_BUCKET, {
        public: false,
        fileSizeLimit: '10MB',
      });
      if (error && !/already exists/i.test(error.message || '')) {
        logger.warn({ error: error.message }, 'Could not create admission-documents bucket');
      }
    } catch (e) {
      ensureBucketPromise = null;
    }
  })();

  return ensureBucketPromise;
}

/**
 * Retrieve document requirements for a school, optionally filtered by applying class.
 */
export async function getDocumentRequirements(schoolId, classId = null) {
  const reqs = await sql`
    SELECT id, document_type, display_name, description, is_mandatory,
           applicable_classes, allowed_extensions, max_size_mb
    FROM admission_document_requirements
    WHERE school_id = ${schoolId}
    ORDER BY is_mandatory DESC, display_name ASC
  `;

  if (!classId) return reqs;

  // Filter based on applicable_classes json array if specified
  return reqs.filter((r) => {
    if (!r.applicable_classes || !Array.isArray(r.applicable_classes) || r.applicable_classes.length === 0) {
      return true;
    }
    return r.applicable_classes.includes(classId);
  });
}

/**
 * Save an uploaded admission document for an application.
 */
export async function saveUploadedDocument(schoolId, applicationId, {
  documentType,
  title,
  fileBuffer,
  fileName,
  mimeType,
  fileSizeBytes,
}) {
  const [app] = await sql`
    SELECT applying_class_id FROM admission_applications
    WHERE id = ${applicationId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!app) {
    throw httpError('Application not found', 404);
  }

  const requirements = await getDocumentRequirements(schoolId, app.applying_class_id);
  const req = requirements.find((r) => r.document_type === documentType);

  const validated = validateAdmissionUpload({
    fileBuffer,
    mimeType,
    fileSizeBytes,
    allowedExtensions: req?.allowed_extensions,
    maxSizeMb: req?.max_size_mb,
  });

  await ensureAdmissionDocumentBucket();

  const fileHash = sha256Buffer(fileBuffer);

  let dup = null;
  try {
    [dup] = await sql`
      SELECT id, application_id, document_type FROM admission_documents
      WHERE school_id = ${schoolId} AND file_hash = ${fileHash} AND application_id = ${applicationId}
        AND document_type <> ${documentType}
      LIMIT 1
    `;
  } catch {
    dup = null;
  }
  if (dup) {
    throw httpError('This file was already uploaded as a different document type. Please upload the correct file.', 409);
  }

  const sanitizedName = String(fileName || `${documentType}.${validated.extension}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${schoolId}/${applicationId}/${documentType}_${Date.now()}_${sanitizedName}`;

  let publicUrl = '';
  try {
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(ADMISSION_DOC_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: validated.mimeType,
        upsert: true,
      });

    if (uploadErr) {
      logger.error({ uploadErr }, 'Storage upload failed, fallback to local reference');
      publicUrl = `/uploads/admissions/${schoolId}/${applicationId}/${sanitizedName}`;
    } else {
      publicUrl = storagePath;
    }
  } catch (err) {
    publicUrl = `/uploads/admissions/${schoolId}/${applicationId}/${sanitizedName}`;
  }

  // Check if document of this type already exists for this application
  const [existing] = await sql`
    SELECT id, version FROM admission_documents
    WHERE school_id = ${schoolId} AND application_id = ${applicationId} AND document_type = ${documentType}
    LIMIT 1
  `;

  let savedDoc;
  if (existing) {
    const nextVersion = (existing.version || 1) + 1;
    const [updated] = await sql`
      UPDATE admission_documents
      SET title = ${title || documentType},
          file_url = ${publicUrl},
          file_size_bytes = ${fileSizeBytes || fileBuffer?.length || 0},
          mime_type = ${validated.mimeType},
          status = 'UPLOADED',
          replacement_requested = false,
          rejection_reason = NULL,
          version = ${nextVersion},
          updated_at = now()
      WHERE id = ${existing.id} AND school_id = ${schoolId}
      RETURNING *
    `;
    savedDoc = updated;
  } else {
    const [inserted] = await sql`
      INSERT INTO admission_documents (
        school_id, application_id, document_type, title, file_url,
        file_size_bytes, mime_type, status, version
      )
      VALUES (
        ${schoolId}, ${applicationId}, ${documentType}, ${title || documentType}, ${publicUrl},
        ${fileSizeBytes || fileBuffer?.length || 0}, ${validated.mimeType}, 'UPLOADED', 1
      )
      RETURNING *
    `;
    savedDoc = inserted;
  }

  try {
    await sql`
      UPDATE admission_documents
      SET file_hash = ${fileHash},
          original_file_name = ${fileName || sanitizedName},
          storage_path = ${storagePath}
      WHERE id = ${savedDoc.id} AND school_id = ${schoolId}
    `;
  } catch {
    // hardening columns optional
  }

  // Record audit log
  await sql`
    INSERT INTO admission_audit_logs (
      school_id, application_id, action, to_state, reason, details
    )
    VALUES (
      ${schoolId}, ${applicationId}, 'DOCUMENT_UPLOADED', 'UPLOADED',
      ${'Uploaded ' + (title || documentType)},
      ${sql.json({ document_id: savedDoc.id, document_type: documentType, version: savedDoc.version })}
    )
  `;

  return savedDoc;
}

/**
 * Review an admission document (Verify or Reject).
 */
export async function reviewDocument(schoolId, applicationId, documentId, {
  status, // 'VERIFIED' or 'REJECTED'
  verifiedByUserId,
  rejectionReason = '',
  replacementRequested = false,
}) {
  if (!['VERIFIED', 'REJECTED', 'UNDER_REVIEW'].includes(status)) {
    throw httpError('Invalid verification status', 400);
  }

  if (status === 'REJECTED' && !rejectionReason?.trim()) {
    throw httpError('Rejection reason is required when rejecting a document', 400);
  }

  const [doc] = await sql`
    SELECT id, document_type, title, status FROM admission_documents
    WHERE id = ${documentId} AND application_id = ${applicationId} AND school_id = ${schoolId}
  `;

  if (!doc) {
    throw httpError('Document not found', 404);
  }

  const [updated] = await sql`
    UPDATE admission_documents
    SET status = ${status},
        verified_by = ${verifiedByUserId},
        verified_at = now(),
        rejection_reason = ${status === 'REJECTED' ? rejectionReason : null},
        replacement_requested = ${status === 'REJECTED' ? (replacementRequested || true) : false},
        updated_at = now()
    WHERE id = ${documentId} AND school_id = ${schoolId}
    RETURNING *
  `;

  // Audit log
  await sql`
    INSERT INTO admission_audit_logs (
      school_id, application_id, actor_id, actor_role, action, from_state, to_state, reason, details
    )
    VALUES (
      ${schoolId}, ${applicationId}, ${verifiedByUserId}, 'staff',
      ${status === 'VERIFIED' ? 'DOCUMENT_VERIFIED' : 'DOCUMENT_REJECTED'},
      ${doc.status}, ${status}, ${rejectionReason || 'Document audit verified'},
      ${sql.json({ document_id: documentId, document_type: doc.document_type })}
    )
  `;

  return updated;
}

/**
 * Get all documents for an application alongside requirements checklist.
 */
export async function getApplicationDocumentsWithChecklist(schoolId, applicationId) {
  const [app] = await sql`
    SELECT applying_class_id FROM admission_applications
    WHERE id = ${applicationId} AND school_id = ${schoolId}
  `;

  const requirements = await getDocumentRequirements(schoolId, app?.applying_class_id);
  const uploadedDocs = await sql`
    SELECT id, document_type, title, file_url, file_size_bytes, mime_type,
           status, verified_by, verified_at, rejection_reason, replacement_requested, version, updated_at
    FROM admission_documents
    WHERE application_id = ${applicationId} AND school_id = ${schoolId}
    ORDER BY created_at ASC
  `;

  const signedDocs = await Promise.all(uploadedDocs.map((doc) => attachSignedDocumentUrl(doc)));
  const docMap = new Map(signedDocs.map((d) => [d.document_type, d]));

  const checklist = requirements.map((req) => {
    const uploaded = docMap.get(req.document_type);
    return {
      documentType: req.document_type,
      displayName: req.display_name,
      description: req.description,
      isMandatory: req.is_mandatory,
      allowedExtensions: req.allowed_extensions,
      maxSizeMb: req.max_size_mb,
      uploadedDoc: uploaded || null,
      status: uploaded ? uploaded.status : (req.is_mandatory ? 'PENDING' : 'NOT_REQUIRED'),
    };
  });

  const mandatoryCount = checklist.filter((c) => c.isMandatory).length;
  const verifiedCount = checklist.filter((c) => c.isMandatory && c.uploadedDoc?.status === 'VERIFIED').length;
  const rejectedCount = checklist.filter((c) => c.uploadedDoc?.status === 'REJECTED').length;
  const isFullyCompliant = mandatoryCount > 0 && verifiedCount === mandatoryCount;

  return {
    checklist,
    mandatoryCount,
    verifiedCount,
    rejectedCount,
    isFullyCompliant,
    uploadedDocuments: signedDocs,
  };
}

async function attachSignedDocumentUrl(doc) {
  if (!doc) return doc;
  const path = doc.storage_path || (doc.file_url && !String(doc.file_url).startsWith('http') && !String(doc.file_url).startsWith('/') ? doc.file_url : null);
  if (!path) return doc;
  try {
    const { data } = await supabaseAdmin.storage.from(ADMISSION_DOC_BUCKET).createSignedUrl(path, 60 * 60);
    if (data?.signedUrl) {
      return { ...doc, file_url: data.signedUrl };
    }
  } catch {
    // keep stored url
  }
  return doc;
}
