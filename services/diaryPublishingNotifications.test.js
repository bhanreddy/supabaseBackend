import assert from 'node:assert/strict';
import test, { beforeEach, afterEach, mock } from 'node:test';

const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const subjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const submissionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const state = { notifications: [], queries: [], entries: [], duplicate: false, failNotification: false };

const db = async (strings, ...values) => {
  const query = strings.join('?');
  state.queries.push(query);
  if (query.includes('INSERT INTO diary_entries')) {
    const entry = {
      id: `diary-${state.entries.length + 1}`,
      class_section_id: values[1],
      subject_id: values[2],
      entry_date: values[3],
      title: values[4],
      content: values[6],
      attachments: values[9],
      notification_sent_at: null,
      _was_insert: true,
    };
    state.entries.push(entry);
    return [entry];
  }
  if (query.includes('FROM diary_entries')) {
    return query.includes('submission_id') && !state.duplicate ? [] : [state.entries[0]];
  }
  if (query.includes('SET notification_sent_at = now()')) {
    for (const entry of state.entries) {
      if (values[1].includes(entry.id)) entry.notification_sent_at = new Date().toISOString();
    }
    return [];
  }
  if (query.includes('UPDATE diary_entries')) {
    const contentUpdated = values.some((value) => value === true);
    state.entries[0] = {
      ...state.entries[0], content: 'Processed homework',
      notification_sent_at: contentUpdated ? null : state.entries[0].notification_sent_at,
    };
    return [state.entries[0]];
  }
  if (query.includes('FROM class_diary_uploads')) return [];
  if (query.includes('INSERT INTO class_diary_uploads')) {
    return [{ id: 'upload-1', notification_sent_at: null, processing_status: 'published' }];
  }
  if (query.includes('FROM class_sections')) return [{ id: classId }];
  if (query.includes('FROM staff s')) return [{ id: 'staff-1' }];
  if (query.includes('AS ok')) return [{ ok: true }];
  if (query.includes('FROM subjects s')) return [{ id: subjectId }];
  if (query.includes('INSERT INTO diary_analytics_events')) return [];
  // Return a family recipient so early/late delivery is observable.
  if (query.includes('recipient_people')) return [{ id: 'parent-1' }];
  if (query.includes('notification_sent_at')) return [];
  throw new Error(`Unexpected query: ${query}`);
};
db.json = (value) => value;

mock.module('../db.js', { defaultExport: db });
mock.module('./notificationService.js', {
  namedExports: { sendNotificationToUsers: async (...args) => {
    if (state.failNotification) throw new Error('Notification unavailable');
    state.notifications.push(args);
    return { successCount: 1, failureCount: 0 };
  } },
});
mock.module('../utils/logger.js', { defaultExport: { error() {} } });
mock.module('./ai/translationService.js', {
  namedExports: { translateDiaryFields: async ({ title, content }) => ({ title, title_te: title, content, content_te: content }) },
});
mock.module('./smartDiary/photoHistory.js', {
  namedExports: { recordDiaryPhotoHistory: async () => ({ recorded: 0 }) },
});
mock.module('./smartDiary/classTeacherService.js', {
  namedExports: { loadClassSubjects: async () => [{ id: subjectId, name: 'Mathematics' }] },
});

const { upsertDiaryEntry, publishDiaryTargets, patchDiaryAiFields, notifyDiaryEntriesAfterCutoff } = await import('./smartDiary/publishService.js');
const { publishClassDiary } = await import('./smartDiary/classDiaryPublish.js');

beforeEach(() => {
  state.notifications = [];
  state.queries = [];
  state.entries = [];
  state.duplicate = false;
  state.failNotification = false;
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-28T11:59:59Z') });
});
afterEach(() => mock.timers.reset());

function assertDeferred() {
  assert.ok(state.entries.length > 0, 'Diary content was saved');
  assert.deepEqual(state.notifications, [], 'Uploading must not send a parent push');
  assert.ok(state.entries.every((entry) => entry.notification_sent_at === null), 'Entries remain eligible for the daily digest');
  assert.ok(state.queries.every((query) => !query.includes('SET notification_sent_at')), 'Uploading must not consume the digest');
}

