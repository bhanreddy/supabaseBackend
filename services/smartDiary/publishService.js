import sql from '../../db.js';
import { sendNotificationToUsers } from '../notificationService.js';
import { translateDiaryFields } from '../ai/translationService.js';
import {
  composeDiaryContent,
  composeDiaryTitle,
  parentNotificationCopy,
  publicStructuredFields,
} from './composeContent.js';
import { isUuid, sanitizeDueDate, sanitizeSource } from './validation.js';
import { recordDiaryPhotoHistory } from './photoHistory.js';

export { isUuid, sanitizeDueDate, sanitizeSource };

export async function teacherMayAccessAssignment(schoolId, userId, classSectionId, subjectId) {
  if (!classSectionId) return false;
  const [staff] = await sql`
    SELECT s.id
    FROM staff s
    JOIN persons p ON s.person_id = p.id
    JOIN users u ON u.person_id = p.id
    WHERE u.id = ${userId}
      AND s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
  `;
  if (!staff) return false;

  const [row] = await sql`
    SELECT 1
    FROM class_sections cs
    WHERE cs.id = ${classSectionId}
      AND cs.school_id = ${schoolId}
      AND cs.deleted_at IS NULL
    LIMIT 1
  `;
  if (!row) return false;
  if (!subjectId) return true;

  const [assigned] = await sql`
    SELECT (
      EXISTS (
        SELECT 1
        FROM class_subjects csub
        WHERE csub.class_section_id = ${classSectionId}
          AND csub.subject_id = ${subjectId}
          AND csub.teacher_id = ${staff.id}
          AND csub.school_id = ${schoolId}
          AND csub.deleted_at IS NULL
      )
      OR EXISTS (
        SELECT 1
        FROM timetable_slots ts
        WHERE ts.class_section_id = ${classSectionId}
          AND ts.subject_id = ${subjectId}
          AND ts.teacher_id = ${staff.id}
          AND ts.school_id = ${schoolId}
          AND ts.deleted_at IS NULL
      )
    ) AS ok
  `;
  return Boolean(assigned?.ok);
}

export async function validateTrustedTarget(schoolId, classSectionId, subjectId) {
  const [classSection] = await sql`
    SELECT id FROM class_sections
    WHERE id = ${classSectionId} AND school_id = ${schoolId} AND deleted_at IS NULL
  `;
  if (!classSection) return { ok: false, status: 404, error: 'Class-section not found' };
  if (subjectId == null) return { ok: true };
  const [subject] = await sql`
    SELECT s.id
    FROM subjects s
    WHERE s.id = ${subjectId}
      AND s.school_id = ${schoolId}
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
  `;
  if (!subject) return { ok: false, status: 400, error: 'Subject is not assigned to this class-section' };
  return { ok: true };
}

export function buildProcessingMetadata(extraction = {}, extra = {}) {
  const structured = publicStructuredFields(extraction) || {};
  return {
    ...structured,
    confidence: extraction.confidence && typeof extraction.confidence === 'object'
      ? extraction.confidence
      : {},
    detectedLanguage: extraction.detectedLanguage || extra.detectedLanguage || '',
    source: extra.entrySource || extraction.source || 'MANUAL',
  };
}

export async function findBySubmissionId(schoolId, submissionId) {
  if (!isUuid(submissionId)) return null;
  const [row] = await sql`
    SELECT * FROM diary_entries
    WHERE school_id = ${schoolId} AND submission_id = ${submissionId}
    LIMIT 1
  `;
  return row || null;
}

