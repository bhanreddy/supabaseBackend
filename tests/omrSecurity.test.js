/**
 * Security-focused OMR unit tests: tenant-safe QR payloads and server-side mark calculation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeOmrQrPayload, encodeOmrQrPayload, validateQrAgainstExam } from '../services/omr/omrQr.js';
import { evaluateAnswers } from '../services/omr/omrEvaluationEngine.js';

describe('OMR security invariants', () => {
  test('QR payload never needs personal names and cannot switch exams silently', () => {
    const raw = encodeOmrQrPayload({
      examId: 'exam-school-a',
      sheetId: 'SHT-1',
      templateId: 'tpl-1',
    });
    assert.equal(raw.toLowerCase().includes('aadhaar'), false);
    assert.equal(raw.toLowerCase().includes('phone'), false);
    const decoded = decodeOmrQrPayload(raw);
    const check = validateQrAgainstExam(decoded, { id: 'exam-school-b', template_id: 'tpl-1' });
    assert.equal(check.ok, false);
    assert.equal(check.code, 'EXAM_MISMATCH');
  });

  test('client-supplied marks are ignored — evaluation uses answer key + detected options', () => {
    const result = evaluateAnswers({
      detectedAnswers: [
        { questionNumber: 1, detectedOption: 'A', confidence: 99, marksAwarded: 999 },
      ],
      answerKeyQuestions: [
        { question_number: 1, correct_option: 'B', weightage: 2, negative_weightage: 0.5 },
      ],
      markingConfig: { positive_marks_per_question: 2, negative_marks_per_question: 0.5 },
    });
    assert.equal(result.totalScore, -0.5);
    assert.equal(result.evaluatedAnswers[0].marksAwarded, -0.5);
  });
});
