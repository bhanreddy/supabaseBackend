import express from 'express';
import sql from '../db.js';
import { requirePermission } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { aiLimiter } from '../middleware/rateLimiter.js';
import {
  diaryPhotosUpload,
  diaryAudioUpload,
  handleDiaryUploadError,
} from '../middleware/diaryUpload.js';
import { preprocessForOcr, optimizeForParentView } from '../utils/diaryImagePreprocess.js';
import { uploadDiaryAttachment } from '../utils/diaryAttachmentStorage.js';
import { extractTextFromImage } from '../services/ai/ocrService.js';
import { transcribeAudio } from '../services/ai/speechToTextService.js';
import { extractDiaryFields } from '../services/ai/diaryExtractionService.js';
import { extractPhotoDiaryFromImage, extractClassDiaryFromImage } from '../services/smartDiary/classDiaryExtract.js';
import { confidenceLabel } from '../services/smartDiary/subjectMatch.js';
import {
  assertCanUploadClassDiary,
  loadClassSubjects,
} from '../services/smartDiary/classTeacherService.js';
import {
  publishClassDiary,
  upsertClassDiaryUpload,
  classDiaryNotificationCopy,
} from '../services/smartDiary/classDiaryPublish.js';
import { AI_FEATURES, assertWithinDailyLimit, logAiUsage } from '../services/ai/aiUsageService.js';
import { buildSmartDiaryContext } from '../services/smartDiary/contextService.js';
import {
  composeDiaryContent,
  composeDiaryTitle,
  publicStructuredFields,
} from '../services/smartDiary/composeContent.js';
import { lowConfidenceFields } from '../services/smartDiary/heuristicExtract.js';
import {
  isUuid,
  publishDiaryTargets,
  patchDiaryAiFields,
  buildProcessingMetadata,
  logDiaryAnalytics,
  teacherMayAccessAssignment,
} from '../services/smartDiary/publishService.js';
import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplateVariables,
  bumpTemplateUsage,
} from '../services/smartDiary/templateService.js';
import logger from '../utils/logger.js';

const router = express.Router();

const TEACHER_FRIENDLY = {
  ocr_unavailable: 'Text extraction is temporarily unavailable. You can still send the diary photo.',
  ocr_failed: "We couldn't read all the text clearly. You can edit it or send the original photo.",
  voice_unavailable: 'Voice transcription is temporarily unavailable. You can type or send a photo instead.',
  voice_failed: "We couldn't catch every word. You can speak again, edit, or send what we understood.",
  limit: "Today's text extraction limit has been reached. You can still send the diary photo.",
};

function friendlyAiError(code, fallback) {
  return TEACHER_FRIENDLY[code] || fallback || TEACHER_FRIENDLY.ocr_unavailable;
}

function contextFromBody(body = {}, current = null) {
  return {
    school_name: body.school_name,
    class_name: body.class_name || current?.class_name,
    section_name: body.section_name || current?.section_name,
    subject_name: body.subject_name || current?.subject_name,
    subject_id: body.subject_id || current?.subject_id,
    class_section_id: body.class_section_id || current?.class_section_id,
    teacher_name: body.teacher_name,
    today: body.entry_date || current?.today,
    period_number: body.period_number || current?.period_number,
  };
}

function previewFromExtraction(extraction, context, attachments = []) {
  const structured = publicStructuredFields(extraction);
  return {
    title: composeDiaryTitle(extraction, { subject_name: context.subject_name, hasPhoto: attachments.length > 0 }),
    content: composeDiaryContent(extraction, { hasPhoto: attachments.length > 0 }),
    structured,
    uncertain_fields: lowConfidenceFields(extraction),
    attachments,
  };
}

router.get('/context', requirePermission('diary.view'), asyncHandler(async (req, res) => {
  const data = await buildSmartDiaryContext({
    schoolId: req.schoolId,
    userId: req.user.id,
    userInternalId: req.user.internal_id,
    staffIdOverride: req.staffPortalAccess?.target_staff_id || null,
    displayName: req.user.displayName || req.user.display_name || req.user.name,
    roles: req.user.roles || [],
  });
  return sendSuccess(res, req.schoolId, data);
}));

