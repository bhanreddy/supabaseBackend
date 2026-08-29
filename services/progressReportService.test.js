import test from 'node:test';
import assert from 'node:assert/strict';

import { filterEnteredProgressReportSubjects } from './progressReportService.js';

test('excludes subjects that have no saved marks row', () => {
  const subjects = filterEnteredProgressReportSubjects([
    { subject: 'English', hasMarks: false, obtained: null, maxMarks: 100 },
    { subject: 'Mathematics', hasMarks: true, obtained: 72, maxMarks: 80 },
  ]);

  assert.deepEqual(subjects.map((subject) => subject.subject), ['Mathematics']);
  assert.equal(subjects.reduce((total, subject) => total + subject.maxMarks, 0), 80);
});

test('keeps saved zero scores and saved absences', () => {
  const subjects = filterEnteredProgressReportSubjects([
    { subject: 'Science', hasMarks: true, obtained: 0, maxMarks: 50, is_absent: false },
    { subject: 'Hindi', mark_id: 'saved-absence', obtained: null, maxMarks: 50, is_absent: true },
  ]);

  assert.deepEqual(subjects.map((subject) => subject.subject), ['Science', 'Hindi']);
  assert.equal(subjects.reduce((total, subject) => total + subject.maxMarks, 0), 100);
});
