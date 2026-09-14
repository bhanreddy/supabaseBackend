import assert from 'node:assert/strict';
import test from 'node:test';

import { presentDiaryEntryForReader } from '../utils/diaryPresentation.js';

const bilingualEntry = {
  id: 'diary-1',
  title: 'Complete Chapter 5',
  title_te: 'అధ్యాయం 5 పూర్తి చేయండి',
  content: 'Answer questions 1 to 5.',
  content_te: '1 నుండి 5 వరకు ప్రశ్నలకు సమాధానం ఇవ్వండి.',
  processing_metadata: {
    homework: 'Answer questions 1 to 5.',
    confidence: { homework: 0.91 },
  },
};

test('parents receive structured homework without OCR internals', () => {
  const result = presentDiaryEntryForReader(bilingualEntry, ['parent']);
  assert.equal(result.title_te, bilingualEntry.title_te);
  assert.equal(result.structured.homework, 'Answer questions 1 to 5.');
  assert.equal('processing_metadata' in result, false);
  assert.equal('ocr_status' in result, false);
  assert.equal(result.structured.confidence, undefined);
});

test('staff reads still hide Telugu authoring columns', () => {
  const result = presentDiaryEntryForReader(bilingualEntry, ['staff']);
  assert.equal('title_te' in result, false);
  assert.equal(result.structured.homework, 'Answer questions 1 to 5.');
});