router.get('/templates', requirePermission('diary.view'), asyncHandler(async (req, res) => {
  const grouped = await listTemplates({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
  });
  return sendSuccess(res, req.schoolId, grouped);
}));

router.post('/templates', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const { name, content, category, variables, scope, is_favourite } = req.body || {};
  if (!name || !content) {
    return sendError(res, 400, 'Template name and content are required');
  }
  const row = await createTemplate({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
    roles: req.user.roles || [],
    permissions: req.user.permissions || [],
    name,
    content,
    category,
    variables,
    scope,
    isFavourite: is_favourite,
  });
  return sendSuccess(res, req.schoolId, row, 201);
}));

router.put('/templates/:id', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const row = await updateTemplate({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
    roles: req.user.roles || [],
    permissions: req.user.permissions || [],
    id: req.params.id,
    patch: req.body || {},
  });
  if (!row) return sendError(res, 404, 'Template not found');
  return sendSuccess(res, req.schoolId, row);
}));

router.delete('/templates/:id', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const ok = await deleteTemplate({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
    roles: req.user.roles || [],
    permissions: req.user.permissions || [],
    id: req.params.id,
  });
  if (!ok) return sendError(res, 404, 'Template not found');
  return sendSuccess(res, req.schoolId, { message: 'Template deleted' });
}));

router.post('/templates/:id/render', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const [template] = await sql`
    SELECT * FROM diary_templates
    WHERE id = ${req.params.id}
      AND (scope = 'SYSTEM' OR school_id = ${req.schoolId})
  `;
  if (!template) return sendError(res, 404, 'Template not found');
  const rendered = applyTemplateVariables(template, req.body?.values || {});
  return sendSuccess(res, req.schoolId, rendered);
}));

router.post(
  '/upload',
  requirePermission('diary.create'),
  diaryPhotosUpload,
  handleDiaryUploadError,
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return sendError(res, 400, 'Please capture or choose a diary photo.');
    const attachments = [];
    for (const file of files) {
      const parentBuffer = await optimizeForParentView(file.buffer);
      const uploaded = await uploadDiaryAttachment({
        schoolId: req.schoolId,
        buffer: parentBuffer,
        mimeType: 'image/jpeg',
        kind: 'photos',
      });
      attachments.push(uploaded.url);
    }
    return sendSuccess(res, req.schoolId, { attachments, can_send: true });
  }),
);

router.post(
  '/extract',
  requirePermission('diary.create'),
  aiLimiter,
  diaryPhotosUpload,
  handleDiaryUploadError,
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) {
      return sendError(res, 400, 'Please capture or choose a diary photo.');
    }

    const context = contextFromBody(req.body);
    const attachments = [];
    const texts = [];
    let ocrStatus = 'skipped';
    let lastModel = null;
    let extraction = { originalText: '', homework: '', reminders: [] };
    let aiStatus = 'skipped';
    let usedFallback = false;

    try {
      await assertWithinDailyLimit(req.schoolId, AI_FEATURES.DIARY_PHOTO_AI);
    } catch (error) {
      for (const file of files) {
        const parentBuffer = await optimizeForParentView(file.buffer);
        const uploaded = await uploadDiaryAttachment({
          schoolId: req.schoolId,
          buffer: parentBuffer,
          mimeType: 'image/jpeg',
          kind: 'photos',
        });
        attachments.push(uploaded.url);
      }
      return sendSuccess(res, req.schoolId, {
        extraction: { originalText: '', homework: '', reminders: [] },
        preview: previewFromExtraction({}, context, attachments),
        ocr_status: 'unavailable',
        ai_status: 'skipped',
        message: friendlyAiError('limit'),
        can_send: true,
        attachments,
      });
    }

    for (const file of files) {
      const ocrBuffer = await preprocessForOcr(file.buffer);
      const parentBuffer = await optimizeForParentView(file.buffer);
      const uploaded = await uploadDiaryAttachment({
        schoolId: req.schoolId,
        buffer: parentBuffer,
        mimeType: 'image/jpeg',
        kind: 'photos',
      });
      attachments.push(uploaded.url);

      const started = Date.now();
      const vision = await extractPhotoDiaryFromImage({
        imageBuffer: ocrBuffer,
        mimeType: 'image/jpeg',
        context,
      });
      lastModel = vision.model;
      usedFallback = usedFallback || Boolean(vision.usedFallback);
      await logAiUsage({
        schoolId: req.schoolId,
        teacherId: req.user.internal_id,
        feature: AI_FEATURES.DIARY_PHOTO_AI,
        provider: vision.provider,
        model: vision.model,
        inputType: 'image',
        tokensIn: vision.tokensIn,
        tokensOut: vision.tokensOut,
        processingMs: Date.now() - started,
        success: !vision.error && Boolean(vision.homework || vision.originalText),
        errorCode: vision.error || null,
      });
      if (vision.originalText) texts.push(vision.originalText);
      extraction = vision;
      ocrStatus = vision.error ? 'failed' : (vision.homework || vision.originalText ? 'succeeded' : 'empty');
      aiStatus = vision.error ? 'failed' : 'succeeded';
    }

    const message = ocrStatus === 'failed' || ocrStatus === 'empty'
      ? friendlyAiError('ocr_failed')
      : null;

    return sendSuccess(res, req.schoolId, {
      extraction,
      preview: previewFromExtraction(extraction, context, attachments),
      ocr_status: ocrStatus,
      ai_status: aiStatus,
      message,
      can_send: true,
      attachments,
    });
  }),
);