test('manual subject diary saves without an automatic parent alert', async () => {
  const { entry } = await upsertDiaryEntry({
    schoolId: 17, userInternalId: 'teacher-1', classSectionId: classId,
    subjectId, entryDate: '2026-09-28', title: 'Mathematics', content: 'Complete exercise 4',
  });
  assert.equal(entry.content, 'Complete exercise 4');
  assert.ok(state.queries.some((query) => query.includes('notification_sent_at = NULL')), 'Re-uploaded entries must become eligible again');
  assertDeferred();
});

for (const entrySource of ['MANUAL', 'PHOTO', 'COPIED']) {
  test(`${entrySource} Smart Diary upload ignores legacy notify flags and waits for the digest`, async () => {
    const results = await publishDiaryTargets({
      schoolId: 17, userInternalId: 'teacher-1', userId: 'teacher-user', roles: ['teacher'],
      targets: [{ class_section_id: classId, subject_id: subjectId }],
      shared: {
        entry_date: '2026-09-28', title: 'Mathematics', content: 'Complete exercise 4',
        entry_source: entrySource, attachments: [], notify: true,
      },
    });
    assert.equal(results[0].createdNew, true);
    assertDeferred();
  });
}

for (const sendOriginal of [true, false]) {
  test(`class diary ${sendOriginal ? 'original photo' : 'extracted subjects'} saves without an automatic parent alert`, async () => {
    const result = await publishClassDiary({
      schoolId: 17, userInternalId: 'teacher-1', classSectionId: classId,
      entryDate: '2026-09-28', imageUrl: 'https://example.test/diary.jpg', submissionId,
      sendOriginal, section: { class_name: '8', section_name: 'A' },
      entries: [{ subject_id: subjectId, subject: 'Mathematics', homework: 'Complete exercise 4' }],
    });
    assert.equal(result.entries.length, 1);
    assertDeferred();
  });
}

test('OCR content completion before the cutoff remains eligible for the digest', async () => {
  state.entries.push({ id: 'diary-1', class_section_id: classId, notification_sent_at: '2026-09-28T11:00:00Z', content: 'Photo diary' });
  const result = await patchDiaryAiFields(17, 'diary-1', { content: 'Processed homework', aiStatus: 'succeeded' }, { notify: true });
  assert.equal(result.content, 'Processed homework');
  assert.ok(state.queries.some((query) => query.includes('THEN NULL ELSE notification_sent_at END')), 'Updated content must become eligible again');
  assertDeferred();
});

function assertImmediate(count = 1) {
  assert.equal(state.notifications.length, count);
  assert.deepEqual(state.notifications[0][0], ['parent-1']);
  assert.equal(state.notifications[0][1], 'DIARY_UPDATED');
  assert.deepEqual(state.notifications[0][3], { role: 'parent', schoolId: 17, deepLink: '/Screen/diary' });
  assert.ok(state.entries.every((entry) => entry.notification_sent_at), 'Sent entries must be excluded from the next digest');
}

test('manual diary published after the cutoff alerts immediately, regardless of entry date', async () => {
  mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
  await upsertDiaryEntry({
    schoolId: 17, userInternalId: 'teacher-1', classSectionId: classId,
    subjectId, entryDate: '2026-09-27', title: 'Mathematics', content: 'Complete exercise 4',
  });
  assertImmediate();
});

for (const entrySource of ['MANUAL', 'PHOTO', 'COPIED']) {
  test(`${entrySource} Smart Diary sends one immediate alert for a late batch`, async () => {
    mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
    await publishDiaryTargets({
      schoolId: 17, userInternalId: 'teacher-1', userId: 'teacher-user', roles: ['teacher'],
      targets: [{ class_section_id: classId, subject_id: subjectId }, { class_section_id: classId, subject_id: subjectId }],
      shared: { entry_date: '2026-09-28', content: 'Homework', entry_source: entrySource, notify: false },
    });
    assert.equal(state.entries.length, 2);
    assertImmediate();
  });
}

