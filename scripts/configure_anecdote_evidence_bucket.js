import {
  ANECDOTE_EVIDENCE_BUCKET,
  ensureAnecdoteEvidenceBucket,
} from '../services/anecdote/anecdoteEvidenceStorage.js';

await ensureAnecdoteEvidenceBucket();
console.log(`${ANECDOTE_EVIDENCE_BUCKET} is configured as a private bucket.`);
