import assert from 'node:assert/strict';
import test from 'node:test';

import { matchSubjectName, confidenceLabel, needsFallback } from '../services/smartDiary/subjectMatch.js';
import { heuristicSplitClassDiary, normalizeClassEntry } from '../services/smartDiary/classDiaryExtract.js';
import { classDiaryNotificationCopy } from '../services/smartDiary/classDiaryPublish.js';
import { sanitizeSource } from '../services/smartDiary/validation.js';

const CLASS_8A_SUBJECTS = [
  { id: 'sub-math', name: 'Mathematics' },
  { id: 'sub-sci', name: 'Science' },
  { id: 'sub-eng', name: 'English' },
  { id: 'sub-social', name: 'Social Studies' },
  { id: 'sub-hi', name: 'Hindi' },
];

test('class diary test case 1: splits Math/Science/English from one page', () => {
  const raw = `Math
Ex 4.2 Q1-10

Science
Read Ch 6
Draw digestive system

English
Learn poem 3`;
  const entries = heuristicSplitClassDiary(raw, CLASS_8A_SUBJECTS);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].subject, 'Mathematics');
  assert.equal(entries[0].subject_id, 'sub-math');
  assert.match(entries[0].homework, /Exercise 4\.2/);
  assert.match(entries[0].homework, /1–10/);
  assert.equal(entries[1].subject, 'Science');
  assert.match(entries[1].homework || entries[1].classwork || entries[1].originalText || '', /Ch(?:apter)? 6|digestive/i);
  assert.equal(entries[2].subject, 'English');
  assert.equal(entries.every((item) => !item.unknown), true);
});

test('class diary test case 5: Geography is unknown and must not create a subject', () => {
  const match = matchSubjectName('Geography', CLASS_8A_SUBJECTS);
  assert.equal(match.subject, null);
  assert.equal(match.unknown, true);
  const entry = normalizeClassEntry({
    subject: 'Geography',
    homework: 'Read atlas',
    confidence: 0.9,
  }, CLASS_8A_SUBJECTS);
  assert.equal(entry.subject_id, null);
  assert.equal(entry.unknown, true);
  assert.equal(entry.selected, false);
  assert.equal(entry.subject, 'Geography');
});

test('subject aliases map onto configured class subjects only', () => {
  assert.equal(matchSubjectName('Maths', CLASS_8A_SUBJECTS).subject.id, 'sub-math');
  assert.equal(matchSubjectName('Sci', CLASS_8A_SUBJECTS).subject.id, 'sub-sci');
  assert.equal(matchSubjectName('Social', CLASS_8A_SUBJECTS).subject.id, 'sub-social');
});

test('confidence labels are teacher-friendly', () => {
  assert.equal(confidenceLabel(0.96), 'Looks good');
  assert.equal(confidenceLabel(0.72), 'Check this');
  assert.equal(confidenceLabel(0.4), "Couldn't read clearly");
});

test('fallback is used only when extraction is weak', () => {
  assert.equal(needsFallback(0.93, [{ confidence: 0.9 }]), false);
  assert.equal(needsFallback(0.5, [{ confidence: 0.4 }]), true);
  assert.equal(needsFallback(0.9, []), true);
});

test('class diary sends one parent notification copy', () => {
  const copy = classDiaryNotificationCopy('8', 'A');
  assert.equal(copy.message, "Today's Class 8A Diary is available.");
  assert.equal(sanitizeSource('CLASS_DIARY_AI'), 'CLASS_DIARY_AI');
});