export async function upsertDiaryEntry({
  schoolId,
  userInternalId,
  classSectionId,
  subjectId,
  entryDate,
  title,
  content,
  homeworkDueDate,
  attachments,
  inputLanguage = 'auto',
  entrySource = 'MANUAL',
  originalText = null,
  processedText = null,
  ocrStatus = null,
  aiStatus = null,
  detectedLanguage = null,
  sourceDiaryId = null,
  templateId = null,
  submissionId = null,
  processingMetadata = null,
  classDiaryUploadId = null,
  syllabusChapterId = null,
  syllabusTopicId = null,
  academicPlanItemId = null,
  notify = true,
}) {
  if (submissionId) {
    const existing = await findBySubmissionId(schoolId, submissionId);
    if (existing) {
      return { entry: existing, createdNew: false, duplicate: true };
    }
  }

  const resolved = await translateDiaryFields({
    title,
    content,
    inputLanguage,
  });

  const source = sanitizeSource(entrySource);
  const due = sanitizeDueDate(homeworkDueDate, entryDate);
  const attachmentValue = Array.isArray(attachments) && attachments.length > 0 ? sql.json(attachments) : null;
  const metadataJson = processingMetadata ? JSON.stringify(processingMetadata) : null;

  try {
    const result = await sql`
      INSERT INTO diary_entries (
        school_id, class_section_id, subject_id, entry_date,
        title, title_te, content, content_te, homework_due_date, attachments, created_by,
        entry_source, original_text, processed_text, ocr_status, ai_status, detected_language,
        source_diary_id, template_id, submission_id, processing_metadata, class_diary_upload_id,
        syllabus_chapter_id, syllabus_topic_id, academic_plan_item_id
      ) VALUES (
        ${schoolId}, ${classSectionId}, ${subjectId || null}, ${entryDate},
        ${resolved.title}, ${resolved.title_te}, ${resolved.content}, ${resolved.content_te},
        ${due}, ${attachmentValue}, ${userInternalId},
        ${source}, ${originalText}, ${processedText}, ${ocrStatus}, ${aiStatus}, ${detectedLanguage},
        ${sourceDiaryId}, ${templateId}, ${submissionId}, ${metadataJson}, ${classDiaryUploadId},
        ${syllabusChapterId}, ${syllabusTopicId}, ${academicPlanItemId}
      )
      ON CONFLICT (school_id, class_section_id, subject_id, entry_date, created_by)
      DO UPDATE SET
        title = EXCLUDED.title,
        title_te = EXCLUDED.title_te,
        content = EXCLUDED.content,
        content_te = EXCLUDED.content_te,
        homework_due_date = EXCLUDED.homework_due_date,
        attachments = COALESCE(EXCLUDED.attachments, diary_entries.attachments),
        entry_source = COALESCE(EXCLUDED.entry_source, diary_entries.entry_source),
        original_text = COALESCE(EXCLUDED.original_text, diary_entries.original_text),
        processed_text = COALESCE(EXCLUDED.processed_text, diary_entries.processed_text),
        ocr_status = COALESCE(EXCLUDED.ocr_status, diary_entries.ocr_status),
        ai_status = COALESCE(EXCLUDED.ai_status, diary_entries.ai_status),
        detected_language = COALESCE(EXCLUDED.detected_language, diary_entries.detected_language),
        source_diary_id = COALESCE(EXCLUDED.source_diary_id, diary_entries.source_diary_id),
        template_id = COALESCE(EXCLUDED.template_id, diary_entries.template_id),
        submission_id = COALESCE(diary_entries.submission_id, EXCLUDED.submission_id),
        processing_metadata = COALESCE(EXCLUDED.processing_metadata, diary_entries.processing_metadata),
        class_diary_upload_id = COALESCE(EXCLUDED.class_diary_upload_id, diary_entries.class_diary_upload_id),
        syllabus_chapter_id = COALESCE(EXCLUDED.syllabus_chapter_id, diary_entries.syllabus_chapter_id),
        syllabus_topic_id = COALESCE(EXCLUDED.syllabus_topic_id, diary_entries.syllabus_topic_id),
        academic_plan_item_id = COALESCE(EXCLUDED.academic_plan_item_id, diary_entries.academic_plan_item_id),
        deleted_at = NULL,
        updated_at = now()
      RETURNING *, (xmax = 0) AS _was_insert
    `;
    const row = result[0];
    const createdNew = row._was_insert === true;
    const { _was_insert, ...entry } = row;
    await recordDiaryPhotoHistory({
      schoolId,
      diaryEntryId: entry.id,
      classSectionId,
      subjectId,
      createdBy: userInternalId,
      entryDate,
      attachments,
    });
    return { entry, createdNew, duplicate: false };
  } catch (error) {
    if (error.code === '23505' && submissionId) {
      const existing = await findBySubmissionId(schoolId, submissionId);
      if (existing) return { entry: existing, createdNew: false, duplicate: true };
    }
    throw error;
  }
}

