/**
 * SchoolIMS — OMR Evaluation Engine (Engine C)
 * Converts detected answers + answer key + marking scheme into official academic marks.
 * Integrates directly with SchoolIMS `marks` table without duplicate schemas.
 */

import sql from '../../db.js';
import { OmrUserError, OMR_USER_MESSAGES } from './omrErrors.js';

export const MULTIPLE_ANSWER_BEHAVIOR = {
  INVALID: 'invalid',
  NEGATIVE: 'negative',
  ZERO: 'zero',
  REVIEW: 'review',
};

export function normalizeDetectedAnswers(raw = []) {
  return (raw || []).map((item) => ({
    questionNumber: item.questionNumber ?? item.question_number,
    detectedOption: item.detectedOption ?? item.detected_option ?? 'BLANK',
    manualOverrideOption: item.manualOverrideOption ?? item.manual_override_option ?? null,
    confidence: item.confidence != null ? Number(item.confidence) : 0,
    fillRatio: item.fillRatio ?? item.fill_ratio ?? 0,
    isMultiple: Boolean(item.isMultiple ?? item.is_multiple),
    isBlank: Boolean(item.isBlank ?? item.is_blank),
    isAmbiguous: Boolean(item.isAmbiguous ?? item.is_ambiguous),
    allOptions: item.allOptions ?? item.all_options ?? {},
  }));
}

/**
 * Evaluates student answers against an answer key.
 */
export function evaluateAnswers({
  detectedAnswers,
  answerKeyQuestions,
  markingConfig = {}
}) {
  const defaultPositive = Number(markingConfig.positive_marks_per_question ?? 1.0);
  const defaultNegative = Math.abs(Number(markingConfig.negative_marks_per_question ?? 0.0));
  const defaultBlank = Number(markingConfig.blank_marks_per_question ?? 0.0);
  const multipleBehavior = markingConfig.multiple_answer_behavior || MULTIPLE_ANSWER_BEHAVIOR.INVALID;

  const keyMap = new Map();
  answerKeyQuestions.forEach((k) => {
    keyMap.set(k.question_number, {
      correctOption: (k.correct_option || '').toUpperCase().trim(),
      weightage: k.weightage != null ? Number(k.weightage) : defaultPositive,
      negativeWeightage: k.negative_weightage != null ? Math.abs(Number(k.negative_weightage)) : defaultNegative
    });
  });

  const answers = normalizeDetectedAnswers(detectedAnswers);

  let correctCount = 0;
  let wrongCount = 0;
  let blankCount = 0;
  let multipleCount = 0;
  let totalScore = 0;
  let maxPossibleScore = 0;

  const evaluatedAnswers = answers.map((item) => {
    const qNum = item.questionNumber;
    const key = keyMap.get(qNum);

    const effectiveOption = (item.manualOverrideOption || item.detectedOption || 'BLANK').toUpperCase().trim();
    const isBlank = effectiveOption === 'BLANK' || item.isBlank;
    const isMultiple = effectiveOption === 'MULTIPLE' || item.isMultiple;

    let isCorrect = false;
    let marksAwarded = 0;

    const weight = key ? key.weightage : defaultPositive;
    const negWeight = key ? key.negativeWeightage : defaultNegative;
    maxPossibleScore += weight;

    if (isBlank) {
      blankCount++;
      marksAwarded = defaultBlank;
      isCorrect = false;
    } else if (isMultiple) {
      multipleCount++;
      if (multipleBehavior === MULTIPLE_ANSWER_BEHAVIOR.NEGATIVE) {
        marksAwarded = -negWeight;
      } else {
        marksAwarded = 0;
      }
      isCorrect = false;
    } else if (!key) {
      // Question not in answer key; award 0
      marksAwarded = 0;
    } else if (effectiveOption === key.correctOption) {
      correctCount++;
      isCorrect = true;
      marksAwarded = weight;
    } else {
      // Wrong answer
      wrongCount++;
      isCorrect = false;
      marksAwarded = -negWeight;
    }

    totalScore += marksAwarded;

    return {
      questionNumber: qNum,
      detectedOption: item.detectedOption,
      effectiveOption,
      manualOverrideOption: item.manualOverrideOption || null,
      correctOption: key ? key.correctOption : null,
      confidence: item.confidence,
      fillRatio: item.fillRatio,
      isMultiple,
      isBlank,
      isAmbiguous: item.isAmbiguous || false,
      isCorrect,
      marksAwarded: Number(marksAwarded.toFixed(2))
    };
  });

  // Clamp totalScore to minimum 0 if negative total scores are disallowed by policy
  const roundedTotal = Number(totalScore.toFixed(2));
  const roundedMax = Number(maxPossibleScore.toFixed(2));
  const percentage = roundedMax > 0 ? Number(((Math.max(0, roundedTotal) / roundedMax) * 100).toFixed(2)) : 0;

  return {
    correctCount,
    wrongCount,
    blankCount,
    multipleCount,
    totalScore: roundedTotal,
    maxPossibleScore: roundedMax,
    percentage,
    evaluatedAnswers
  };
}

