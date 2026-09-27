import assert from 'node:assert/strict';
import test from 'node:test';
import { filterFamilyDiaryAttachments } from '../utils/diaryPresentation.js';

test('family diary response drops cross-school and external attachment URLs', () => {
  const origin = 'https://xyz.supabase.co';
  const own = `${origin}/storage/v1/object/public/diary-attachments/17/photos/11111111-1111-4111-8111-111111111111.jpg`;
  const other = own.replace('/17/', '/18/');
  const entry = { id: 'diary-1', attachments: [own, other, 'https://external.example/photo.jpg'] };
  const [safe] = filterFamilyDiaryAttachments([entry], ['parent'], 17, origin);
  assert.deepEqual(safe.attachments, [own]);
  assert.deepEqual(entry.attachments, [own, other, 'https://external.example/photo.jpg']);
  assert.deepEqual(filterFamilyDiaryAttachments([entry], ['teacher'], 17, origin)[0].attachments, entry.attachments);
  const [legacy] = filterFamilyDiaryAttachments(
    [{ attachments: JSON.stringify([{ url: own }, { url: other }]) }],
    ['student'],
    17,
    origin,
  );
  assert.deepEqual(legacy.attachments, [{ url: own }]);
});