export async function patchDiaryAiFields(schoolId, diaryId, fields = {}, { notify = false } = {}) {
  const [existing] = await sql`
    SELECT * FROM diary_entries WHERE id = ${diaryId} AND school_id = ${schoolId}
  `;
  if (!existing) return null;

  const content = fields.content != null ? fields.content : existing.content;
  const title = fields.title != null ? fields.title : existing.title;
  let resolved = { title, title_te: existing.title_te, content, content_te: existing.content_te };
  if (fields.content != null || fields.title != null) {
    resolved = await translateDiaryFields({
      title,
      content,
      inputLanguage: fields.inputLanguage || 'auto',
    });
  }

  const [updated] = await sql`
    UPDATE diary_entries SET
      title = ${resolved.title},
      title_te = ${resolved.title_te},
      content = ${resolved.content},
      content_te = ${resolved.content_te},
      original_text = COALESCE(${fields.originalText || null}, original_text),
      processed_text = COALESCE(${fields.processedText || null}, processed_text),
      ocr_status = COALESCE(${fields.ocrStatus || null}, ocr_status),
      ai_status = COALESCE(${fields.aiStatus || null}, ai_status),
      detected_language = COALESCE(${fields.detectedLanguage || null}, detected_language),
      processing_metadata = COALESCE(${fields.processingMetadata ? JSON.stringify(fields.processingMetadata) : null}, processing_metadata),
      homework_due_date = COALESCE(${fields.homeworkDueDate || null}, homework_due_date),
      updated_at = now()
    WHERE id = ${diaryId} AND school_id = ${schoolId}
    RETURNING *
  `;

  if (notify === true) {
    await maybeNotifyDiaryPublished({
      schoolId,
      entry: updated,
      fields,
      force: false,
    });
  }
  return updated;
}

