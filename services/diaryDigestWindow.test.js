import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import postgres from 'postgres';

mock.module('../db.js', { defaultExport: async () => [] });
mock.module('../utils/logger.js', { defaultExport: { error({ err }) { throw err; } } });
mock.module('./notificationService.js', { namedExports: { sendNotificationToUsers: async () => {} } });
mock.module('./ai/translationService.js', { namedExports: { translateDiaryFields: async (fields) => fields } });
mock.module('./smartDiary/photoHistory.js', { namedExports: { recordDiaryPhotoHistory: async () => {} } });
const { getDailyDiaryDigestRecipients } = await import('./diaryDigestService.js');
const { notifyDiaryEntriesAfterCutoff, withDiaryPublication } = await import('./smartDiary/publishService.js');

const databaseUrl = process.env.DIARY_DIGEST_TEST_DATABASE_URL;

test('digest SQL uses the same IST day and late alerts mark only the published version', {
  skip: !databaseUrl && 'Set DIARY_DIGEST_TEST_DATABASE_URL to an isolated local PostgreSQL database',
}, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname), 'Use only a local test database');
  const db = postgres(databaseUrl, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe(`
        SET LOCAL TIME ZONE 'UTC';
        CREATE TEMP TABLE schools (id int, is_active boolean) ON COMMIT DROP;
        CREATE TEMP TABLE diary_entries (school_id int, class_section_id text, created_at timestamptz, updated_at timestamptz, notification_sent_at timestamptz, deleted_at timestamptz, id uuid) ON COMMIT DROP;
        CREATE TEMP TABLE students (id text, school_id int, person_id text, deleted_at timestamptz) ON COMMIT DROP;
        CREATE TEMP TABLE student_enrollments (student_id text, school_id int, class_section_id text, status text, deleted_at timestamptz, start_date date, end_date date) ON COMMIT DROP;
        CREATE TEMP TABLE parents (id text, school_id int, person_id text, deleted_at timestamptz) ON COMMIT DROP;
        CREATE TEMP TABLE student_parents (student_id text, parent_id text, school_id int, deleted_at timestamptz, valid_from date, valid_to date) ON COMMIT DROP;
        CREATE TEMP TABLE users (id text, school_id int, person_id text, account_status text, deleted_at timestamptz) ON COMMIT DROP;
        INSERT INTO schools VALUES (17, true), (18, false);
      `);

      async function seed(key, postedAt, { schoolId = 17, notified = false, deleted = false, active = true, createdAt = postedAt } = {}) {
        const [row] = await tx`INSERT INTO diary_entries VALUES (
          ${schoolId}, ${key}, ${createdAt}, ${postedAt},
          ${notified ? postedAt : null}, ${deleted ? postedAt : null}, ${randomUUID()}
        ) RETURNING *, updated_at::text AS _published_at`;
        await tx`INSERT INTO students VALUES (${key}, ${schoolId}, ${`student-person-${key}`}, NULL)`;
        await tx`INSERT INTO student_enrollments VALUES (${key}, ${schoolId}, ${key}, ${active ? 'active' : 'inactive'}, NULL, '2026-06-01', NULL)`;
        await tx`INSERT INTO parents VALUES (${key}, ${schoolId}, ${`parent-person-${key}`}, NULL)`;
        await tx`INSERT INTO student_parents VALUES (${key}, ${key}, ${schoolId}, NULL, NULL, NULL)`;
        await tx`INSERT INTO users VALUES
          (${`student-${key}`}, ${schoolId}, ${`student-person-${key}`}, 'active', NULL),
          (${`parent-${key}`}, ${schoolId}, ${`parent-person-${key}`}, 'active', NULL)`;
        return withDiaryPublication(row);
      }

      async function recipientsAt(now) {
        const queryDb = (strings, ...values) => {
          let query = strings[0];
          for (let index = 0; index < values.length; index++) query += `$${index + 1}${strings[index + 1]}`;
          // Control the clock while exercising the production SQL unchanged.
          query = query.replaceAll('now()', `$${values.length + 1}::timestamptz`);
          return tx.unsafe(query, [...values, now]);
        };
        return Array.from(await getDailyDiaryDigestRecipients('Asia/Kolkata', 16, 30, queryDb));
      }

      const sundayCutoff = '2026-11-08T11:00:00Z';
      const mondayCutoff = '2026-11-09T11:00:00Z';
      await seed('saturday', '2026-11-07T18:29:59.999999Z');
      assert.deepEqual(await recipientsAt(sundayCutoff), [], 'Saturday activity alone must not send a Sunday alert');

      await seed('midnight', '2026-11-07T18:30:00Z');
      await seed('early', '2026-11-07T18:30:00.000001Z');
      await seed('recent-edit', '2026-11-08T10:59:59.999999Z', { createdAt: '2026-11-07T18:29:59Z' });
      await seed('at-cutoff', sundayCutoff);
      const late = await seed('late', '2026-11-08T11:00:01.123863Z');
      await seed('notified', '2026-11-08T10:55:00Z', { notified: true });
      await seed('deleted', '2026-11-08T10:55:00Z', { deleted: true });
      await seed('inactive-student', '2026-11-08T10:55:00Z', { active: false });
      await seed('inactive-school', '2026-11-08T10:55:00Z', { schoolId: 18 });

      // Two subjects and two children still notify their shared guardian once.
      await tx`INSERT INTO diary_entries VALUES (17, 'early', '2026-11-08T10:55:00Z', NULL, NULL, NULL, ${randomUUID()})`;
      await tx`INSERT INTO student_parents VALUES ('midnight', 'early', 17, NULL, NULL, NULL)`;
      // A matching person ID in another school must never become a recipient.
      await tx`INSERT INTO users VALUES ('other-school', 18, 'parent-person-early', 'active', NULL)`;

      assert.deepEqual(await recipientsAt('2026-11-08T10:59:59.999999Z'), [], 'An early job must not send before 4:30 PM');
      assert.deepEqual(await recipientsAt(sundayCutoff), [
        'parent-early', 'parent-midnight', 'parent-recent-edit',
        'student-early', 'student-midnight', 'student-recent-edit',
      ].map((user_id) => ({ school_id: 17, user_id })));
      assert.deepEqual(await recipientsAt(mondayCutoff), [], 'Unmarked late entries must not spill into Monday');

      const notifications = [];
      await notifyDiaryEntriesAfterCutoff(17, [late], {
        db: tx,
        notify: async (...args) => {
          notifications.push(args);
          return { successCount: 2, failureCount: 0 };
        },
      });
      assert.equal(notifications.length, 1);
      assert.deepEqual(notifications[0][0].sort(), ['parent-late', 'student-late']);
      const [sent] = await tx`SELECT notification_sent_at FROM diary_entries WHERE id = ${late.id}`;
      assert.ok(sent.notification_sent_at, 'The precise database timestamp survives a successful send');
      assert.equal(JSON.parse(JSON.stringify(late))._published_at, undefined);

      // A newer edit in the same millisecond must not be marked by the older send.
      const edited = await seed('edited', '2026-11-08T11:00:02.123100Z');
      await notifyDiaryEntriesAfterCutoff(17, [edited], {
        db: tx,
        notify: async () => {
          await tx`UPDATE diary_entries SET updated_at = '2026-11-08T11:00:02.123900Z' WHERE id = ${edited.id}`;
          return { successCount: 2, failureCount: 0 };
        },
      });
      const [newer] = await tx`SELECT notification_sent_at FROM diary_entries WHERE id = ${edited.id}`;
      assert.equal(newer.notification_sent_at, null, 'An immediate send must not consume a newer edit');
    });
  } finally {
    await db.end();
  }
});