router.post(
  '/transcribe',
  requirePermission('diary.create'),
  aiLimiter,
  diaryAudioUpload,
  handleDiaryUploadError,
  asyncHandler(async (req, res) => {
    if (!req.file) return sendError(res, 400, 'Please record a diary voice note.');
    const context = contextFromBody(req.body);

    try {
      await assertWithinDailyLimit(req.schoolId, AI_FEATURES.DIARY_VOICE);
    } catch {
      return sendSuccess(res, req.schoolId, {
        transcription: '',
        extraction: {},
        preview: previewFromExtraction({}, context),
        message: friendlyAiError('limit'),
        can_send: false,
      });
    }

    const started = Date.now();
    const stt = await transcribeAudio({
      audioBuffer: req.file.buffer,
      mimeType: req.file.mimetype,
      context,
    });
    await logAiUsage({
      schoolId: req.schoolId,
      teacherId: req.user.internal_id,
      feature: AI_FEATURES.DIARY_VOICE,
      provider: stt.provider,
      model: stt.model,
      inputType: 'audio',
      processingMs: Date.now() - started,
      success: !stt.error && Boolean(stt.text),
      errorCode: stt.error || null,
    });

    if (!stt.text) {
      return sendSuccess(res, req.schoolId, {
        transcription: '',
        extraction: {},
        preview: previewFromExtraction({}, context),
        message: friendlyAiError(stt.error === 'unavailable' ? 'voice_unavailable' : 'voice_failed'),
        can_send: false,
      });
    }

    const extractStarted = Date.now();
    const extraction = await extractDiaryFields({ rawText: stt.text, context });
    await logAiUsage({
      schoolId: req.schoolId,
      teacherId: req.user.internal_id,
      feature: AI_FEATURES.DIARY_EXTRACTION,
      provider: extraction.provider || 'heuristic',
      model: extraction.model,
      inputType: 'text',
      processingMs: Date.now() - extractStarted,
      success: !extraction.error,
      errorCode: extraction.error || null,
    });

    return sendSuccess(res, req.schoolId, {
      transcription: stt.text,
      extraction,
      preview: previewFromExtraction(extraction, context),
      detected_language: stt.detectedLanguage || extraction.detectedLanguage,
      can_send: true,
    });
  }),
);

