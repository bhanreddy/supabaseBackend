/**
 * SchoolIMS — OMR Engine Routes
 * Full-stack examination evaluation subsystem API mounted at /api/v1/omr.
 * Strict multi-tenant isolation via req.schoolId (derived solely from verified JWT).
 */

import express from 'express';
import multer from 'multer';
import sql from '../db.js';
import { requireAuth, requirePermission, requireAnyPermission } from '../middleware/auth.js';
import { calculateTemplateGeometry, generateSheetSvg } from '../services/omr/omrTemplateEngine.js';
import { processOmrImage } from '../services/omr/omrVisionEngine.js';
import {
  evaluateAnswers,
  saveEvaluatedScan,
  finalizeExamResults,
  resolveEnrollment,
  normalizeDetectedAnswers,
} from '../services/omr/omrEvaluationEngine.js';
import { getOmrExamAnalytics } from '../services/omr/omrAnalyticsService.js';
import { OmrUserError, OMR_USER_MESSAGES, logOmrDiagnostic } from '../services/omr/omrErrors.js';
import {
  encodeOmrQrPayload,
  decodeOmrQrPayload,
  generateSheetId,
  hashImageBuffer,
  validateQrAgainstExam,
} from '../services/omr/omrQr.js';

const router = express.Router();
const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max
  storage: multer.memoryStorage()
});

// All routes require authentication
router.use(requireAuth);

// Helper for error handling
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. OMR TEMPLATES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/omr/templates
 * List available templates for the authenticated school
 */
router.get('/templates', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const templates = await sql`
    SELECT id, name, code, layout_type, page_size, total_questions,
           options_per_question, has_roll_number_grid, roll_number_digits,
           has_qr_header, is_system, created_at
    FROM omr_templates
    WHERE school_id = ${req.schoolId} AND deleted_at IS NULL
    ORDER BY is_system DESC, name ASC
  `;
  res.json({ success: true, data: templates });
}));

/**
 * GET /api/v1/omr/templates/:id
 */
router.get('/templates/:id', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const [template] = await sql`
    SELECT * FROM omr_templates
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const geometry = calculateTemplateGeometry(template);
  res.json({ success: true, data: { ...template, calculatedGeometry: geometry } });
}));

/**
 * GET /api/v1/omr/papers
 * Existing SchoolIMS exam papers that can be bound to an OMR exam.
 */
router.get('/papers', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const papers = await sql`
    SELECT es.id, e.id as exam_id, e.name as exam_name, e.exam_type,
           s.name as subject_name, c.name as class_name, es.max_marks,
           es.exam_date::text as exam_date, ay.code as academic_year,
           EXISTS(
             SELECT 1 FROM omr_exams oe
             WHERE oe.exam_subject_id = es.id AND oe.school_id = ${req.schoolId} AND oe.deleted_at IS NULL
           ) as has_omr
    FROM exam_subjects es
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId} AND e.deleted_at IS NULL
    JOIN subjects s ON s.id = es.subject_id AND s.school_id = ${req.schoolId}
    JOIN classes c ON c.id = es.class_id AND c.school_id = ${req.schoolId}
    JOIN academic_years ay ON ay.id = e.academic_year_id AND ay.school_id = ${req.schoolId}
    WHERE es.school_id = ${req.schoolId} AND es.deleted_at IS NULL
    ORDER BY e.start_date DESC NULLS LAST, e.name ASC, s.name ASC
    LIMIT 300
  `;
  res.json({ success: true, data: papers });
}));

/**
 * GET /api/v1/omr/settings
 */
router.get('/settings', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const fallback = {
    school_id: req.schoolId,
    evidence_retention_days: 30,
    high_confidence_min: 90,
    review_recommended_min: 70,
    auto_capture_enabled: true,
  };
  try {
    const [settings] = await sql`
      SELECT * FROM omr_settings WHERE school_id = ${req.schoolId} LIMIT 1
    `;
    res.json({ success: true, data: settings || fallback });
  } catch {
    res.json({ success: true, data: fallback });
  }
}));

router.put('/settings', requirePermission('omr.manage_template'), asyncHandler(async (req, res) => {
  const {
    evidence_retention_days = 30,
    high_confidence_min = 90,
    review_recommended_min = 70,
    auto_capture_enabled = true,
  } = req.body;
  const [saved] = await sql`
    INSERT INTO omr_settings (
      school_id, evidence_retention_days, high_confidence_min, review_recommended_min, auto_capture_enabled, updated_at
    ) VALUES (
      ${req.schoolId}, ${evidence_retention_days}, ${high_confidence_min}, ${review_recommended_min}, ${auto_capture_enabled}, now()
    )
    ON CONFLICT (school_id) DO UPDATE SET
      evidence_retention_days = EXCLUDED.evidence_retention_days,
      high_confidence_min = EXCLUDED.high_confidence_min,
      review_recommended_min = EXCLUDED.review_recommended_min,
      auto_capture_enabled = EXCLUDED.auto_capture_enabled,
      updated_at = now()
    RETURNING *
  `;
  await sql`
    INSERT INTO omr_audit_logs (school_id, user_id, action, entity, entity_id, new_values, reason)
    VALUES (
      ${req.schoolId}, ${req.user.internal_id}, 'UPDATE_SETTINGS', 'omr_settings', ${String(req.schoolId)},
      ${JSON.stringify(saved)}, 'Updated OMR engine settings'
    )
  `;
  res.json({ success: true, data: saved });
}));

/**
 * GET /api/v1/omr/templates/:id/sheet-svg
 * Generates an ultra-crisp printable SVG representation of the template
 */
router.get('/templates/:id/sheet-svg', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const [template] = await sql`
    SELECT * FROM omr_templates
    WHERE id = ${req.params.id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
    LIMIT 1
  `;
  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const [school] = await sql`SELECT name FROM schools WHERE id = ${req.schoolId} LIMIT 1`;
  const schoolName = school?.name || 'SchoolIMS Academy';

  const svg = generateSheetSvg({
    schoolName,
    examTitle: req.query.title || 'OMR ASSESSMENT SHEET',
    sheetId: req.query.sheetId || `SHT-${Date.now().toString(36).toUpperCase()}`,
    examId: req.query.examId || 'EXAM-OMR',
    templateCode: template.code,
    studentName: req.query.studentName || '',
    rollNumber: req.query.rollNumber || ''
  });

  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
}));

// ─────────────────────────────────────────────────────────────────────────────
// 2. OMR EXAM CONFIGURATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/omr/exams
 * List configured OMR exams
 */
router.get('/exams', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const exams = await sql`
    SELECT oe.id, oe.title, oe.status, oe.positive_marks_per_question,
           oe.negative_marks_per_question, oe.confidence_threshold,
           oe.created_at, es.id as exam_subject_id, es.max_marks, es.exam_date,
           s.name as subject_name, c.name as class_name, e.name as exam_name,
           t.name as template_name, t.total_questions, t.total_questions as question_count, t.options_per_question,
           (SELECT COUNT(*)::int FROM omr_scans sc WHERE sc.omr_exam_id = oe.id) as total_scans,
           (SELECT COUNT(*)::int FROM omr_scans sc WHERE sc.omr_exam_id = oe.id AND sc.status = 'FINALIZED') as finalized_scans,
           (SELECT COUNT(*)::int FROM omr_scans sc WHERE sc.omr_exam_id = oe.id AND sc.status = 'REVIEW_REQUIRED') as pending_reviews
    FROM omr_exams oe
    JOIN exam_subjects es ON es.id = oe.exam_subject_id AND es.school_id = ${req.schoolId}
    JOIN subjects s ON s.id = es.subject_id
    JOIN classes c ON c.id = es.class_id
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    JOIN omr_templates t ON t.id = oe.template_id AND t.school_id = ${req.schoolId}
    WHERE oe.school_id = ${req.schoolId} AND oe.deleted_at IS NULL
    ORDER BY oe.created_at DESC
  `;
  res.json({ success: true, data: exams });
}));

/**
 * POST /api/v1/omr/exams
 * Creates a new OMR Exam bound to an existing exam_subject
 */
router.post('/exams', requirePermission('omr.create_exam'), asyncHandler(async (req, res) => {
  const {
    exam_subject_id,
    template_id,
    title,
    instructions,
    positive_marks = 1.0,
    negative_marks = 0.0,
    blank_marks = 0.0,
    multiple_answer_behavior = 'invalid',
    confidence_threshold = 70.0
  } = req.body;

  if (!exam_subject_id || !template_id) {
    return res.status(400).json({ error: 'exam_subject_id and template_id are required' });
  }

  // Verify ownership of exam_subject
  const [examSubject] = await sql`
    SELECT es.id, es.exam_id, e.name as exam_name, s.name as subject_name
    FROM exam_subjects es
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    JOIN subjects s ON s.id = es.subject_id
    WHERE es.id = ${exam_subject_id} AND es.school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!examSubject) {
    return res.status(404).json({ error: 'Exam subject not found in this school' });
  }

  const defaultTitle = title || `${examSubject.exam_name} - ${examSubject.subject_name} OMR`;

  const [omrExam] = await sql`
    INSERT INTO omr_exams (
      school_id, exam_subject_id, template_id, title, instructions,
      positive_marks_per_question, negative_marks_per_question, blank_marks_per_question,
      multiple_answer_behavior, confidence_threshold, status, created_by
    ) VALUES (
      ${req.schoolId}, ${exam_subject_id}, ${template_id}, ${defaultTitle}, ${instructions},
      ${positive_marks}, ${negative_marks}, ${blank_marks},
      ${multiple_answer_behavior}, ${confidence_threshold}, 'draft', ${req.user.internal_id}
    )
    RETURNING *
  `;

  // Audit
  await sql`
    INSERT INTO omr_audit_logs (
      school_id, user_id, action, entity, entity_id, new_values, reason
    ) VALUES (
      ${req.schoolId}, ${req.user.internal_id}, 'CREATE_EXAM', 'omr_exam', ${omrExam.id},
      ${JSON.stringify({ exam_subject_id, template_id, defaultTitle })}, 'Created OMR exam configuration'
    )
  `;

  res.status(201).json({ success: true, data: omrExam });
}));