for (const sendOriginal of [true, false]) {
  test(`late class diary ${sendOriginal ? 'photo' : 'subjects'} sends one immediate alert`, async () => {
    mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
    await publishClassDiary({
      schoolId: 17, userInternalId: 'teacher-1', classSectionId: classId,
      entryDate: '2026-09-28', imageUrl: 'https://example.test/diary.jpg', submissionId, sendOriginal,
      entries: [
        { subject_id: subjectId, subject: 'Mathematics', homework: 'Exercise 4' },
        { subject_id: subjectId, subject: 'Mathematics', homework: 'Exercise 5' },
      ],
    });
    assert.equal(state.entries.length, sendOriginal ? 1 : 2);
    assertImmediate();
  });
}

test('retrying an existing submission after the cutoff does not alert again', async () => {
  mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
  state.duplicate = true;
  state.entries.push({ id: 'existing', class_section_id: classId, notification_sent_at: new Date().toISOString() });
  const result = await upsertDiaryEntry({ schoolId: 17, submissionId });
  assert.equal(result.duplicate, true);
  assert.deepEqual(state.notifications, []);
});

test('status-only OCR completion does not reset a delivered late alert', async () => {
  mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
  const sentAt = '2026-09-28T12:00:00Z';
  state.entries.push({ id: 'diary-1', class_section_id: classId, notification_sent_at: sentAt });
  await patchDiaryAiFields(17, 'diary-1', { aiStatus: 'skipped' });
  assert.equal(state.entries[0].notification_sent_at, sentAt);
  assert.deepEqual(state.notifications, []);
});

test('OCR content published after the cutoff alerts immediately', async () => {
  mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
  state.entries.push({ id: 'diary-1', class_section_id: classId, notification_sent_at: null });
  await patchDiaryAiFields(17, 'diary-1', { content: 'Processed homework', aiStatus: 'succeeded' });
  assertImmediate();
});

test('delivery exceptions preserve the published diary for the next digest', async () => {
  mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
  state.failNotification = true;
  const { entry } = await upsertDiaryEntry({
    schoolId: 17, userInternalId: 'teacher-1', classSectionId: classId,
    subjectId, entryDate: '2026-09-28', content: 'Homework',
  });
  assert.ok(entry.id);
  assert.equal(state.entries[0].notification_sent_at, null);
});

test('partial delivery failures remain eligible for the digest', async () => {
  mock.timers.setTime(Date.parse('2026-09-28T12:00:01Z'));
  state.entries.push({ id: 'diary-1', class_section_id: classId, notification_sent_at: null });
  await notifyDiaryEntriesAfterCutoff(17, state.entries, {
    notify: async () => ({ successCount: 1, failureCount: 1 }),
  });
  assert.equal(state.entries[0].notification_sent_at, null);
  assert.ok(state.queries.every((query) => !query.includes('SET notification_sent_at')));
});

test('marking delivered entries is scoped to the school, published IDs, and pre-dispatch version', async () => {
  const now = new Date('2026-09-28T12:00:01Z');
  let marker;
  await notifyDiaryEntriesAfterCutoff(17, [{ id: 'diary-1', class_section_id: classId }], {
    now,
    db: async (strings, ...values) => {
      if (strings.join('').includes('recipient_people')) return [{ id: 'student-1' }];
      marker = { query: strings.join('?'), values };
      return [];
    },
    notify: async () => ({ successCount: 1, failureCount: 0 }),
  });
  assert.deepEqual(marker.values, [17, ['diary-1'], now]);
  assert.match(marker.query, /notification_sent_at IS NULL/);
  assert.match(marker.query, /GREATEST\(COALESCE\(updated_at, created_at\), created_at\) <=/);
  assert.match(marker.query, /deleted_at IS NULL/);
});