router.post('/publish', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const classSectionIds = Array.isArray(body.class_section_ids) && body.class_section_ids.length
    ? body.class_section_ids
    : (body.class_section_id ? [body.class_section_id] : []);
  if (classSectionIds.length === 0) {
    return sendError(res, 400, 'Please choose a class.');
  }

  const attachments = Array.isArray(body.attachments) ? body.attachments.filter((url) => typeof url === 'string') : [];
  const extraction = body.extraction && typeof body.extraction === 'object' ? body.extraction : {};
  const content = String(body.content || composeDiaryContent(extraction, { hasPhoto: attachments.length > 0 })).trim();
  if (!content) {
    return sendError(res, 400, 'Please add homework details or a photo.');
  }

  const entryDate = String(body.entry_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const targets = classSectionIds.map((classSectionId, index) => ({
    class_section_id: classSectionId,
    subject_id: body.subject_ids?.[index] || body.subject_id || null,
    submission_id: body.submission_ids?.[index] || (index === 0 ? body.submission_id : null),
  }));

  const results = await publishDiaryTargets({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
    userId: req.user.id,
    roles: req.user.roles || [],
    targets,
    shared: {
      subject_id: body.subject_id || null,
      subject_name: body.subject_name || extraction.subject,
      entry_date: entryDate,
      title: body.title,
      content,
      homework_due_date: body.homework_due_date || extraction.dueDate,
      attachments,
      input_language: body.input_language || 'auto',
      entry_source: body.entry_source || 'MANUAL',
      original_text: body.original_text || extraction.originalText || null,
      processed_text: content,
      ocr_status: body.ocr_status || null,
      ai_status: body.ai_status || null,
      detected_language: body.detected_language || extraction.detectedLanguage || null,
      source_diary_id: isUuid(body.source_diary_id) ? body.source_diary_id : null,
      template_id: isUuid(body.template_id) ? body.template_id : null,
      processing_metadata: buildProcessingMetadata(extraction, {
        entrySource: body.entry_source,
        detectedLanguage: body.detected_language,
      }),
      extraction,
      notify: body.notify !== false,
      submission_id: body.submission_id,
    },
  });

  if (body.template_id && isUuid(body.template_id)) {
    await bumpTemplateUsage(body.template_id, req.schoolId);
  }

  await logDiaryAnalytics({
    schoolId: req.schoolId,
    teacherId: req.user.internal_id,
    eventName: 'diary_published',
    properties: {
      entry_source: body.entry_source || 'MANUAL',
      time_to_publish_ms: Number(body.time_to_publish_ms) || null,
      typing_required: Boolean(body.typing_required),
      class_count: classSectionIds.length,
      has_photo: attachments.length > 0,
      ocr_status: body.ocr_status || null,
      ai_status: body.ai_status || null,
    },
  });

  const created = results.filter((row) => row.id);
  if (created.length === 0) {
    return sendError(res, 400, results[0]?.error || 'Could not send this diary. You can try again or send the original photo.');
  }

  if (body.extract_async && attachments.length > 0 && !String(extraction.homework || extraction.originalText || '').trim()) {
    const diaryId = created[0].id;
    setImmediate(() => {
      runBackgroundExtraction({
        schoolId: req.schoolId,
        teacherId: req.user.internal_id,
        diaryId,
        attachments,
        context: contextFromBody(body),
      }).catch((error) => {
        logger.warn({ err: error, event: 'diary_background_extract_failed', diaryId }, 'Background diary extraction failed');
      });
    });
  }

  return sendSuccess(res, req.schoolId, {
    message: created.length > 1 ? 'Diary sent to selected classes.' : 'Diary posted successfully.',
    entries: created,
    results,
  }, created.some((row) => row.createdNew) ? 201 : 200);
}));

router.post('/copy', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const { source_id, class_section_ids, submission_ids, subject_id } = req.body || {};
  if (!isUuid(source_id) || !Array.isArray(class_section_ids) || class_section_ids.length === 0) {
    return sendError(res, 400, 'Choose a diary and at least one class.');
  }
  const [source] = await sql`
    SELECT * FROM diary_entries
    WHERE id = ${source_id} AND school_id = ${req.schoolId}
  `;
  if (!source) return sendError(res, 404, 'Diary entry not found');

  const today = new Date().toISOString().slice(0, 10);
  const results = await publishDiaryTargets({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
    userId: req.user.id,
    roles: req.user.roles || [],
    targets: class_section_ids.map((classSectionId, index) => ({
      class_section_id: classSectionId,
      subject_id: subject_id || source.subject_id,
      submission_id: submission_ids?.[index] || null,
    })),
    shared: {
      subject_id: subject_id || source.subject_id,
      entry_date: today,
      title: source.title,
      content: source.content,
      homework_due_date: source.homework_due_date,
      attachments: source.attachments,
      input_language: 'en',
      entry_source: 'COPIED',
      source_diary_id: source.id,
      processing_metadata: source.processing_metadata,
      notify: true,
    },
  });
  return sendSuccess(res, req.schoolId, { message: 'Diary copied.', results });
}));

