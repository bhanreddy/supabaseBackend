import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBlueprint,
  generateQuestionPaper,
} from '../services/paperforgeService.js';
import { PaperForgeProxyError } from '../services/paperforgeProxy.service.js';

test('validateBlueprint rejects missing class level', () => {
  assert.throws(
    () => validateBlueprint({ sections: [{ subject: 'Math', count: 5, marks_per_question: 1, question_type: 'MCQ' }] }),
    /Class level is required/
  );
});

test('validateBlueprint rejects empty sections array', () => {
  assert.throws(
    () => validateBlueprint({ class_level: 'Class 10', sections: [] }),
    /At least one section is required/
  );
});

test('validateBlueprint rejects invalid question types', () => {
  assert.throws(
    () => validateBlueprint({
      class_level: 'Class 10',
      sections: [{ subject: 'Math', count: 5, marks_per_question: 1, question_type: 'ESSAY' }]
    }),
    /invalid question type/
  );
});

test('validateBlueprint enforces max question limit of 200', () => {
  assert.throws(
    () => validateBlueprint({
      class_level: 'Class 10',
      sections: [
        { subject: 'Math', count: 50, marks_per_question: 1, question_type: 'MCQ' },
        { subject: 'Math', count: 50, marks_per_question: 1, question_type: 'MCQ' },
        { subject: 'Math', count: 50, marks_per_question: 1, question_type: 'MCQ' },
        { subject: 'Math', count: 50, marks_per_question: 1, question_type: 'MCQ' },
        { subject: 'Math', count: 10, marks_per_question: 1, question_type: 'MCQ' },
      ]
    }),
    /at most 200 questions/
  );
});

test('validateBlueprint computes total marks and counts correctly for valid blueprint', () => {
  const result = validateBlueprint({
    class_level: 'Class 10',
    sections: [
      { subject: 'Math', count: 10, marks_per_question: 1, question_type: 'MCQ' },
      { subject: 'Math', count: 5, marks_per_question: 2, question_type: 'VSA' },
      { subject: 'Math', count: 4, marks_per_question: 3, question_type: 'SA' },
      { subject: 'Math', count: 2, marks_per_question: 5, question_type: 'LA' },
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.totalQuestions, 21);
  assert.equal(result.totalMarks, 42); // 10*1 + 5*2 + 4*3 + 2*5 = 10 + 10 + 12 + 10 = 42
});

test('PaperForgeProxyError normalizes errors without leaking internal URLs or credentials', () => {
  const timeoutErr = new PaperForgeProxyError(504, 'PaperForge request timed out. Please try again.', 'PF_ENGINE_TIMEOUT');
  assert.equal(timeoutErr.status, 504);
  assert.equal(timeoutErr.code, 'PF_ENGINE_TIMEOUT');
  assert.equal(timeoutErr.message.includes('localhost'), false);
  assert.equal(timeoutErr.message.includes('http'), false);

  const unavailErr = new PaperForgeProxyError(503, 'PaperForge service is temporarily unavailable.', 'PF_ENGINE_UNAVAILABLE');
  assert.equal(unavailErr.status, 503);
  assert.equal(unavailErr.code, 'PF_ENGINE_UNAVAILABLE');
});

test('generateQuestionPaper enforces required fields before forwarding', async () => {
  await assert.rejects(
    async () => generateQuestionPaper({ schoolId: null, userId: 'u1', subject: 'Math', classLevel: 'Class 10', blueprint: {} }),
    /schoolId, userId, subject, and classLevel are required/
  );
});
