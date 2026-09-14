import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import sql from '../db.js';
import {
  createAnecdote,
  getAnecdotes,
  getAnecdoteById,
  updateAnecdote,
  archiveAnecdote,
  addEvidence,
  createFollowUp,
} from '../services/anecdote/anecdoteService.js';
import { getAnecdoteAuditHistory } from '../services/anecdote/anecdoteAuditService.js';

let testSchoolId;
let testStudentId;
let testUserId;

test.before(async () => {
  // Find an existing school, student, and user from DB for testing
  const [school] = await sql`SELECT id FROM public.schools LIMIT 1`;
  testSchoolId = school ? school.id : 1;

  const [student] = await sql`
    SELECT id FROM public.students
    WHERE school_id = ${testSchoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  testStudentId = student ? student.id : randomUUID();

  const [user] = await sql`
    SELECT id FROM public.users
    WHERE school_id = ${testSchoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  testUserId = user ? user.id : randomUUID();
});

test.after(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('Anecdote Lifecycle: Creation, enrichment, audit logging, and offline idempotency', async () => {
  const clientId = randomUUID();

  // 1. Create Anecdote with offline clientId
  const created = await createAnecdote({
    schoolId: testSchoolId,
    userId: testUserId,
    payload: {
      student_id: testStudentId,
      observation_text: 'Rahul helped two classmates understand today mathematics activity during class.',
      client_generated_id: clientId,
      context: 'classroom',
    },
    ipAddress: '127.0.0.1',
  });

  assert.ok(created.id, 'Created record must have a UUID');
  assert.equal(created.student_id, testStudentId);
  assert.equal(created.sentiment, 'POSITIVE');
  assert.equal(created.observation_type, 'RECOGNITION');

  // 2. Offline Sync Idempotency: Submit same clientId again
  const duplicateAttempt = await createAnecdote({
    schoolId: testSchoolId,
    userId: testUserId,
    payload: {
      student_id: testStudentId,
      observation_text: 'Rahul helped two classmates understand today mathematics activity during class.',
      client_generated_id: clientId,
      context: 'classroom',
    },
    ipAddress: '127.0.0.1',
  });

  assert.equal(duplicateAttempt.id, created.id, 'Duplicate client_generated_id must return existing record');
  assert.equal(duplicateAttempt.is_duplicate, true, 'Flag is_duplicate should be true');

  // 3. Verify Audit Log was recorded
  const audits = await getAnecdoteAuditHistory({
    schoolId: testSchoolId,
    anecdoteId: created.id,
  });
  assert.ok(audits.length >= 1, 'At least 1 audit record should exist');
  assert.equal(audits[0].action, 'CREATED');

  // 4. Attach Evidence
  const evidence = await addEvidence({
    schoolId: testSchoolId,
    anecdoteId: created.id,
    userId: testUserId,
    evidenceData: {
      evidence_type: 'note',
      file_url: 'https://example.com/math_activity.png',
      file_name: 'math_activity.png',
    },
  });
  assert.equal(evidence.anecdote_id, created.id);

  // 5. Create Follow-up
  const followup = await createFollowUp({
    schoolId: testSchoolId,
    anecdoteId: created.id,
    userId: testUserId,
    followUpData: {
      due_date: '2026-09-20',
      notes: 'Check in on next group activity',
    },
  });
  assert.equal(followup.status, 'PENDING');

  // 6. Fetch Anecdote by ID with attachments
  const fetched = await getAnecdoteById({
    schoolId: testSchoolId,
    id: created.id,
    userRoles: ['teacher'],
  });
  assert.equal(fetched.id, created.id);
  assert.ok(fetched.evidence.length >= 1);
  assert.ok(fetched.followups.length >= 1);

  // 7. Update Observation
  const updated = await updateAnecdote({
    schoolId: testSchoolId,
    id: created.id,
    userId: testUserId,
    updates: {
      title: 'Classroom Leadership Note',
      severity: 'LEVEL_1_POSITIVE',
    },
  });
  assert.equal(updated.title, 'Classroom Leadership Note');

  // 8. Archive Observation
  const archived = await archiveAnecdote({
    schoolId: testSchoolId,
    id: created.id,
    userId: testUserId,
  });
  assert.equal(archived.success, true);
});
