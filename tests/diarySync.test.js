import assert from 'node:assert/strict';
import test from 'node:test';

import { isDiarySyncRequest } from '../utils/diarySync.js';

test('legacy diary pulls are treated as snapshot syncs regardless of timestamp', () => {
  assert.equal(
    isDiarySyncRequest({
      classSectionId: 'class-a',
      updatedSince: '1785400000000',
    }),
    true,
  );
  assert.equal(
    isDiarySyncRequest({
      classSectionId: 'class-a',
      updatedSince: '0',
    }),
    true,
  );
});

test('current diary pulls can explicitly request a snapshot', () => {
  assert.equal(
    isDiarySyncRequest({
      classSectionId: 'class-a',
      isSync: 'true',
    }),
    true,
  );
  assert.equal(
    isDiarySyncRequest({
      classSectionId: 'class-a',
      isSync: '1',
    }),
    true,
  );
});

test('ordinary class reads and unscoped requests are not reclassified as syncs', () => {
  assert.equal(
    isDiarySyncRequest({
      classSectionId: 'class-a',
    }),
    false,
  );
  assert.equal(
    isDiarySyncRequest({
      updatedSince: '0',
      isSync: 'true',
    }),
    false,
  );
});