/**
 * Persists evaluated scan and per-question answers into the database.
 */
export async function saveEvaluatedScan({
  schoolId,
  batchId = null,
  omrExamId,
  sheetId,
  clientScanId = null,
  studentEnrollmentId = null,
  detectedRollNumber = null,
  imageUrl = null,
  imageHash = null,
  qrPayload = null,
  deviceId = null,
  evidenceExpiresAt = null,
  qualityScore = 'GOOD',
  qualityMetrics = {},
  overallConfidence = 0,
  answers,
  evaluation,
  scannedBy = null,
  replaceExisting = false,
}) {
  return await sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT id, status, student_enrollment_id, sheet_id
      FROM omr_scans
      WHERE school_id = ${schoolId}
        AND sheet_id = ${sheetId}
        AND omr_exam_id = ${omrExamId}
      LIMIT 1
    `;

    if (existing && !replaceExisting) {
      throw new OmrUserError(OMR_USER_MESSAGES.DUPLICATE_SHEET, 409, 'DUPLICATE_SHEET', {
        existingScanId: existing.id,
        status: existing.status,
        sheetId: existing.sheet_id,
      });
    }

    let status = 'PROCESSED';
    let exceptionType = null;
    let exceptionResolved = true;

    if (qualityScore === 'REJECT') {
      status = 'REJECTED';
      exceptionType = 'POOR_SCAN_QUALITY';
      exceptionResolved = false;
    } else if (!studentEnrollmentId) {
      status = 'REVIEW_REQUIRED';
      exceptionType = 'UNIDENTIFIED_STUDENT';
      exceptionResolved = false;
    } else if (evaluation.multipleCount > 0 || evaluation.evaluatedAnswers.some((a) => a.isAmbiguous)) {
      status = 'REVIEW_REQUIRED';
      exceptionType = evaluation.multipleCount > 0 ? 'MULTIPLE_ANSWERS' : 'AMBIGUOUS_BUBBLE';
      exceptionResolved = false;
    } else if (overallConfidence < 70) {
      status = 'REVIEW_REQUIRED';
      exceptionType = 'LOW_CONFIDENCE';
      exceptionResolved = false;
    }

    const [scan] = await tx`
      INSERT INTO omr_scans (
        school_id, batch_id, omr_exam_id, sheet_id, client_scan_id,
        student_enrollment_id, detected_roll_number, status, image_url,
        quality_score, quality_metrics, overall_confidence,
        correct_count, wrong_count, blank_count, multiple_count,
        total_score, max_possible_score, percentage,
        exception_type, exception_resolved, scanned_by
      ) VALUES (
        ${schoolId}, ${batchId}, ${omrExamId}, ${sheetId}, ${clientScanId},
        ${studentEnrollmentId}, ${detectedRollNumber}, ${status}, ${imageUrl},
        ${qualityScore}, ${JSON.stringify(qualityMetrics)}, ${overallConfidence},
        ${evaluation.correctCount}, ${evaluation.wrongCount}, ${evaluation.blankCount}, ${evaluation.multipleCount},
        ${evaluation.totalScore}, ${evaluation.maxPossibleScore}, ${evaluation.percentage},
        ${exceptionType}, ${exceptionResolved}, ${scannedBy}
      )
      ON CONFLICT (school_id, sheet_id, omr_exam_id)
      DO UPDATE SET
        batch_id = COALESCE(EXCLUDED.batch_id, omr_scans.batch_id),
        student_enrollment_id = COALESCE(EXCLUDED.student_enrollment_id, omr_scans.student_enrollment_id),
        detected_roll_number = COALESCE(EXCLUDED.detected_roll_number, omr_scans.detected_roll_number),
        status = EXCLUDED.status,
        image_url = COALESCE(EXCLUDED.image_url, omr_scans.image_url),
        quality_score = EXCLUDED.quality_score,
        quality_metrics = EXCLUDED.quality_metrics,
        overall_confidence = EXCLUDED.overall_confidence,
        correct_count = EXCLUDED.correct_count,
        wrong_count = EXCLUDED.wrong_count,
        blank_count = EXCLUDED.blank_count,
        multiple_count = EXCLUDED.multiple_count,
        total_score = EXCLUDED.total_score,
        max_possible_score = EXCLUDED.max_possible_score,
        percentage = EXCLUDED.percentage,
        exception_type = EXCLUDED.exception_type,
        exception_resolved = EXCLUDED.exception_resolved,
        updated_at = now()
      RETURNING id, sheet_id, status, total_score, percentage
    `;

    const inserted = !existing;

    for (const ans of evaluation.evaluatedAnswers) {
      await tx`
        INSERT INTO omr_scan_answers (
          school_id, scan_id, question_number, detected_option,
          confidence, fill_ratio, is_multiple, is_blank, is_ambiguous,
          is_correct, marks_awarded, manual_override_option
        ) VALUES (
          ${schoolId}, ${scan.id}, ${ans.questionNumber}, ${ans.detectedOption},
          ${ans.confidence}, ${ans.fillRatio || 0}, ${ans.isMultiple}, ${ans.isBlank}, ${ans.isAmbiguous},
          ${ans.isCorrect}, ${ans.marksAwarded}, ${ans.manualOverrideOption}
        )
        ON CONFLICT (scan_id, question_number)
        DO UPDATE SET
          detected_option = EXCLUDED.detected_option,
          confidence = EXCLUDED.confidence,
          fill_ratio = EXCLUDED.fill_ratio,
          is_multiple = EXCLUDED.is_multiple,
          is_blank = EXCLUDED.is_blank,
          is_ambiguous = EXCLUDED.is_ambiguous,
          is_correct = EXCLUDED.is_correct,
          marks_awarded = EXCLUDED.marks_awarded,
          manual_override_option = EXCLUDED.manual_override_option
      `;

      if (ans.isAmbiguous || ans.isMultiple || ans.confidence < 70) {
        await tx`
          INSERT INTO omr_review_items (
            school_id, scan_id, question_number, issue_type,
            detected_option, confidence, status
          ) VALUES (
            ${schoolId}, ${scan.id}, ${ans.questionNumber},
            ${ans.isMultiple ? 'MULTIPLE_FILLED' : (ans.isAmbiguous ? 'AMBIGUOUS_MARK' : 'LOW_CONFIDENCE')},
            ${ans.detectedOption}, ${ans.confidence}, 'pending'
          )
          ON CONFLICT DO NOTHING
        `;
      }
    }

    if (batchId && inserted) {
      await tx`
        UPDATE omr_batches
        SET
          total_scanned = total_scanned + 1,
          processed_count = processed_count + CASE WHEN ${status} = 'PROCESSED' THEN 1 ELSE 0 END,
          review_count = review_count + CASE WHEN ${status} = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END,
          error_count = error_count + CASE WHEN ${status} = 'REJECTED' THEN 1 ELSE 0 END,
          updated_at = now()
        WHERE id = ${batchId} AND school_id = ${schoolId}
      `;
    }

    return { ...scan, duplicate: Boolean(existing), inserted };
  });
}

/**
 * Finalizes evaluated OMR scans for an exam and pushes the results into SchoolIMS `marks` table.
 */
export async function finalizeExamResults({
  schoolId,
  omrExamId,
  userId,
  allowUnverifiedOverride = false,
  overrideReason = null,
}) {
  return await sql.begin(async (tx) => {
    const [omrExam] = await tx`
      SELECT oe.id, oe.exam_subject_id, oe.status, es.exam_id, es.max_marks, e.results_published
      FROM omr_exams oe
      JOIN exam_subjects es ON es.id = oe.exam_subject_id AND es.school_id = ${schoolId}
      JOIN exams e ON e.id = es.exam_id AND e.school_id = ${schoolId}
      WHERE oe.id = ${omrExamId} AND oe.school_id = ${schoolId}
      LIMIT 1
    `;

    if (!omrExam) {
      throw new OmrUserError('OMR exam configuration was not found.', 404, 'EXAM_NOT_FOUND');
    }

    if (omrExam.results_published) {
      throw new OmrUserError('Official results are already published for this exam. Unpublish before modifying.', 409, 'RESULTS_PUBLISHED');
    }

    const [counts] = await tx`
      SELECT
        COUNT(*)::int AS total_sheets,
        COUNT(*) FILTER (WHERE status IN ('PROCESSED', 'VERIFIED'))::int AS ready_sheets,
        COUNT(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::int AS pending_sheets,
        COUNT(*) FILTER (WHERE student_enrollment_id IS NULL)::int AS unidentified_sheets,
        COUNT(*) FILTER (WHERE exception_type = 'DUPLICATE_SHEET')::int AS duplicate_sheets
      FROM omr_scans
      WHERE omr_exam_id = ${omrExamId} AND school_id = ${schoolId}
    `;

    if (counts.pending_sheets > 0 && !allowUnverifiedOverride) {
      throw new OmrUserError(
        `Cannot finalize: ${counts.pending_sheets} sheets still need review.`,
        409,
        'FINALIZE_BLOCKED',
        counts
      );
    }

    const scans = await tx`
      SELECT s.id, s.sheet_id, s.student_enrollment_id, s.total_score, s.max_possible_score, s.percentage
      FROM omr_scans s
      WHERE s.omr_exam_id = ${omrExamId}
        AND s.school_id = ${schoolId}
        AND s.student_enrollment_id IS NOT NULL
        AND s.status IN ('PROCESSED', 'VERIFIED')
    `;

    if (scans.length === 0) {
      throw new OmrUserError('No evaluated sheets are ready for finalization.', 400, 'NOTHING_TO_FINALIZE', counts);
    }

    let pushedCount = 0;
    for (const scan of scans) {
      const rawScore = scan.total_score;
      const maxPossible = scan.max_possible_score || 100;
      const targetMax = Number(omrExam.max_marks) || 100;
      const finalMark = maxPossible > 0
        ? Number(((rawScore / maxPossible) * targetMax).toFixed(2))
        : rawScore;

      await tx`
        INSERT INTO marks (
          school_id, exam_subject_id, student_enrollment_id,
          marks_obtained, is_absent, remarks, entered_by
        ) VALUES (
          ${schoolId}, ${omrExam.exam_subject_id}, ${scan.student_enrollment_id},
          ${finalMark}, FALSE, ${'OMR Evaluated (Sheet: ' + scan.sheet_id + ')'}, ${userId}
        )
        ON CONFLICT (school_id, exam_subject_id, student_enrollment_id)
        DO UPDATE SET
          marks_obtained = EXCLUDED.marks_obtained,
          is_absent = FALSE,
          remarks = EXCLUDED.remarks,
          entered_by = EXCLUDED.entered_by,
          updated_at = now()
      `;

      await tx`
        UPDATE omr_scans
        SET status = 'FINALIZED', verified_by = ${userId}, verified_at = now(), updated_at = now()
        WHERE id = ${scan.id}
      `;

      pushedCount++;
    }

    await tx`
      UPDATE omr_exams
      SET status = 'finalized', updated_at = now()
      WHERE id = ${omrExamId}
    `;

    await tx`
      INSERT INTO omr_audit_logs (
        school_id, user_id, action, entity, entity_id,
        new_values, reason
      ) VALUES (
        ${schoolId}, ${userId}, 'FINALIZE_RESULTS', 'omr_exam', ${omrExamId},
        ${JSON.stringify({ pushedCount, exam_subject_id: omrExam.exam_subject_id, counts, allowUnverifiedOverride })},
        ${overrideReason || 'Finalized OMR results pushed to official examination marks ledger'}
      )
    `;

    return {
      success: true,
      pushedCount,
      scans_finalized: pushedCount,
      marks_posted: pushedCount,
      omrExamId,
      exam_id: omrExamId,
      examSubjectId: omrExam.exam_subject_id,
      counts,
    };
  });
}

export async function resolveEnrollment({ schoolId, classId, enrollmentId, rollNumber }) {
  if (enrollmentId) {
    const [enrollment] = await sql`
      SELECT se.id, se.student_id, se.roll_number, p.first_name, p.last_name, s.admission_no
      FROM student_enrollments se
      JOIN students s ON s.id = se.student_id AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
      JOIN persons p ON p.id = s.person_id
      JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = ${schoolId}
      WHERE se.id = ${enrollmentId}
        AND se.school_id = ${schoolId}
        AND cs.class_id = ${classId}
        AND se.status = 'active'
        AND se.deleted_at IS NULL
      LIMIT 1
    `;
    if (!enrollment) {
      throw new OmrUserError(OMR_USER_MESSAGES.INVALID_STUDENT, 400, 'INVALID_STUDENT');
    }
    return enrollment;
  }

  if (!rollNumber) return null;

  const [enrollment] = await sql`
    SELECT se.id, se.student_id, se.roll_number, p.first_name, p.last_name, s.admission_no
    FROM student_enrollments se
    JOIN students s ON s.id = se.student_id AND s.school_id = ${schoolId} AND s.deleted_at IS NULL
    JOIN persons p ON p.id = s.person_id
    JOIN class_sections cs ON cs.id = se.class_section_id AND cs.school_id = ${schoolId}
    WHERE cs.class_id = ${classId}
      AND se.roll_number = ${rollNumber}
      AND se.school_id = ${schoolId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
    LIMIT 1
  `;
  return enrollment || null;
}
