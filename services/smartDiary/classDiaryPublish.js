import sql from '../../db.js';
import { composeDiaryContent, composeDiaryTitle } from './composeContent.js';
import { isUuid, sanitizeDueDate, sanitizeSource } from './validation.js';
import { upsertDiaryEntry, parentRecipientUserIds, logDiaryAnalytics } from './publishService.js';
import { sendNotificationToUsers } from '../notificationService.js';
import { matchSubjectName } from './subjectMatch.js';
import { loadClassSubjects } from './classTeacherService.js';

export function classDiaryNotificationCopy(className, sectionName) {
  const label = `${className || ''}${sectionName || ''}`.trim() || 'class';
  return {
    title: `Today's Class ${label} Diary`,
    message: `Today's Class ${label} Diary is available.`,
  };
}

export async function findClassDiaryUpload(schoolId, submissionId) {
  if (!isUuid(submissionId)) return null;
  const [row] = await sql`
    SELECT * FROM class_diary_uploads
    WHERE school_id = ${schoolId} AND submission_id = ${submissionId}
    LIMIT 1
  `;
  return row || null;
}

export async function upsertClassDiaryUpload({
  schoolId,
  userInternalId,
  classSectionId,
  entryDate,
  imageUrl,
  sourceImageUrl = null,
  submissionId,
  processingStatus = 'processing',
  overallConfidence = null,
  extractedJson = null,
}) {
  const existing = await findClassDiaryUpload(schoolId, submissionId);
  if (existing) {
    const [row] = await sql`
      UPDATE class_diary_uploads SET
        image_url = COALESCE(${imageUrl}, image_url),
        source_image_url = COALESCE(${sourceImageUrl}, source_image_url),
        processing_status = ${processingStatus},
        overall_confidence = COALESCE(${overallConfidence}, overall_confidence),
        extracted_json = COALESCE(${extractedJson ? JSON.stringify(extractedJson) : null}, extracted_json)
      WHERE id = ${existing.id} AND school_id = ${schoolId}
      RETURNING *
    `;
    return { upload: row, createdNew: false };
  }

  const [row] = await sql`
    INSERT INTO class_diary_uploads (
      school_id, class_section_id, created_by, entry_date,
      image_url, source_image_url, processing_status, submission_id,
      overall_confidence, extracted_json
    ) VALUES (
      ${schoolId}, ${classSectionId}, ${userInternalId}, ${entryDate},
      ${imageUrl}, ${sourceImageUrl}, ${processingStatus}, ${submissionId},
      ${overallConfidence}, ${extractedJson ? JSON.stringify(extractedJson) : null}
    )
    RETURNING *
  `;
  return { upload: row, createdNew: true };
}

function trustedEntry(item, subjects, imageUrl, entryDate) {
  const mapped = item.subject_id && isUuid(item.subject_id)
    ? subjects.find((subject) => subject.id === item.subject_id)
    : matchSubjectName(item.subject || item.rawName, subjects).subject;
  if (!mapped) {
    return { ...item, subject_id: null, unknown: true, selected: false };
  }
  const extraction = {
    subject: mapped.name,
    classwork: item.classwork,
    homework: item.homework,
    chapter: item.chapter,
    exercise: item.exercise,
    questions: item.questions,
    reminders: item.reminders,
    dueDate: item.dueDate,
  };
  return {
    ...item,
    subject: mapped.name,
    subject_id: mapped.id,
    unknown: false,
    content: composeDiaryContent(extraction, { hasPhoto: Boolean(imageUrl) }),
    title: composeDiaryTitle(extraction, { subject_name: mapped.name, hasPhoto: Boolean(imageUrl) }),
    homework_due_date: sanitizeDueDate(item.dueDate, entryDate),
  };
}