export async function parentRecipientUserIds(schoolId, classSectionIds) {
  const ids = [...new Set((classSectionIds || []).filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await sql`
    SELECT DISTINCT u.id
    FROM users u
    JOIN parents p ON u.person_id = p.person_id
      AND p.school_id = ${schoolId}
      AND p.deleted_at IS NULL
    JOIN student_parents sp ON p.id = sp.parent_id
      AND sp.school_id = ${schoolId}
      AND sp.deleted_at IS NULL
    JOIN students s ON sp.student_id = s.id
      AND s.school_id = ${schoolId}
      AND s.deleted_at IS NULL
    JOIN student_enrollments se ON s.id = se.student_id
      AND se.school_id = ${schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    WHERE se.class_section_id = ANY(${ids})
      AND u.school_id = ${schoolId}
      AND u.account_status = 'active'
      AND u.deleted_at IS NULL
  `;
  return rows.map((row) => row.id);
}

export async function maybeNotifyDiaryPublished({
  schoolId,
  entry,
  fields = {},
  classSectionIds = null,
  force = false,
}) {
  if (!entry) return { sent: false, reason: 'missing_entry' };
  if (!force && entry.notification_sent_at) return { sent: false, reason: 'already_sent' };

  const copy = parentNotificationCopy(fields, {
    subject_name: fields.subject || fields.subject_name,
    hasPhoto: Array.isArray(entry.attachments)
      ? entry.attachments.length > 0
      : Boolean(fields.hasPhoto),
  });
  const recipients = await parentRecipientUserIds(
    schoolId,
    classSectionIds || [entry.class_section_id],
  );
  if (recipients.length === 0) {
    await markNotificationSent(schoolId, [entry.id]);
    return { sent: false, reason: 'no_recipients' };
  }

  await sendNotificationToUsers(
    recipients,
    'DIARY_UPDATED',
    { message: `${copy.title}. ${copy.message}`, message_te: copy.message },
    { role: 'parent', schoolId, deepLink: '/Screen/diary' },
  );
  await markNotificationSent(schoolId, classSectionIds ? null : [entry.id], classSectionIds, entry.entry_date, entry.created_by);
  return { sent: true, recipients: recipients.length };
}

async function markNotificationSent(schoolId, entryIds, classSectionIds, entryDate, createdBy) {
  if (Array.isArray(entryIds) && entryIds.length > 0) {
    await sql`
      UPDATE diary_entries
      SET notification_sent_at = COALESCE(notification_sent_at, now())
      WHERE school_id = ${schoolId}
        AND id = ANY(${entryIds})
    `;
    return;
  }
  if (classSectionIds?.length && entryDate && createdBy) {
    await sql`
      UPDATE diary_entries
      SET notification_sent_at = COALESCE(notification_sent_at, now())
      WHERE school_id = ${schoolId}
        AND created_by = ${createdBy}
        AND entry_date = ${entryDate}
        AND class_section_id = ANY(${classSectionIds})
        AND notification_sent_at IS NULL
    `;
  }
}

export async function publishDiaryTargets({
  schoolId,
  userInternalId,
  userId,
  roles = [],
  targets,
  shared,
}) {
  const isAdmin = roles.includes('admin') || roles.includes('principal');
  const results = [];
  const publishedSectionIds = [];

  for (const target of targets) {
    const classSectionId = target.class_section_id;
    const subjectId = target.subject_id ?? shared.subject_id ?? null;
    const submissionId = target.submission_id || shared.submission_id || null;

    if (!isUuid(classSectionId)) {
      results.push({ class_section_id: classSectionId, error: 'Invalid class' });
      continue;
    }
    if (subjectId && !isUuid(subjectId)) {
      results.push({ class_section_id: classSectionId, error: 'Invalid subject' });
      continue;
    }
    if (submissionId && !isUuid(submissionId)) {
      results.push({ class_section_id: classSectionId, error: 'Invalid submission id' });
      continue;
    }

    const targetCheck = await validateTrustedTarget(schoolId, classSectionId, subjectId);
    if (!targetCheck.ok) {
      results.push({ class_section_id: classSectionId, error: targetCheck.error });
      continue;
    }

    if (!isAdmin) {
      const allowed = await teacherMayAccessAssignment(schoolId, userId, classSectionId, subjectId);
      if (!allowed) {
        results.push({ class_section_id: classSectionId, error: 'Not assigned to this class' });
        continue;
      }
    }

    const content = shared.content || composeDiaryContent(shared.extraction || {}, {
      hasPhoto: (shared.attachments || []).length > 0,
    });
    const title = shared.title || composeDiaryTitle(shared.extraction || {}, {
      subject_name: shared.subject_name,
      hasPhoto: (shared.attachments || []).length > 0,
    });

    const { entry, createdNew, duplicate } = await upsertDiaryEntry({
      schoolId,
      userInternalId,
      classSectionId,
      subjectId,
      entryDate: shared.entry_date,
      title,
      content,
      homeworkDueDate: shared.homework_due_date,
      attachments: shared.attachments,
      inputLanguage: shared.input_language || 'auto',
      entrySource: shared.entry_source,
      originalText: shared.original_text,
      processedText: shared.processed_text || content,
      ocrStatus: shared.ocr_status,
      aiStatus: shared.ai_status,
      detectedLanguage: shared.detected_language,
      sourceDiaryId: shared.source_diary_id,
      templateId: shared.template_id,
      submissionId,
      processingMetadata: shared.processing_metadata,
      notify: false,
    });

    results.push({
      class_section_id: classSectionId,
      id: entry.id,
      createdNew,
      duplicate,
    });
    publishedSectionIds.push(classSectionId);
  }

  const first = results.find((row) => row.id);
  if (first && shared.notify !== false) {
    const [entry] = await sql`
      SELECT * FROM diary_entries WHERE id = ${first.id} AND school_id = ${schoolId}
    `;
    await maybeNotifyDiaryPublished({
      schoolId,
      entry,
      fields: {
        ...(shared.extraction || {}),
        subject_name: shared.subject_name,
        hasPhoto: (shared.attachments || []).length > 0,
      },
      classSectionIds: [...new Set(publishedSectionIds)],
      force: false,
    });
  }

  return results;
}

export async function logDiaryAnalytics({ schoolId, teacherId, eventName, properties }) {
  if (!schoolId || !eventName) return;
  await sql`
    INSERT INTO diary_analytics_events (school_id, teacher_id, event_name, properties)
    VALUES (${schoolId}, ${teacherId || null}, ${eventName}, ${properties ? JSON.stringify(properties) : null})
  `;
}
