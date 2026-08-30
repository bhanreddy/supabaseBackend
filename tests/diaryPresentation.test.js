import assert from 'node:assert/strict';
import test from 'node:test';

import {
  presentDiaryEntriesForReader,
  presentDiaryEntryForReader,
} from '../utils/diaryPresentation.js';

const bilingualEntry = {
  id: 'diary-1',
  title: 'Complete Chapter 5',
  title_te: 'అధ్యాయం 5 పూర్తి చేయండి',
  content: 'Answer questions 1 to 5.',
  content_te: '1 నుండి 5 వరకు ప్రశ్నలకు సమాధానం ఇవ్వండి.',
};

test('staff diary reads expose canonical English fields only', () => {
  assert.deepEqual(presentDiaryEntriesForReader([bilingualEntry], ['staff']), [
    {
      id: 'diary-1',
      title: 'Complete Chapter 5',
      content: 'Answer questions 1 to 5.',
    },
  ]);
});

test('teacher and principal portal reads use the same staff presentation', () => {
  for (const role of ['teacher', 'principal']) {
    const result = presentDiaryEntryForReader(bilingualEntry, [role]);
    assert.equal(result.title, bilingualEntry.title);
    assert.equal(result.content, bilingualEntry.content);
    assert.equal('title_te' in result, false);
    assert.equal('content_te' in result, false);
  }
});

test('parent and student reads retain Telugu translations', () => {
  for (const role of ['parent', 'student']) {
    assert.deepEqual(presentDiaryEntryForReader(bilingualEntry, [role]), bilingualEntry);
  }
});

test('presentation does not mutate the database result object', () => {
  const result = presentDiaryEntryForReader(bilingualEntry, ['staff']);
  assert.notEqual(result, bilingualEntry);
  assert.equal(bilingualEntry.title_te, 'అధ్యాయం 5 పూర్తి చేయండి');
});