router.post(
  '/class-diary/extract',
  requirePermission('diary.create'),
  aiLimiter,
  diaryPhotosUpload,
  handleDiaryUploadError,
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return sendError(res, 400, 'Please capture the class diary page.');
    const classSectionId = req.body?.class_section_id;
    const submissionId = isUuid(req.body?.submission_id) ? req.body.submission_id : null;
    const gate = await assertCanUploadClassDiary({
      schoolId: req.schoolId,
      userId: req.user.id,
      roles: req.user.roles || [],
      classSectionId,
    });
    if (!gate.ok) return sendError(res, gate.status, gate.error);

    const subjects = await loadClassSubjects(req.schoolId, classSectionId);
    const file = files[0];
    const ocrBuffer = await preprocessForOcr(file.buffer);
    const parentBuffer = await optimizeForParentView(file.buffer);
    const uploaded = await uploadDiaryAttachment({
      schoolId: req.schoolId,
      buffer: parentBuffer,
      mimeType: 'image/jpeg',
      kind: 'class-diary',
    });

    const entryDate = String(req.body?.entry_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (submissionId) {
      await upsertClassDiaryUpload({
        schoolId: req.schoolId,
        userInternalId: req.user.internal_id,
        classSectionId,
        entryDate,
        imageUrl: uploaded.url,
        submissionId,
        processingStatus: 'processing',
      });
    }

    let extracted = {
      classDiary: true,
      entries: [],
      overallConfidence: 0,
      error: 'unavailable',
    };
    try {
      await assertWithinDailyLimit(req.schoolId, AI_FEATURES.CLASS_DIARY_AI);
      const started = Date.now();
      extracted = await extractClassDiaryFromImage({
        imageBuffer: ocrBuffer,
        mimeType: 'image/jpeg',
        context: {
          school_name: req.body?.school_name,
          class_name: gate.section.class_name,
          section_name: gate.section.section_name,
          today: entryDate,
          subjects,
        },
      });
      await logAiUsage({
        schoolId: req.schoolId,
        teacherId: req.user.internal_id,
        feature: AI_FEATURES.CLASS_DIARY_AI,
        provider: extracted.provider,
        model: extracted.model,
        inputType: 'image',
        tokensIn: extracted.tokensIn,
        tokensOut: extracted.tokensOut,
        processingMs: Date.now() - started,
        success: !extracted.error && extracted.entries.length > 0,
        errorCode: extracted.error || null,
      });
      if (submissionId) {
        await upsertClassDiaryUpload({
          schoolId: req.schoolId,
          userInternalId: req.user.internal_id,
          classSectionId,
          entryDate,
          imageUrl: uploaded.url,
          submissionId,
          processingStatus: extracted.entries.length ? 'ready' : 'failed',
          overallConfidence: extracted.overallConfidence,
          extractedJson: extracted,
        });
      }
    } catch (error) {
      extracted.error = error.code === 'AI_DAILY_LIMIT' ? 'limit' : (extracted.error || 'unavailable');
    }

    const entries = (extracted.entries || []).map((entry) => ({
      ...entry,
      confidence_label: confidenceLabel(entry.confidence),
    }));

    return sendSuccess(res, req.schoolId, {
      class_section_id: classSectionId,
      class_name: gate.section.class_name,
      section_name: gate.section.section_name,
      entry_date: entryDate,
      submission_id: submissionId,
      image_url: uploaded.url,
      subjects,
      entries,
      overall_confidence: extracted.overallConfidence,
      used_fallback: Boolean(extracted.usedFallback),
      can_send_original: true,
      message: entries.length
        ? null
        : 'We couldn\'t read the diary automatically.',
    });
  }),
);

