import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

const classId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const subjectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const submissionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const state = { notifications: [], queries: [], entries: [] };

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
    return query.includes('submission_id') ? [] : [state.entries[0]];
  }
  if (query.includes('UPDATE diary_entries')) {
    state.entries[0] = { ...state.entries[0], content: 'Processed homework', notification_sent_at: null };
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
  // These are only used by the old immediate-notification path. Returning
  // recipients makes a regression observable rather than hiding it.
  if (query.includes('recipient_people')) return [{ id: 'parent-1' }];
  if (query.includes('notification_sent_at')) return [];
  throw new Error(`Unexpected query: ${query}`);
};
db.json = (value) => value;

mock.module('../db.js', { defaultExport: db });
mock.module('./notificationService.js', {
  namedExports: { sendNotificationToUsers: async (...args) => state.notifications.push(args) },
});
mock.module('./ai/translationService.js', {
  namedExports: { translateDiaryFields: async ({ title, content }) => ({ title, title_te: title, content, content_te: content }) },
});
mock.module('./smartDiary/photoHistory.js', {
  namedExports: { recordDiaryPhotoHistory: async () => ({ recorded: 0 }) },
});
mock.module('./smartDiary/classTeacherService.js', {
  namedExports: { loadClassSubjects: async () => [{ id: subjectId, name: 'Mathematics' }] },
});

const { upsertDiaryEntry, publishDiaryTargets, patchDiaryAiFields } = await import('./smartDiary/publishService.js');
const { publishClassDiary } = await import('./smartDiary/classDiaryPublish.js');

beforeEach(() => {
  state.notifications = [];
  state.queries = [];
  state.entries = [];
});

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

test('OCR completion cannot trigger an automatic parent alert, even with a legacy notify flag', async () => {
  state.entries.push({ id: 'diary-1', class_section_id: classId, notification_sent_at: '2026-09-28T11:00:00Z', content: 'Photo diary' });
  const result = await patchDiaryAiFields(17, 'diary-1', { aiStatus: 'succeeded' }, { notify: true });
  assert.equal(result.content, 'Processed homework');
  assert.ok(state.queries.some((query) => query.includes('notification_sent_at = NULL')), 'Updated entries must become eligible again');
  assertDeferred();
});