/**
 * GET /api/v1/omr/exams/:id
 */
router.get('/exams/:id', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const [exam] = await sql`
    SELECT oe.*, es.max_marks, es.passing_marks, es.class_id, es.exam_id,
           s.name as subject_name, c.name as class_name, e.name as exam_name,
           t.name as template_name, t.code as template_code, t.total_questions,
           t.options_per_question, t.has_roll_number_grid
    FROM omr_exams oe
    JOIN exam_subjects es ON es.id = oe.exam_subject_id AND es.school_id = ${req.schoolId}
    JOIN subjects s ON s.id = es.subject_id
    JOIN classes c ON c.id = es.class_id
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    JOIN omr_templates t ON t.id = oe.template_id AND t.school_id = ${req.schoolId}
    WHERE oe.id = ${req.params.id} AND oe.school_id = ${req.schoolId} AND oe.deleted_at IS NULL
    LIMIT 1
  `;
  if (!exam) {
    return res.status(404).json({ error: 'OMR Exam not found' });
  }

  // Active answer key
  const [answerKey] = await sql`
    SELECT ak.id, ak.version, ak.status, ak.published_at, ak.published_by
    FROM omr_answer_keys ak
    WHERE ak.omr_exam_id = ${exam.id} AND ak.school_id = ${req.schoolId}
    ORDER BY ak.version DESC
    LIMIT 1
  `;

  let questions = [];
  if (answerKey) {
    questions = await sql`
      SELECT question_number, correct_option, weightage, negative_weightage
      FROM omr_answer_key_questions
      WHERE answer_key_id = ${answerKey.id} AND school_id = ${req.schoolId}
      ORDER BY question_number ASC
    `;
  }

  res.json({
    success: true,
    data: {
      ...exam,
      activeAnswerKey: answerKey ? { ...answerKey, questions } : null
    }
  });
}));

/**
 * GET /api/v1/omr/exams/:id/answer-key
 */
router.get(
  '/exams/:id/answer-key',
  requireAnyPermission(['omr.view', 'omr.create_answer_key']),
  asyncHandler(async (req, res) => {
    const [key] = await sql`
      SELECT ak.id, ak.version, ak.status, ak.published_at, ak.published_by, ak.change_reason, ak.created_at
      FROM omr_answer_keys ak
      WHERE ak.omr_exam_id = ${req.params.id} AND ak.school_id = ${req.schoolId}
      ORDER BY ak.version DESC
      LIMIT 1
    `;
    if (!key) {
      return res.json({ success: true, data: null });
    }
    const questions = await sql`
      SELECT question_number, correct_option, weightage, negative_weightage
      FROM omr_answer_key_questions
      WHERE answer_key_id = ${key.id} AND school_id = ${req.schoolId}
      ORDER BY question_number ASC
    `;
    res.json({ success: true, data: { ...key, questions } });
  })
);

