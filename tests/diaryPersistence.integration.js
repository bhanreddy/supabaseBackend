import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

// Explicit local connection only; never load the application's .env database.
const url = process.env.DIARY_TEST_DATABASE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw new Error('Set DIARY_TEST_DATABASE_URL to an isolated local PostgreSQL connection');
}
const schema = `diary_test_${process.pid}`;
const admin = postgres(url, { ssl: false, max: 1 });
await admin.unsafe(`CREATE SCHEMA ${schema}`);
const db = postgres(url, {
  ssl: false, max: 4, prepare: false,
  connection: { search_path: schema, application_name: schema },
});
after(async () => {
  await db.end();
  await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

const warnings = [];
mock.module('../db.js', { defaultExport: db });
mock.module('../utils/logger.js', { defaultExport: { warn: (...args) => warnings.push(args), error() {} } });
mock.module('../services/ai/translationService.js', {
  namedExports: { translateDiaryFields: async ({ title, content }) => ({ title, content, title_te: title, content_te: content }) },
});
mock.module('../services/smartDiary/photoHistory.js', { namedExports: { recordDiaryPhotoHistory: async () => {} } });
mock.module('../services/notificationService.js', { namedExports: { sendNotificationToUsers: async () => {} } });
mock.module('../services/diaryDigestService.js', { namedExports: { DIARY_DIGEST_MESSAGE: 'Diary updated' } });
const { upsertDiaryEntry } = await import('../services/smartDiary/publishService.js');
const { logAiUsage } = await import('../services/ai/aiUsageService.js');

// Real AI log column definitions, with unrelated parent-table FKs omitted.
const ddl = await readFile(new URL('../migrations/20260911_smart_diary.sql', import.meta.url), 'utf8');
const usageDdl = ddl.match(/CREATE TABLE IF NOT EXISTS ai_usage_logs \([\s\S]*?\n\);/)[0]
  .replace(/ REFERENCES \w+\(id\) ON DELETE (CASCADE|SET NULL)/g, '');
await db.unsafe(usageDdl);
await db.unsafe(`CREATE TABLE diary_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), school_id INTEGER NOT NULL,
  class_section_id UUID NOT NULL, subject_id UUID, entry_date DATE NOT NULL,
  title TEXT, title_te TEXT, content TEXT, content_te TEXT, homework_due_date DATE,
  attachments JSONB, created_by UUID NOT NULL, entry_source VARCHAR(20),
  original_text TEXT, processed_text TEXT, ocr_status VARCHAR(20), ai_status VARCHAR(20),
  detected_language VARCHAR(20), source_diary_id UUID REFERENCES diary_entries(id) ON DELETE SET NULL,
  template_id UUID, submission_id UUID, processing_metadata JSONB, class_diary_upload_id UUID,
  syllabus_chapter_id UUID, syllabus_topic_id UUID, academic_plan_item_id UUID,
  notification_sent_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(school_id, class_section_id, subject_id, entry_date, created_by)
)`);
await db`CREATE UNIQUE INDEX ON diary_entries(school_id, submission_id) WHERE submission_id IS NOT NULL`;

const base = {
  schoolId: 17, userInternalId: randomUUID(), classSectionId: randomUUID(), subjectId: randomUUID(),
  entryDate: '2026-11-03', title: 'Homework', content: 'Complete exercise 4.2', deferNotification: true,
};
const save = (extra = {}) => upsertDiaryEntry({ ...base, classSectionId: randomUUID(), ...extra });

test('long AI errors persist without PostgreSQL 22001 and remain counted as failures', async () => {
  const errorCode = '😀'.repeat(100);
  await logAiUsage({ schoolId: 17, feature: 'DIARY_EXTRACTION', model: 'm'.repeat(120), success: false, errorCode });
  const [row] = await db`SELECT * FROM ai_usage_logs`;
  assert.equal(row.error_code, '😀'.repeat(80));
  assert.equal(row.model, 'm'.repeat(80));
  assert.equal(row.success, false);
  assert.deepEqual(warnings, []);
});

test('reusing a missing, malformed, deleted or foreign-school source still saves homework', async () => {
  const foreign = await save({ schoolId: 18 });
  const deleted = await save();
  await db`UPDATE diary_entries SET deleted_at = now() WHERE id = ${deleted.entry.id}`;
  for (const sourceDiaryId of [randomUUID(), 'not-a-uuid', deleted.entry.id, foreign.entry.id, null]) {
    const result = await save({ sourceDiaryId });
    assert.equal(result.createdNew, true);
    assert.equal(result.entry.source_diary_id, null);
    assert.equal(result.entry.content, base.content);
  }
});

test('valid sources are retained on insert and conflict update', async () => {
  const source = await save();
  const target = await save({ sourceDiaryId: source.entry.id });
  assert.equal(target.entry.source_diary_id, source.entry.id);
  const updated = await save({ classSectionId: target.entry.class_section_id, sourceDiaryId: randomUUID(), content: 'Updated homework' });
  assert.equal(updated.createdNew, false);
  assert.equal(updated.entry.content, 'Updated homework');
  assert.equal(updated.entry.source_diary_id, source.entry.id);
});

test('retries of the same submission stay idempotent', async () => {
  const submissionId = randomUUID();
  const first = await save({ submissionId, sourceDiaryId: randomUUID() });
  const second = await save({ submissionId, sourceDiaryId: randomUUID() });
  assert.equal(second.duplicate, true);
  assert.equal(second.entry.id, first.entry.id);
});

test('a source concurrently deleted before publishing resolves to null without an FK error', async () => {
  const source = await save();
  let startPublish;
  const deleting = new Promise(resolve => { startPublish = resolve; });
  let finishDelete;
  const publishStarted = new Promise(resolve => { finishDelete = resolve; });
  const deletion = db.begin(async tx => {
    await tx`DELETE FROM diary_entries WHERE id = ${source.entry.id}`;
    startPublish();
    await publishStarted;
  });
  await deleting;
  const publishing = save({ sourceDiaryId: source.entry.id });
  // Hold the DELETE until the publisher is actually blocked on the source row.
  // This exercises the lookup/delete race, rather than two sequential writes.
  try {
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const [row] = await admin`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE application_name = ${schema} AND wait_event_type = 'Lock'
          AND query LIKE '%INSERT INTO diary_entries%'
      ) AS blocked`;
      if (row.blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'Publisher waits for the concurrent source deletion');
  } finally { finishDelete(); }
  const [, result] = await Promise.all([deletion, publishing]);
  assert.equal(result.entry.source_diary_id, null);
  assert.equal(result.entry.content, base.content);
});
