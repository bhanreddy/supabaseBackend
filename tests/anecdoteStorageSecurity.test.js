import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANECDOTE_EVIDENCE_SIGNED_URL_TTL_SECONDS,
  ensureAnecdoteEvidenceBucket,
  getAnecdoteEvidenceSignedUrl,
  resetAnecdoteEvidenceBucketCache,
  signAnecdoteEvidenceList,
} from '../services/anecdote/anecdoteEvidenceStorage.js';

test('existing anecdote bucket is always updated to private', async () => {
  let updatedOptions;
  const storage = {
    getBucket: async () => ({ data: { id: 'anecdote-evidence', public: true }, error: null }),
    updateBucket: async (_name, options) => {
      updatedOptions = options;
      return { error: null };
    },
  };

  resetAnecdoteEvidenceBucketCache();
  await ensureAnecdoteEvidenceBucket(storage);
  assert.equal(updatedOptions.public, false);
});

test('signed evidence URLs use a 15-minute TTL and enforce tenant paths', async () => {
  let signedPath;
  let signedTtl;
  const storage = {
    from: () => ({
      createSignedUrl: async (path, ttl) => {
        signedPath = path;
        signedTtl = ttl;
        return { data: { signedUrl: 'https://signed.example/evidence' }, error: null };
      },
    }),
  };

  const url = await getAnecdoteEvidenceSignedUrl({
    schoolId: 17,
    storagePath: '17/anecdote/file.jpg',
    storage,
  });
  assert.equal(url, 'https://signed.example/evidence');
  assert.equal(signedPath, '17/anecdote/file.jpg');
  assert.equal(signedTtl, ANECDOTE_EVIDENCE_SIGNED_URL_TTL_SECONDS);

  await assert.rejects(
    () => getAnecdoteEvidenceSignedUrl({
      schoolId: 17,
      storagePath: '18/anecdote/file.jpg',
      storage,
    }),
    (error) => error.status === 403,
  );
});

test('read presentation replaces persisted public URL with a signed URL', async () => {
  const storage = {
    from: () => ({
      createSignedUrl: async () => ({
        data: { signedUrl: 'https://signed.example/fresh' },
        error: null,
      }),
    }),
  };
  const [item] = await signAnecdoteEvidenceList([{
    id: 'evidence-1',
    file_url: 'https://public.example/stale',
    storage_path: '7/anecdote/file.jpg',
  }], 7, { storage });

  assert.equal(item.file_url, 'https://signed.example/fresh');
  assert.equal('storage_path' in item, false);
});