/**
 * GET /api/v1/omr/exams/:id/sheets
 * Prepares printable sheet identities (QR payload + sheet_id) for enrolled students.
 */
router.get('/exams/:id/sheets', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const [omrExam] = await sql`
    SELECT oe.id, oe.template_id, oe.title, t.code as template_code, es.class_id, e.academic_year_id
    FROM omr_exams oe
    JOIN omr_templates t ON t.id = oe.template_id
    JOIN exam_subjects es ON es.id = oe.exam_subject_id AND es.school_id = ${req.schoolId}
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${req.schoolId}
    WHERE oe.id = ${req.params.id} AND oe.school_id = ${req.schoolId} AND oe.deleted_at IS NULL
    LIMIT 1
  `;
  if (!omrExam) return res.status(404).json({ error: 'OMR Exam not found' });

  const students = await sql`
    SELECT se.id as student_enrollment_id, se.student_id, se.roll_number,
           p.first_name, p.last_name, s.admission_no
    FROM student_enrollments se
    JOIN students s ON s.id = se.student_id AND s.school_id = ${req.schoolId} AND s.deleted_at IS NULL
    JOIN persons p ON p.id = s.person_id
    JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = ${req.schoolId}
    WHERE cs.class_id = ${omrExam.class_id}
      AND se.academic_year_id = ${omrExam.academic_year_id}
      AND se.school_id = ${req.schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    ORDER BY se.roll_number ASC NULLS LAST, p.first_name ASC
  `;

  const sheets = students.map((st) => {
    const sheetId = generateSheetId({
      schoolId: req.schoolId,
      omrExamId: omrExam.id,
      studentEnrollmentId: st.student_enrollment_id,
    });
    return {
      sheet_id: sheetId,
      student_enrollment_id: st.student_enrollment_id,
      student_id: st.student_id,
      roll_number: st.roll_number,
      first_name: st.first_name,
      last_name: st.last_name,
      admission_no: st.admission_no,
      qr_payload: encodeOmrQrPayload({
        examId: omrExam.id,
        sheetId,
        templateId: omrExam.template_id,
        templateVersion: 1,
        studentId: st.student_id,
      }),
    };
  });

  res.json({ success: true, data: { exam: { id: omrExam.id, title: omrExam.title, template_code: omrExam.template_code }, sheets } });
}));

