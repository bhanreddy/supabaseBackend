import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import postgres from 'postgres';

mock.module('../db.js', { defaultExport: async () => [] });
mock.module('../utils/logger.js', { defaultExport: {} });
mock.module('./notificationService.js', { namedExports: { sendNotificationToUsers: async () => {} } });
const { getDailyDiaryDigestRecipients } = await import('./diaryDigestService.js');

const databaseUrl = process.env.DIARY_DIGEST_TEST_DATABASE_URL;

test('digest SQL includes the 5:00–5:30 PM uploads and carries later uploads into the next evening', {
  skip: !databaseUrl && 'Set DIARY_DIGEST_TEST_DATABASE_URL to an isolated local PostgreSQL database',
}, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseUrl).hostname), 'Use only a local test database');
  const db = postgres(databaseUrl, { max: 1 });
  try {
    await db.begin(async (tx) => {
      await tx.unsafe(`
        CREATE TEMP TABLE schools (id int, is_active boolean) ON COMMIT DROP;
        CREATE TEMP TABLE diary_entries (school_id int, class_section_id text, created_at timestamptz, updated_at timestamptz, notification_sent_at timestamptz, deleted_at timestamptz) ON COMMIT DROP;
        CREATE TEMP TABLE students (id text, school_id int, person_id text, deleted_at timestamptz) ON COMMIT DROP;
        CREATE TEMP TABLE student_enrollments (student_id text, school_id int, class_section_id text, status text, deleted_at timestamptz, start_date date, end_date date) ON COMMIT DROP;
        CREATE TEMP TABLE parents (id text, school_id int, person_id text, deleted_at timestamptz) ON COMMIT DROP;
        CREATE TEMP TABLE student_parents (student_id text, parent_id text, school_id int, deleted_at timestamptz, valid_from date, valid_to date) ON COMMIT DROP;
        CREATE TEMP TABLE users (id text, school_id int, person_id text, account_status text, deleted_at timestamptz) ON COMMIT DROP;
        INSERT INTO schools VALUES (17, true), (18, false);
      `);

      async function seed(key, postedAt, { schoolId = 17, notified = false, deleted = false, active = true } = {}) {
        await tx`INSERT INTO diary_entries VALUES (
          ${schoolId}, ${key}, ${postedAt}, ${postedAt},
          ${notified ? postedAt : null}, ${deleted ? postedAt : null}
        )`;
        await tx`INSERT INTO students VALUES (${key}, ${schoolId}, ${`student-person-${key}`}, NULL)`;
        await tx`INSERT INTO student_enrollments VALUES (${key}, ${schoolId}, ${key}, ${active ? 'active' : 'inactive'}, NULL, '2026-06-01', NULL)`;
        await tx`INSERT INTO parents VALUES (${key}, ${schoolId}, ${`parent-person-${key}`}, NULL)`;
        await tx`INSERT INTO student_parents VALUES (${key}, ${key}, ${schoolId}, NULL, NULL, NULL)`;
        await tx`INSERT INTO users VALUES
          (${`student-${key}`}, ${schoolId}, ${`student-person-${key}`}, 'active', NULL),
          (${`parent-${key}`}, ${schoolId}, ${`parent-person-${key}`}, 'active', NULL)`;
      }

      await seed('old-boundary', '2026-09-27T12:00:00Z');
      await seed('late-yesterday', '2026-09-27T12:01:00Z');
      await seed('1720', '2026-09-28T11:50:00Z');
      await seed('1730', '2026-09-28T12:00:00Z');
      await seed('late-today', '2026-09-28T12:00:01Z');
      await seed('notified', '2026-09-28T11:50:00Z', { notified: true });
      await seed('deleted', '2026-09-28T11:50:00Z', { deleted: true });
      await seed('inactive-student', '2026-09-28T11:50:00Z', { active: false });
      await seed('inactive-school', '2026-09-28T11:50:00Z', { schoolId: 18 });

      // Two subjects and two children still notify their shared guardian once.
      await tx`INSERT INTO diary_entries VALUES (17, '1720', '2026-09-28T11:51:00Z', NULL, NULL, NULL)`;
      await tx`INSERT INTO student_parents VALUES ('1730', '1720', 17, NULL, NULL, NULL)`;
      // A matching person ID in another school must never become a recipient.
      await tx`INSERT INTO users VALUES ('other-school', 18, 'parent-person-1720', 'active', NULL)`;

      async function recipientsAt(now) {
        const queryDb = (strings, ...values) => {
          let query = strings[0];
          for (let index = 0; index < values.length; index++) query += `$${index + 1}${strings[index + 1]}`;
          // Control the clock while exercising the production SQL unchanged.
          query = query.replaceAll('now()', `$${values.length + 1}::timestamptz`);
          return tx.unsafe(query, [...values, now]);
        };
        return Array.from(await getDailyDiaryDigestRecipients('Asia/Kolkata', 17, 30, queryDb));
      }

      assert.deepEqual(await recipientsAt('2026-09-28T12:00:00Z'), [
        'parent-1720', 'parent-1730', 'parent-late-yesterday',
        'student-1720', 'student-1730', 'student-late-yesterday',
      ].map((user_id) => ({ school_id: 17, user_id })));
      assert.deepEqual(await recipientsAt('2026-09-29T12:00:00Z'), [
        { school_id: 17, user_id: 'parent-late-today' },
        { school_id: 17, user_id: 'student-late-today' },
      ]);
    });
  } finally {
    await db.end();
  }
});