router.post('/class-diary/publish', requirePermission('diary.create'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const classSectionId = body.class_section_id;
  const gate = await assertCanUploadClassDiary({
    schoolId: req.schoolId,
    userId: req.user.id,
    roles: req.user.roles || [],
    classSectionId,
  });
  if (!gate.ok) return sendError(res, gate.status, gate.error);
  if (!isUuid(body.submission_id)) {
    return sendError(res, 400, 'Missing diary submission. Please capture again.');
  }
  const imageUrl = typeof body.image_url === 'string' ? body.image_url : '';
  if (!imageUrl) return sendError(res, 400, 'The diary photo is missing. Please capture again.');

  const entryDate = String(body.entry_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const result = await publishClassDiary({
    schoolId: req.schoolId,
    userInternalId: req.user.internal_id,
    classSectionId,
    entryDate,
    imageUrl,
    sourceImageUrl: body.source_image_url || imageUrl,
    submissionId: body.submission_id,
    entries: Array.isArray(body.entries) ? body.entries : [],
    sendOriginal: Boolean(body.send_original),
    section: gate.section,
  });

  const published = result.entries.length;
  if (published === 0 && !body.send_original) {
    return sendError(res, 400, 'Select at least one subject, or send the original photo.');
  }

  return sendSuccess(res, req.schoolId, {
    message: body.send_original
      ? 'Original class diary photo sent.'
      : `Published ${published} subject ${published === 1 ? 'entry' : 'entries'}.`,
    upload_id: result.upload.id,
    entries: result.entries,
    results: result.results,
    notification: classDiaryNotificationCopy(gate.section.class_name, gate.section.section_name),
  }, 201);
}));

async function runBackgroundExtraction({ schoolId, teacherId, diaryId, attachments, context }) {
  const url = (attachments || []).find((item) => typeof item === 'string' && /^https?:\/\//i.test(item));
  if (!url) {
    await patchDiaryAiFields(schoolId, diaryId, { ocrStatus: 'skipped', aiStatus: 'skipped' }, { notify: false });
    return;
  }

  let ocrStatus = 'failed';
  let rawText = '';
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('fetch_failed');
    const buffer = Buffer.from(await response.arrayBuffer());
    const ocrBuffer = await preprocessForOcr(buffer);
    const started = Date.now();
    const ocr = await extractTextFromImage({
      imageBuffer: ocrBuffer,
      mimeType: 'image/jpeg',
      context,
    });
    await logAiUsage({
      schoolId,
      teacherId,
      feature: AI_FEATURES.DIARY_OCR,
      provider: ocr.provider,
      model: ocr.model,
      inputType: 'image',
      processingMs: Date.now() - started,
      success: !ocr.error && Boolean(ocr.text),
      errorCode: ocr.error || null,
    });
    rawText = ocr.text || '';
    ocrStatus = rawText ? 'succeeded' : (ocr.error ? 'failed' : 'empty');
  } catch (error) {
    await logAiUsage({
      schoolId,
      teacherId,
      feature: AI_FEATURES.DIARY_OCR,
      provider: 'gemini',
      inputType: 'image',
      success: false,
      errorCode: error.message || 'ocr_failed',
    });
  }

  if (!rawText) {
    await patchDiaryAiFields(schoolId, diaryId, { ocrStatus, aiStatus: 'skipped' }, { notify: false });
    return;
  }

  const extraction = await extractDiaryFields({ rawText, context });
  const content = composeDiaryContent(extraction, { hasPhoto: true });
  const title = composeDiaryTitle(extraction, { subject_name: context.subject_name, hasPhoto: true });
  await patchDiaryAiFields(schoolId, diaryId, {
    title,
    content,
    originalText: rawText,
    processedText: content,
    ocrStatus,
    aiStatus: extraction.error ? 'failed' : 'succeeded',
    detectedLanguage: extraction.detectedLanguage,
    homeworkDueDate: extraction.dueDate || null,
    processingMetadata: buildProcessingMetadata(extraction, { entrySource: 'PHOTO' }),
  }, { notify: false });
}

export default router;
export { teacherMayAccessAssignment, previewFromExtraction };