router.get('/templates/:id/svg', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  req.url = `/templates/${req.params.id}/sheet-svg`;
  return res.redirect(req.originalUrl.replace(/\/svg(\?|$)/, '/sheet-svg$1'));
}));

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANSWER KEY MAPPING (Admin, Staff, Accountant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/omr/exams/:id/answer-key
 * Create or update an answer key version.
 * Supports manual array: [{ question_number: 1, correct_option: 'B' }]
 * or bulk text format: "1-B 2-C 3-A 4-D"
 */
router.post(
  '/exams/:id/answer-key',
  requireAnyPermission(['omr.create_answer_key', 'omr.edit_answer_key']),
  asyncHandler(async (req, res) => {
    const { questions, bulkText, change_reason } = req.body;
    const omrExamId = req.params.id;

    // Verify exam exists
    const [omrExam] = await sql`
      SELECT oe.id, oe.template_id, t.total_questions, t.options_per_question
      FROM omr_exams oe
      JOIN omr_templates t ON t.id = oe.template_id
      WHERE oe.id = ${omrExamId} AND oe.school_id = ${req.schoolId}
      LIMIT 1
    `;
    if (!omrExam) {
      return res.status(404).json({ error: 'OMR Exam not found' });
    }

    // Parse input questions
    let parsedQuestions = [];
    if (Array.isArray(questions) && questions.length > 0) {
      parsedQuestions = questions.map((q) => ({
        question_number: Number(q.question_number),
        correct_option: String(q.correct_option).toUpperCase().trim(),
        weightage: q.weightage != null ? Number(q.weightage) : 1.0,
        negative_weightage: q.negative_weightage != null ? Number(q.negative_weightage) : 0.0
      }));
    } else if (typeof bulkText === 'string' && bulkText.trim()) {
      // Parse bulk format like "1-B 2-C 3:A 4.D"
      const tokens = bulkText.trim().split(/[\s,;\n]+/);
      tokens.forEach((token) => {
        const match = token.match(/^(\d+)[\-.:= ]*([A-Za-z0-9,]+)$/);
        if (match) {
          parsedQuestions.push({
            question_number: parseInt(match[1], 10),
            correct_option: match[2].toUpperCase(),
            weightage: 1.0,
            negative_weightage: 0.0
          });
        }
      });
    }

    if (parsedQuestions.length === 0) {
      return res.status(400).json({ error: 'Valid questions array or bulk text mapping required' });
    }

    // Get latest version
    const [latestKey] = await sql`
      SELECT id, version, status FROM omr_answer_keys
      WHERE omr_exam_id = ${omrExamId} AND school_id = ${req.schoolId}
      ORDER BY version DESC LIMIT 1
    `;

    const savedKey = await sql.begin(async (tx) => {
      let keyRecord;
      let previousQuestions = [];

      if (latestKey && latestKey.status === 'draft') {
        previousQuestions = await tx`
          SELECT question_number, correct_option
          FROM omr_answer_key_questions
          WHERE answer_key_id = ${latestKey.id} AND school_id = ${req.schoolId}
        `;
        await tx`DELETE FROM omr_answer_key_questions WHERE answer_key_id = ${latestKey.id} AND school_id = ${req.schoolId}`;
        const [updated] = await tx`
          UPDATE omr_answer_keys
          SET change_reason = ${change_reason || latestKey.change_reason || `Answer Key Version ${latestKey.version}`},
              updated_at = now()
          WHERE id = ${latestKey.id}
          RETURNING *
        `;
        keyRecord = updated;
      } else {
        const newVersion = latestKey ? latestKey.version + 1 : 1;
        if (latestKey) {
          previousQuestions = await tx`
            SELECT question_number, correct_option
            FROM omr_answer_key_questions
            WHERE answer_key_id = ${latestKey.id} AND school_id = ${req.schoolId}
          `;
        }
        const [created] = await tx`
          INSERT INTO omr_answer_keys (
            school_id, omr_exam_id, version, status, change_reason, created_by
          ) VALUES (
            ${req.schoolId}, ${omrExamId}, ${newVersion}, 'draft',
            ${change_reason || `Answer Key Version ${newVersion}`}, ${req.user.internal_id}
          )
          RETURNING *
        `;
        keyRecord = created;
      }

      const diffs = [];
      for (const q of parsedQuestions) {
        await tx`
          INSERT INTO omr_answer_key_questions (
            school_id, answer_key_id, question_number, correct_option, weightage, negative_weightage
          ) VALUES (
            ${req.schoolId}, ${keyRecord.id}, ${q.question_number}, ${q.correct_option},
            ${q.weightage}, ${q.negative_weightage}
          )
        `;
        const prev = previousQuestions.find((p) => Number(p.question_number) === Number(q.question_number));
        const prevAns = prev?.correct_option || null;
        if (prevAns !== q.correct_option) {
          diffs.push({
            question_number: q.question_number,
            previous_answer: prevAns,
            new_answer: q.correct_option,
          });
        }
      }

      await tx`
        INSERT INTO omr_audit_logs (
          school_id, user_id, action, entity, entity_id, new_values, reason
        ) VALUES (
          ${req.schoolId}, ${req.user.internal_id}, 'CREATE_ANSWER_KEY', 'omr_answer_key', ${keyRecord.id},
          ${JSON.stringify({ version: keyRecord.version, questionCount: parsedQuestions.length, diffs })},
          ${change_reason || 'Saved answer key version'}
        )
      `;

      return keyRecord;
    });

    res.status(201).json({
      success: true,
      data: {
        ...savedKey,
        questionCount: parsedQuestions.length,
        questions: parsedQuestions
      }
    });
  })
);

/**
 * POST /api/v1/omr/exams/:id/answer-key/publish
 * Publishes an answer key version for official evaluation.
 */
router.post(
  '/exams/:id/answer-key/publish',
  requirePermission('omr.publish_answer_key'),
  asyncHandler(async (req, res) => {
    const { version } = req.body;
    const omrExamId = req.params.id;

    const [key] = await sql`
      SELECT id, version, status FROM omr_answer_keys
      WHERE omr_exam_id = ${omrExamId} AND school_id = ${req.schoolId}
        ${version ? sql`AND version = ${version}` : sql``}
      ORDER BY version DESC LIMIT 1
    `;

    if (!key) {
      return res.status(404).json({ error: 'Answer key not found' });
    }

    // Mark previous as superseded and this as published
    await sql.begin(async (tx) => {
      await tx`
        UPDATE omr_answer_keys
        SET status = 'superseded'
        WHERE omr_exam_id = ${omrExamId} AND school_id = ${req.schoolId} AND status = 'published'
      `;

      await tx`
        UPDATE omr_answer_keys
        SET status = 'published', published_at = now(), published_by = ${req.user.internal_id}, updated_at = now()
        WHERE id = ${key.id}
      `;

      await tx`
        INSERT INTO omr_audit_logs (
          school_id, user_id, action, entity, entity_id, new_values, reason
        ) VALUES (
          ${req.schoolId}, ${req.user.internal_id}, 'PUBLISH_ANSWER_KEY', 'omr_answer_key', ${key.id},
          ${JSON.stringify({ version: key.version })}, 'Published answer key for evaluation'
        )
      `;
    });

    res.json({ success: true, message: `Answer Key v${key.version} published successfully` });
  })
);

/**
 * POST /api/v1/omr/exams/:id/answer-key/scan
 * Scans a teacher master sheet to automatically generate the answer key.
 */
router.post(
  '/exams/:id/answer-key/scan',
  requirePermission('omr.create_answer_key'),
  upload.single('sheetImage'),
  asyncHandler(async (req, res) => {
    let imageBuffer = null;
    if (req.file) {
      imageBuffer = req.file.buffer;
    } else if (req.body.imageBase64) {
      imageBuffer = Buffer.from(req.body.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }

    if (!imageBuffer) {
      return res.status(400).json({ error: 'No image provided (multipart file or imageBase64 required)' });
    }

    const [omrExam] = await sql`
      SELECT oe.id, t.code as template_code
      FROM omr_exams oe
      JOIN omr_templates t ON t.id = oe.template_id
      WHERE oe.id = ${req.params.id} AND oe.school_id = ${req.schoolId}
      LIMIT 1
    `;
    if (!omrExam) {
      return res.status(404).json({ error: 'OMR Exam not found' });
    }

    // Process image through vision engine
    const visionResult = await processOmrImage(imageBuffer, {
      templateCode: omrExam.template_code
    });

    // Extract detected answers
    const keyQuestions = visionResult.answers
      .filter((a) => a.detectedOption !== 'BLANK' && !a.isMultiple)
      .map((a) => ({
        question_number: a.questionNumber,
        correct_option: a.detectedOption,
        weightage: 1.0,
        negative_weightage: 0.0
      }));

    res.json({
      success: true,
      message: `Extracted ${keyQuestions.length} answers from scanned sheet`,
      quality: visionResult.quality,
      questions: keyQuestions,
      data: {
        detected_key: Object.fromEntries(keyQuestions.map((q) => [q.question_number, q.correct_option])),
      }
    });
  })
);

router.post(
  '/answer-keys/scan-master',
  requirePermission('omr.create_answer_key'),
  upload.single('sheetImage'),
  asyncHandler(async (req, res) => {
    req.params.id = req.body.exam_id;
    req.body.imageBase64 = req.body.image_base64 || req.body.imageBase64;
    if (!req.params.id) {
      return res.status(400).json({ error: 'exam_id is required' });
    }
    const [omrExam] = await sql`
      SELECT oe.id, t.code as template_code
      FROM omr_exams oe
      JOIN omr_templates t ON t.id = oe.template_id
      WHERE oe.id = ${req.params.id} AND oe.school_id = ${req.schoolId}
      LIMIT 1
    `;
    if (!omrExam) return res.status(404).json({ error: 'OMR Exam not found' });
    let imageBuffer = req.file?.buffer || null;
    if (!imageBuffer && req.body.imageBase64) {
      imageBuffer = Buffer.from(String(req.body.imageBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }
    if (!imageBuffer) return res.status(400).json({ error: 'No image provided' });
    const visionResult = await processOmrImage(imageBuffer, { templateCode: omrExam.template_code });
    const keyQuestions = visionResult.answers
      .filter((a) => a.detectedOption !== 'BLANK' && !a.isMultiple)
      .map((a) => ({ question_number: a.questionNumber, correct_option: a.detectedOption }));
    res.json({
      success: true,
      message: `Extracted ${keyQuestions.length} answers from scanned sheet`,
      data: { detected_key: Object.fromEntries(keyQuestions.map((q) => [q.question_number, q.correct_option])) },
      questions: keyQuestions,
      quality: visionResult.quality,
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. SCAN INTAKE & VISION EVALUATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/omr/scan
 * Single sheet camera scan evaluation endpoint.
 * Accepts multipart or JSON base64.
 */
router.post('/scan', requirePermission('omr.scan'), upload.single('sheetImage'), asyncHandler(async (req, res) => {
  let imageBuffer = null;
  if (req.file) {
    imageBuffer = req.file.buffer;
  } else if (req.body.imageBase64) {
    imageBuffer = Buffer.from(req.body.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  }

  if (!imageBuffer) {
    return res.status(400).json({ error: 'No sheet image provided' });
  }

  const {
    omr_exam_id,
    batch_id = null,
    sheet_id,
    client_scan_id = null,
    student_enrollment_id = null,
    qr_payload = null,
    replace_existing = false,
    device_id = null,
  } = req.body;

  if (!omr_exam_id) {
    return res.status(400).json({ error: 'omr_exam_id is required' });
  }

  const [omrExam] = await sql`
    SELECT oe.*, t.code as template_code, t.id as template_uuid, es.class_id, es.exam_id
    FROM omr_exams oe
    JOIN omr_templates t ON t.id = oe.template_id
    JOIN exam_subjects es ON es.id = oe.exam_subject_id
    WHERE oe.id = ${omr_exam_id} AND oe.school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!omrExam) {
    return res.status(404).json({ error: 'OMR Exam not found' });
  }

  const qr = decodeOmrQrPayload(qr_payload) || decodeOmrQrPayload(typeof qr_payload === 'object' ? JSON.stringify(qr_payload) : null);
  const qrCheck = validateQrAgainstExam(qr, { id: omrExam.id, template_id: omrExam.template_id });
  if (!qrCheck.ok) {
    logOmrDiagnostic(req, 'qr_mismatch', { code: qrCheck.code, omr_exam_id });
    throw new OmrUserError(
      qrCheck.code === 'TEMPLATE_MISMATCH' ? OMR_USER_MESSAGES.WRONG_TEMPLATE : OMR_USER_MESSAGES.WRONG_EXAM,
      409,
      qrCheck.code
    );
  }

  const [publishedKey] = await sql`
    SELECT id, version FROM omr_answer_keys
    WHERE omr_exam_id = ${omr_exam_id} AND school_id = ${req.schoolId} AND status = 'published'
    ORDER BY version DESC LIMIT 1
  `;

  if (!publishedKey) {
    throw new OmrUserError(OMR_USER_MESSAGES.NO_ANSWER_KEY, 400, 'NO_ANSWER_KEY');
  }

  if (client_scan_id) {
    const [existingClient] = await sql`
      SELECT id, sheet_id, status, overall_confidence, detected_roll_number, total_score, max_possible_score, percentage
      FROM omr_scans
      WHERE school_id = ${req.schoolId} AND client_scan_id = ${client_scan_id}
      LIMIT 1
    `;
    if (existingClient) {
      return res.json({
        success: true,
        data: {
          scanId: existingClient.id,
          sheetId: existingClient.sheet_id,
          status: existingClient.status,
          overallConfidence: existingClient.overall_confidence,
          detectedRollNumber: existingClient.detected_roll_number,
          idempotent: true,
          evaluation: {
            totalScore: existingClient.total_score,
            maxPossibleScore: existingClient.max_possible_score,
            percentage: existingClient.percentage,
          },
        }
      });
    }
  }

  const answerKeyQuestions = await sql`
    SELECT question_number, correct_option, weightage, negative_weightage
    FROM omr_answer_key_questions
    WHERE answer_key_id = ${publishedKey.id} AND school_id = ${req.schoolId}
  `;

  const visionResult = await processOmrImage(imageBuffer, {
    templateCode: omrExam.template_code,
    expectedExamId: omrExam.id,
    confidenceThreshold: Number(omrExam.confidence_threshold) || 70,
    reviewThreshold: Number(omrExam.review_threshold) || 50
  });

  if (visionResult.scanStatus === 'REJECTED') {
    logOmrDiagnostic(req, 'scan_rejected', { exceptionType: visionResult.exceptionType, quality: visionResult.quality });
    return res.status(422).json({
      success: false,
      error: visionResult.quality?.guidance || OMR_USER_MESSAGES.POOR_QUALITY,
      code: 'SCAN_REJECTED',
      quality: visionResult.quality,
    });
  }

  let resolvedStudent = null;
  try {
    resolvedStudent = await resolveEnrollment({
      schoolId: req.schoolId,
      classId: omrExam.class_id,
      enrollmentId: student_enrollment_id || null,
      rollNumber: visionResult.detectedRollNumber,
    });
  } catch (err) {
    if (err instanceof OmrUserError) throw err;
    throw err;
  }

  const evaluation = evaluateAnswers({
    detectedAnswers: visionResult.answers,
    answerKeyQuestions,
    markingConfig: omrExam
  });

  const effectiveSheetId = sheet_id || qr?.sheetId || generateSheetId({
    schoolId: req.schoolId,
    omrExamId: omrExam.id,
    studentEnrollmentId: resolvedStudent?.id || null,
    sequence: Date.now(),
  });

  const [settings] = await sql`SELECT evidence_retention_days FROM omr_settings WHERE school_id = ${req.schoolId} LIMIT 1`;
  const retentionDays = omrExam.evidence_retention_days || settings?.evidence_retention_days || 30;
  const evidenceExpiresAt = new Date(Date.now() + Number(retentionDays) * 86400000).toISOString();
  const imageHash = hashImageBuffer(imageBuffer);

  try {
    const savedScan = await saveEvaluatedScan({
      schoolId: req.schoolId,
      batchId: batch_id,
      omrExamId: omrExam.id,
      sheetId: effectiveSheetId,
      clientScanId: client_scan_id,
      studentEnrollmentId: resolvedStudent?.id || null,
      detectedRollNumber: visionResult.detectedRollNumber,
      imageHash,
      qrPayload: qr,
      deviceId: device_id,
      evidenceExpiresAt,
      qualityScore: visionResult.quality.status,
      qualityMetrics: visionResult.quality.metrics,
      overallConfidence: visionResult.overallConfidence,
      answers: visionResult.answers,
      evaluation,
      scannedBy: req.user.internal_id,
      replaceExisting: replace_existing === true || replace_existing === 'true',
    });

    await sql`
      INSERT INTO omr_audit_logs (school_id, user_id, action, entity, entity_id, new_values, reason)
      VALUES (
        ${req.schoolId}, ${req.user.internal_id}, ${replace_existing ? 'REPLACE_SCAN' : 'SCAN_SHEET'},
        'omr_scan', ${savedScan.id},
        ${JSON.stringify({ sheetId: effectiveSheetId, status: savedScan.status })},
        'OMR sheet evaluated'
      )
    `;

    res.json({
      success: true,
      data: {
        scanId: savedScan.id,
        sheetId: effectiveSheetId,
        status: savedScan.status,
        overallConfidence: visionResult.overallConfidence,
        detectedRollNumber: visionResult.detectedRollNumber,
        student: resolvedStudent,
        evaluation: {
          totalScore: evaluation.totalScore,
          maxPossibleScore: evaluation.maxPossibleScore,
          percentage: evaluation.percentage,
          correctCount: evaluation.correctCount,
          wrongCount: evaluation.wrongCount,
          blankCount: evaluation.blankCount,
          multipleCount: evaluation.multipleCount
        },
        quality: visionResult.quality,
        answers: evaluation.evaluatedAnswers
      }
    });
  } catch (err) {
    if (err instanceof OmrUserError && err.code === 'DUPLICATE_SHEET') {
      return res.status(409).json({
        success: false,
        error: err.message,
        code: 'DUPLICATE_SHEET',
        data: err.details,
        options: ['VIEW_EXISTING', 'REPLACE_SCAN', 'CANCEL'],
      });
    }
    throw err;
  }
}));

/**
 * POST /api/v1/omr/batch-scan
 * Idempotent batch upload for offline queue sync.
 */
router.post('/batch-scan', requirePermission('omr.scan'), asyncHandler(async (req, res) => {
  const { batch_id, omr_exam_id, scans } = req.body;

  if (!omr_exam_id || !Array.isArray(scans)) {
    return res.status(400).json({ error: 'omr_exam_id and scans array are required' });
  }

  const [omrExam] = await sql`
    SELECT oe.*, t.code as template_code, es.class_id
    FROM omr_exams oe
    JOIN omr_templates t ON t.id = oe.template_id
    JOIN exam_subjects es ON es.id = oe.exam_subject_id
    WHERE oe.id = ${omr_exam_id} AND oe.school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!omrExam) {
    return res.status(404).json({ error: 'OMR Exam not found' });
  }

  const [publishedKey] = await sql`
    SELECT id FROM omr_answer_keys
    WHERE omr_exam_id = ${omr_exam_id} AND school_id = ${req.schoolId} AND status = 'published'
    ORDER BY version DESC LIMIT 1
  `;
  if (!publishedKey) {
    return res.status(400).json({ error: 'No published answer key found for this exam.' });
  }

  const answerKeyQuestions = await sql`
    SELECT question_number, correct_option, weightage, negative_weightage
    FROM omr_answer_key_questions
    WHERE answer_key_id = ${publishedKey.id} AND school_id = ${req.schoolId}
  `;

  const results = [];
  for (const item of scans) {
    const {
      sheet_id,
      client_scan_id,
      detected_answers,
      detected_roll_number,
      student_enrollment_id,
      overall_confidence,
      quality_score = 'GOOD',
      quality_metrics = {},
      imageBase64 = null,
    } = item;

    try {
      if (client_scan_id) {
        const [existingClient] = await sql`
          SELECT id, sheet_id, status, total_score, percentage
          FROM omr_scans
          WHERE school_id = ${req.schoolId} AND client_scan_id = ${client_scan_id}
          LIMIT 1
        `;
        if (existingClient) {
          results.push({
            clientScanId: client_scan_id,
            scanId: existingClient.id,
            sheetId: existingClient.sheet_id,
            status: existingClient.status,
            totalScore: existingClient.total_score,
            percentage: existingClient.percentage,
            idempotent: true,
          });
          continue;
        }
      }

      let answers = normalizeDetectedAnswers(detected_answers || []);
      let roll = detected_roll_number || null;
      let confidence = overall_confidence || 80;
      let qualityScore = quality_score;
      let qualityMetrics = quality_metrics;

      if ((!answers.length) && imageBase64) {
        const buf = Buffer.from(String(imageBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const visionResult = await processOmrImage(buf, { templateCode: omrExam.template_code });
        if (visionResult.scanStatus === 'REJECTED') {
          results.push({ clientScanId: client_scan_id, error: visionResult.quality?.guidance, code: 'SCAN_REJECTED' });
          continue;
        }
        answers = visionResult.answers;
        roll = visionResult.detectedRollNumber || roll;
        confidence = visionResult.overallConfidence;
        qualityScore = visionResult.quality.status;
        qualityMetrics = visionResult.quality.metrics;
      }

      const evaluation = evaluateAnswers({
        detectedAnswers: answers,
        answerKeyQuestions,
        markingConfig: omrExam
      });

      let resolvedEnrollment = null;
      try {
        resolvedEnrollment = await resolveEnrollment({
          schoolId: req.schoolId,
          classId: omrExam.class_id,
          enrollmentId: student_enrollment_id || null,
          rollNumber: roll,
        });
      } catch (enrollErr) {
        if (!(enrollErr instanceof OmrUserError)) throw enrollErr;
      }

      const saved = await saveEvaluatedScan({
        schoolId: req.schoolId,
        batchId: batch_id || null,
        omrExamId: omrExam.id,
        sheetId: sheet_id || generateSheetId({ schoolId: req.schoolId, omrExamId: omrExam.id, sequence: Date.now() }),
        clientScanId: client_scan_id || null,
        studentEnrollmentId: resolvedEnrollment?.id || null,
        detectedRollNumber: roll,
        qualityScore,
        qualityMetrics,
        overallConfidence: confidence,
        answers,
        evaluation,
        scannedBy: req.user.internal_id,
        replaceExisting: false,
      });

      results.push({
        clientScanId: client_scan_id,
        scanId: saved.id,
        sheetId: saved.sheet_id,
        status: saved.status,
        totalScore: evaluation.totalScore,
        percentage: evaluation.percentage
      });
    } catch (err) {
      results.push({
        clientScanId: client_scan_id,
        sheetId: sheet_id,
        error: err instanceof OmrUserError ? err.message : 'Unable to save this sheet. Please scan again.',
        code: err.code || 'PROCESSING_FAILURE',
        details: err.details || null,
      });
    }
  }

  res.json({ success: true, processed: results.filter((r) => r.scanId).length, data: results });
}));

// ─────────────────────────────────────────────────────────────────────────────
// 5. MANUAL VERIFICATION & EXCEPTION RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/omr/exceptions
 * List scans requiring manual review
 */
router.get('/exceptions', requirePermission('omr.review'), asyncHandler(async (req, res) => {
  const { omr_exam_id } = req.query;

  const items = await sql`
    SELECT s.id as scan_id, s.sheet_id, s.omr_exam_id, s.detected_roll_number,
           s.student_enrollment_id, s.overall_confidence, s.exception_type,
           s.created_at, oe.title as exam_title,
           p.first_name, p.last_name, st.admission_no,
           (SELECT COUNT(*)::int FROM omr_review_items ri WHERE ri.scan_id = s.id AND ri.status = 'pending') as review_items_count
    FROM omr_scans s
    JOIN omr_exams oe ON oe.id = s.omr_exam_id AND oe.school_id = ${req.schoolId}
    LEFT JOIN student_enrollments se ON se.id = s.student_enrollment_id AND se.school_id = ${req.schoolId}
    LEFT JOIN students st ON st.id = se.student_id AND st.school_id = ${req.schoolId}
    LEFT JOIN persons p ON p.id = st.person_id
    WHERE s.school_id = ${req.schoolId}
      AND s.status = 'REVIEW_REQUIRED'
      ${omr_exam_id ? sql`AND s.omr_exam_id = ${omr_exam_id}` : sql``}
    ORDER BY s.created_at DESC
  `;

  res.json({ success: true, data: items });
}));

router.get('/batches', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const { omr_exam_id } = req.query;
  const batches = await sql`
    SELECT * FROM omr_batches
    WHERE school_id = ${req.schoolId}
      ${omr_exam_id ? sql`AND omr_exam_id = ${omr_exam_id}` : sql``}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  res.json({ success: true, data: batches });
}));

router.post('/batches', requirePermission('omr.scan'), asyncHandler(async (req, res) => {
  const { omr_exam_id, name, device_id } = req.body;
  if (!omr_exam_id) return res.status(400).json({ error: 'omr_exam_id is required' });
  const [exam] = await sql`
    SELECT id FROM omr_exams WHERE id = ${omr_exam_id} AND school_id = ${req.schoolId} AND deleted_at IS NULL
  `;
  if (!exam) return res.status(404).json({ error: 'OMR Exam not found' });
  const [batch] = await sql`
    INSERT INTO omr_batches (school_id, omr_exam_id, name, status, device_id, created_by)
    VALUES (
      ${req.schoolId}, ${omr_exam_id}, ${name || 'Scan batch'}, 'open', ${device_id || null}, ${req.user.internal_id}
    )
    RETURNING *
  `;
  res.status(201).json({ success: true, data: batch });
}));

router.get('/scans', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const { exam_id, omr_exam_id, batch_id, status } = req.query;
  const examId = omr_exam_id || exam_id;
  const scans = await sql`
    SELECT s.id, s.sheet_id, s.omr_exam_id, s.batch_id, s.student_enrollment_id,
           s.detected_roll_number, s.status, s.overall_confidence, s.exception_type,
           s.correct_count, s.wrong_count, s.blank_count, s.total_score, s.percentage, s.created_at,
           p.first_name, p.last_name, st.admission_no
    FROM omr_scans s
    LEFT JOIN student_enrollments se ON se.id = s.student_enrollment_id AND se.school_id = ${req.schoolId}
    LEFT JOIN students st ON st.id = se.student_id AND st.school_id = ${req.schoolId}
    LEFT JOIN persons p ON p.id = st.person_id
    WHERE s.school_id = ${req.schoolId}
      ${examId ? sql`AND s.omr_exam_id = ${examId}` : sql``}
      ${batch_id ? sql`AND s.batch_id = ${batch_id}` : sql``}
      ${status ? sql`AND s.status = ${status}` : sql``}
    ORDER BY s.created_at DESC
    LIMIT 200
  `;
  res.json({
    success: true,
    data: scans.map((s) => ({
      ...s,
      student_id: s.student_enrollment_id,
      roll_number_detected: s.detected_roll_number,
      confidence_score: Number(s.overall_confidence || 0),
      is_flagged: s.status === 'REVIEW_REQUIRED',
      final_score: s.total_score,
    })),
  });
}));

/**
 * GET /api/v1/omr/scans/:id
 * Retrieve detailed inspection record for manual verification
 */
router.get('/scans/:id', requirePermission('omr.view'), asyncHandler(async (req, res) => {
  const [scan] = await sql`
    SELECT s.*, oe.title as exam_title, oe.positive_marks_per_question,
           oe.negative_marks_per_question, oe.blank_marks_per_question,
           p.first_name, p.last_name, st.admission_no
    FROM omr_scans s
    JOIN omr_exams oe ON oe.id = s.omr_exam_id AND oe.school_id = ${req.schoolId}
    LEFT JOIN student_enrollments se ON se.id = s.student_enrollment_id AND se.school_id = ${req.schoolId}
    LEFT JOIN students st ON st.id = se.student_id AND st.school_id = ${req.schoolId}
    LEFT JOIN persons p ON p.id = st.person_id
    WHERE s.id = ${req.params.id} AND s.school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!scan) {
    return res.status(404).json({ error: 'Scan record not found' });
  }

  const answers = await sql`
    SELECT sa.*, q.correct_option
    FROM omr_scan_answers sa
    LEFT JOIN omr_answer_keys ak ON ak.omr_exam_id = ${scan.omr_exam_id} AND ak.status = 'published' AND ak.school_id = ${req.schoolId}
    LEFT JOIN omr_answer_key_questions q ON q.answer_key_id = ak.id AND q.question_number = sa.question_number AND q.school_id = ${req.schoolId}
    WHERE sa.scan_id = ${scan.id} AND sa.school_id = ${req.schoolId}
    ORDER BY sa.question_number ASC
  `;

  const reviewItems = await sql`
    SELECT * FROM omr_review_items
    WHERE scan_id = ${scan.id} AND school_id = ${req.schoolId}
    ORDER BY question_number ASC
  `;

  res.json({
    success: true,
    data: {
      ...scan,
      answers,
      reviewItems
    }
  });
}));

/**
 * POST /api/v1/omr/scans/:id/override
 * Override a detected answer during verification
 */
router.post('/scans/:id/override', requirePermission('omr.review'), asyncHandler(async (req, res) => {
  const { question_number, override_option, reason } = req.body;
  const scanId = req.params.id;

  const [scan] = await sql`
    SELECT id, omr_exam_id, school_id FROM omr_scans
    WHERE id = ${scanId} AND school_id = ${req.schoolId}
    LIMIT 1
  `;
  if (!scan) {
    return res.status(404).json({ error: 'Scan not found' });
  }

  // Update answer override
  await sql`
    UPDATE omr_scan_answers
    SET manual_override_option = ${override_option},
        override_by = ${req.user.internal_id},
        override_reason = ${reason || 'Manual verification adjustment'}
    WHERE scan_id = ${scanId} AND question_number = ${question_number} AND school_id = ${req.schoolId}
  `;

  // Update review item if exists
  await sql`
    UPDATE omr_review_items
    SET status = 'resolved', resolved_option = ${override_option},
        reviewer_id = ${req.user.internal_id}, reviewed_at = now(),
        review_notes = ${reason || 'Resolved in review'}
    WHERE scan_id = ${scanId} AND question_number = ${question_number} AND school_id = ${req.schoolId}
  `;

  // Re-evaluate scan scores with new override
  const [publishedKey] = await sql`
    SELECT id FROM omr_answer_keys
    WHERE omr_exam_id = ${scan.omr_exam_id} AND school_id = ${req.schoolId} AND status = 'published'
    ORDER BY version DESC LIMIT 1
  `;
  const keyQuestions = await sql`
    SELECT question_number, correct_option, weightage, negative_weightage
    FROM omr_answer_key_questions
    WHERE answer_key_id = ${publishedKey.id} AND school_id = ${req.schoolId}
  `;
  const [omrExam] = await sql`
    SELECT * FROM omr_exams WHERE id = ${scan.omr_exam_id} AND school_id = ${req.schoolId}
  `;
  const allAnswers = await sql`
    SELECT question_number as "questionNumber", detected_option as "detectedOption",
           manual_override_option as "manualOverrideOption", confidence, fill_ratio as "fillRatio",
           is_multiple as "isMultiple", is_blank as "isBlank"
    FROM omr_scan_answers
    WHERE scan_id = ${scanId} AND school_id = ${req.schoolId}
  `;

  const newEval = evaluateAnswers({
    detectedAnswers: allAnswers,
    answerKeyQuestions: keyQuestions,
    markingConfig: omrExam
  });

  // Check if remaining pending items
  const [pending] = await sql`
    SELECT COUNT(*)::int as count FROM omr_review_items
    WHERE scan_id = ${scanId} AND school_id = ${req.schoolId} AND status = 'pending'
  `;

  const newStatus = pending && pending.count === 0 ? 'VERIFIED' : 'REVIEW_REQUIRED';

  await sql`
    UPDATE omr_scans
    SET total_score = ${newEval.totalScore},
        percentage = ${newEval.percentage},
        correct_count = ${newEval.correctCount},
        wrong_count = ${newEval.wrongCount},
        status = ${newStatus},
        verified_by = ${req.user.internal_id},
        verified_at = now(),
        updated_at = now()
    WHERE id = ${scanId}
  `;

  // Audit
  await sql`
    INSERT INTO omr_audit_logs (
      school_id, user_id, action, entity, entity_id, new_values, reason
    ) VALUES (
      ${req.schoolId}, ${req.user.internal_id}, 'OVERRIDE_ANSWER', 'omr_scan', ${scanId},
      ${JSON.stringify({ question_number, override_option })}, ${reason || 'Manual verification'}
    )
  `;

  res.json({ success: true, message: 'Answer override saved and scores recalculated' });
}));

// ─────────────────────────────────────────────────────────────────────────────
// 6. RESULT FINALIZATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/omr/exams/:id/finalize
 * Finalize evaluated results and push directly into SchoolIMS marks table.
 */
router.post('/exams/:id/finalize', requirePermission('omr.finalize'), asyncHandler(async (req, res) => {
  const result = await finalizeExamResults({
    schoolId: req.schoolId,
    omrExamId: req.params.id,
    userId: req.user.internal_id,
    allowUnverifiedOverride: Boolean(req.body?.allow_unverified_override),
    overrideReason: req.body?.reason || null,
  });

  res.json({
    success: true,
    message: `Finalized and pushed ${result.pushedCount} marks to official examination records`,
    data: result
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// 7. OMR ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/omr/exams/:id/analytics
 */
router.get('/exams/:id/analytics', requirePermission('omr.analytics'), asyncHandler(async (req, res) => {
  const analytics = await getOmrExamAnalytics(req.schoolId, req.params.id);
  const mapped = {
    ...analytics,
    summary: analytics.summary
      ? {
          ...analytics.summary,
          total_sheets: analytics.totalSheets,
          average_score: analytics.summary.meanScore,
          highest_score: analytics.summary.maxScore,
          lowest_score: analytics.summary.minScore,
        }
      : { total_sheets: 0, average_score: 0, highest_score: 0, lowest_score: 0 },
    question_statistics: (analytics.questionAnalytics || []).map((q) => ({
      question_number: q.questionNumber,
      correct_percentage: q.correctPercentage,
      difficulty_level: q.difficulty,
      option_distribution: Object.fromEntries(
        Object.entries(q.optionDistribution || {}).map(([k, v]) => [k, v.percentage])
      ),
    })),
  };
  res.json({ success: true, data: mapped });
}));

// ─────────────────────────────────────────────────────────────────────────────
// 8. AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/omr/audit
 */
router.get('/audit', requirePermission('omr.audit'), asyncHandler(async (req, res) => {
  const logs = await sql`
    SELECT al.*, p.first_name, p.last_name
    FROM omr_audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    LEFT JOIN persons p ON p.id = u.person_id
    WHERE al.school_id = ${req.schoolId}
    ORDER BY al.created_at DESC
    LIMIT 100
  `;
  res.json({ success: true, data: logs });
}));

export default router;
