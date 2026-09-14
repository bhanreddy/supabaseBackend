import assert from 'node:assert/strict';
import test from 'node:test';

import { diaryStoragePathFromUrl } from '../utils/diaryStoragePath.js';
import { DIARY_PHOTO_RETENTION_DAYS, DIARY_RETENTION_DAYS } from '../utils/diaryRetention.js';

test('extracts supabase public object path from diary attachment URL', () => {
  const url = 'https://xyz.supabase.co/storage/v1/object/public/diary-attachments/12/photos/abc%20page.jpg?token=1';
  assert.equal(diaryStoragePathFromUrl(url), '12/photos/abc page.jpg');
});

test('returns null for non-diary urls', () => {
  assert.equal(diaryStoragePathFromUrl('https://cdn.example/photo.jpg'), null);
  assert.equal(diaryStoragePathFromUrl(''), null);
  assert.equal(diaryStoragePathFromUrl(null), null);
});

test('photo diary is retained for one month and text diary for 15 days', () => {
  assert.equal(DIARY_RETENTION_DAYS, 15);
  assert.equal(DIARY_PHOTO_RETENTION_DAYS, 30);
});