export async function publishClassDiary({
  schoolId,
  userInternalId,
  classSectionId,
  entryDate,
  imageUrl,
  sourceImageUrl,
  submissionId,
  entries = [],
  sendOriginal = false,
  section,
}) {
  const subjects = await loadClassSubjects(schoolId, classSectionId);
  const { upload } = await upsertClassDiaryUpload({
    schoolId,
    userInternalId,
    classSectionId,
    entryDate,
    imageUrl,
    sourceImageUrl,
    submissionId,
    processingStatus: sendOriginal ? 'original' : 'published',
    extractedJson: { entries, sendOriginal },
  });

  const sharedAttachments = imageUrl ? [imageUrl] : [];
  const results = [];

  if (sendOriginal || entries.length === 0) {
    const { entry, createdNew, duplicate } = await upsertDiaryEntry({
      schoolId,
      userInternalId,
      classSectionId,
      subjectId: null,
      entryDate,
      title: classDiaryNotificationCopy(section?.class_name, section?.section_name).title,
      content: 'Please view the original class diary photo.',
      attachments: sharedAttachments,
      entrySource: 'CLASS_DIARY_AI',
      originalText: null,
      processedText: 'Please view the original class diary photo.',
      ocrStatus: sendOriginal ? 'skipped' : 'failed',
      aiStatus: sendOriginal ? 'skipped' : 'failed',
      submissionId,
      classDiaryUploadId: upload.id,
      processingMetadata: { classDiary: true, originalOnly: true },
    });
    results.push({ id: entry.id, subject_id: null, createdNew, duplicate });
  } else {
    const selected = entries.filter((item) => item.selected !== false);
    for (const item of selected) {
      const trusted = trustedEntry(item, subjects, imageUrl, entryDate);
      if (!trusted.subject_id) {
        results.push({ subject: item.subject || item.rawName, error: 'Unknown subject' });
        continue;
      }
      const { entry, createdNew, duplicate } = await upsertDiaryEntry({
        schoolId,
        userInternalId,
        classSectionId,
        subjectId: trusted.subject_id,
        entryDate,
        title: trusted.title,
        content: trusted.content,
        homeworkDueDate: trusted.homework_due_date,
        attachments: sharedAttachments,
        entrySource: 'CLASS_DIARY_AI',
        originalText: item.originalText || null,
        processedText: trusted.content,
        ocrStatus: 'succeeded',
        aiStatus: 'succeeded',
        submissionId: null,
        classDiaryUploadId: upload.id,
        processingMetadata: {
          classwork: trusted.classwork,
          homework: trusted.homework,
          reminders: trusted.reminders,
          chapter: trusted.chapter,
        },
      });
      results.push({
        id: entry.id,
        subject_id: trusted.subject_id,
        subject: trusted.subject,
        createdNew,
        duplicate,
      });
    }
  }

  const created = results.filter((row) => row.id);
  if (created.length && !upload.notification_sent_at) {
    const copy = classDiaryNotificationCopy(section?.class_name, section?.section_name);
    const recipients = await parentRecipientUserIds(schoolId, [classSectionId]);
    if (recipients.length) {
      await sendNotificationToUsers(
        recipients,
        'DIARY_UPDATED',
        { message: copy.message, message_te: copy.message },
        { role: 'parent', schoolId, deepLink: '/Screen/diary' },
      );
    }
    await sql`
      UPDATE class_diary_uploads
      SET notification_sent_at = now(), processing_status = ${sendOriginal ? 'original' : 'published'}
      WHERE id = ${upload.id} AND school_id = ${schoolId} AND notification_sent_at IS NULL
    `;
    await sql`
      UPDATE diary_entries
      SET notification_sent_at = COALESCE(notification_sent_at, now())
      WHERE school_id = ${schoolId} AND class_diary_upload_id = ${upload.id}
    `;
  }

  await logDiaryAnalytics({
    schoolId,
    teacherId: userInternalId,
    eventName: 'class_diary_published',
    properties: {
      class_section_id: classSectionId,
      subject_count: created.length,
      send_original: Boolean(sendOriginal),
      overall_confidence: upload.overall_confidence,
    },
  });

  return { upload, results, entries: created };
}
