import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeDiaryContent,
  composeDiaryTitle,
  composeHomeworkLine,
  parentNotificationCopy,
  renderTemplateContent,
  publicStructuredFields,
} from '../services/smartDiary/composeContent.js';
import { heuristicExtract, mergeExtraction, lowConfidenceFields } from '../services/smartDiary/heuristicExtract.js';
import { detectCurrentClass, toCurrentClassPayload, formatClock } from '../services/smartDiary/currentClass.js';
import { extractDiaryFields } from '../services/ai/diaryExtractionService.js';
import { sanitizeDueDate, sanitizeSource, isUuid } from '../services/smartDiary/validation.js';

test('critical OCR heuristic: exercise, questions, reminder, current subject', () => {
  const raw = `Maths
Ex 4.2
Q1-10
Bring geometry box tomorrow`;
  const extracted = heuristicExtract(raw, {
    subject_name: 'Mathematics',
    class_name: '7',
    section_name: 'A',
    today: '2026-09-11',
  });

  assert.equal(extracted.subject, 'Mathematics');
  assert.equal(extracted.exercise, '4.2');
  assert.equal(extracted.questions, '1–10');
  assert.match(extracted.homework, /Exercise 4\.2/);
  assert.match(extracted.homework, /1–10/);
  assert.ok(extracted.reminders.some((item) => /geometry box/i.test(item)));
  assert.ok(extracted.confidence.homework >= 0.9);
});

test('AI extraction layer uses context and does not invent IDs', async () => {
  const result = await extractDiaryFields({
    rawText: 'Ex 5.3 Q 2-8',
    context: { subject_name: 'Mathematics', class_name: '7', section_name: 'A' },
    extractor: async () => ({
      subject: 'Mathematics',
      homework: 'Complete Exercise 5.3, Questions 2–8.',
      exercise: '5.3',
      questions: '2–8',
      confidence: { subject: 0.99, homework: 0.95, exercise: 0.95, questions: 0.95 },
      class_section_id: 'should-be-ignored',
    }),
  });
  assert.equal(result.subject, 'Mathematics');
  assert.match(result.homework, /Exercise 5\.3/);
  assert.equal(result.class_section_id, undefined);
});

test('complete-exercise template renders without exposing placeholders', () => {
  const content = renderTemplateContent(
    'Complete Exercise {exercise}, Questions {questions}.',
    { exercise: '4.2', questions: '1–10' },
  );
  assert.equal(content, 'Complete Exercise 4.2, Questions 1–10.');
  assert.equal(content.includes('{'), false);
});

test('photo fallback content is used when extraction is empty', () => {
  const content = composeDiaryContent({}, { hasPhoto: true });
  assert.match(content, /attached diary photo/i);
});

test('parent notification prefers homework copy over photo copy', () => {
  const withHomework = parentNotificationCopy({
    subject: 'Mathematics',
    homework: 'Complete Exercise 4.2, Questions 1–10.',
  });
  assert.equal(withHomework.title, 'Mathematics Homework');
  assert.match(withHomework.message, /Exercise 4\.2/);

  const photoOnly = parentNotificationCopy({ hasPhoto: true }, { subject_name: 'Mathematics' });
  assert.equal(photoOnly.title, 'New Mathematics Diary');
});

test('current class detection follows the timetable clock', () => {
  const slots = [
    {
      period_number: 4,
      class_section_id: 'cs-6',
      class_name: '6',
      section_name: 'A',
      subject_id: 'sub-eng',
      subject_name: 'English',
      start_time: '13:15:00',
      end_time: '14:00:00',
      day_of_week: 'friday',
    },
    {
      period_number: 5,
      class_section_id: 'cs-7a',
      class_name: '7',
      section_name: 'A',
      subject_id: 'sub-math',
      subject_name: 'Mathematics',
      start_time: '14:00:00',
      end_time: '14:45:00',
      day_of_week: 'friday',
    },
    {
      period_number: 6,
      class_section_id: 'cs-8b',
      class_name: '8',
      section_name: 'B',
      subject_id: 'sub-math',
      subject_name: 'Mathematics',
      start_time: '14:45:00',
      end_time: '15:30:00',
      day_of_week: 'friday',
    },
  ];

  const duringFifth = detectCurrentClass(slots, { weekday: 'friday', minutes: 14 * 60 + 15 });
  const payload = toCurrentClassPayload(duringFifth, null, 14 * 60 + 15);
  assert.equal(payload.class_section_id, 'cs-7a');
  assert.equal(payload.subject_name, 'Mathematics');
  assert.equal(payload.period_number, 5);
  assert.equal(payload.display_time, '2:15 PM');

  const duringSixth = detectCurrentClass(slots, { weekday: 'friday', minutes: 14 * 60 + 50 });
  assert.equal(duringSixth.slot.class_section_id, 'cs-8b');
});

test('due dates before the entry date are rejected', () => {
  assert.equal(sanitizeDueDate('2026-09-10', '2026-09-11'), null);
  assert.equal(sanitizeDueDate('2026-09-12', '2026-09-11'), '2026-09-12');
  assert.equal(sanitizeSource('photo'), 'PHOTO');
  assert.equal(sanitizeSource('hack'), 'MANUAL');
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid('11111111-1111-4111-8111-111111111111'), true);
});

test('low-confidence fields are listed without exposing scores in preview helpers', () => {
  const fields = lowConfidenceFields({
    confidence: { homework: 0.94, dueDate: 0.56, chapter: 0.88 },
  });
  assert.deepEqual(fields, ['dueDate']);
});

test('merge prefers high-confidence AI homework and keeps heuristic reminder', () => {
  const heuristic = heuristicExtract('Ex 4.2 Q1-10\nBring geometry box tomorrow', { subject_name: 'Mathematics' });
  const merged = mergeExtraction({
    homework: 'Complete Exercise 4.2, Questions 1–10.',
    confidence: { homework: 0.96 },
  }, heuristic);
  assert.equal(merged.homework, 'Complete Exercise 4.2, Questions 1–10.');
  assert.ok(merged.reminders.some((item) => /geometry box/i.test(item)));
});

test('structured parent payload never includes confidence', () => {
  const structured = publicStructuredFields({
    homework: 'Complete Exercise 4.2, Questions 1–10.',
    reminders: ['Bring geometry box tomorrow'],
    confidence: { homework: 0.99 },
  });
  assert.equal(structured.homework.includes('Exercise 4.2'), true);
  assert.equal('confidence' in structured, false);
});

test('title composer uses subject homework by default', () => {
  assert.equal(
    composeDiaryTitle({ homework: 'Complete Exercise 4.2, Questions 1–10.' }, { subject_name: 'Mathematics' }),
    'Mathematics Homework',
  );
  assert.equal(composeHomeworkLine({ exercise: '4.2', questions: '1-10' }).includes('4.2'), true);
  assert.equal(renderTemplateContent('Bring {item} tomorrow.', { item: 'geometry box' }), 'Bring geometry box tomorrow.');
  assert.equal(formatClock(14 * 60 + 15), '2:15 PM');
});
