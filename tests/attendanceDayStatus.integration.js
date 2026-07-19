// Truth-table integration test for compute_attendance_day_status().
//
// This uses a temporary table and rolls back, so no school or attendance data
// is created or changed.
// Run after applying the 20260719 migration:
//   node tests/attendanceDayStatus.integration.js
import assert from 'node:assert/strict';
import sql from '../db.js';

const ROLLBACK = Symbol('attendance-day-status-rollback');

async function run() {
  let assertions = 0;

  try {
    await sql.begin(async (tx) => {
      await tx`
        CREATE TEMP TABLE attendance_day_status_cases (
          label TEXT PRIMARY KEY,
          morning_status attendance_status_enum,
          afternoon_status attendance_status_enum,
          status attendance_status_enum NOT NULL
        ) ON COMMIT DROP
      `;

      await tx`
        CREATE TRIGGER compute_status
        BEFORE INSERT OR UPDATE ON attendance_day_status_cases
        FOR EACH ROW EXECUTE FUNCTION compute_attendance_day_status()
      `;

      await tx`
        INSERT INTO attendance_day_status_cases
          (label, morning_status, afternoon_status, status)
        VALUES
          ('morning present only', 'present', NULL, 'absent'),
          ('morning late only', 'late', NULL, 'absent'),
          ('afternoon present only', NULL, 'present', 'absent'),
          ('both present', 'present', 'present', 'absent'),
          ('present then absent', 'present', 'absent', 'absent'),
          ('absent then present', 'absent', 'present', 'absent'),
          ('morning absent only', 'absent', NULL, 'present'),
          ('both absent', 'absent', 'absent', 'present'),
          ('legacy overall late', NULL, NULL, 'late')
      `;

      const actual = await tx`
        SELECT label, status::text
        FROM attendance_day_status_cases
        ORDER BY label
      `;

      const expected = new Map([
        ['morning present only', 'present'],
        ['morning late only', 'present'],
        ['afternoon present only', 'present'],
        ['both present', 'present'],
        ['present then absent', 'half_day'],
        ['absent then present', 'half_day'],
        ['morning absent only', 'absent'],
        ['both absent', 'absent'],
        ['legacy overall late', 'late'],
      ]);

      for (const row of actual) {
        assert.equal(row.status, expected.get(row.label), row.label);
        assertions += 1;
      }
      assert.equal(actual.length, expected.size, 'all attendance cases were evaluated');
      assertions += 1;

      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  } finally {
    await sql.end();
  }

  console.log(`attendance day status integration: ${assertions} assertions passed`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
