import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import cronParser from 'cron-parser';

// Isolated process configuration: legacy schedule overrides must not move the
// required 5:30 PM IST digest, and diary scheduling must work without transport.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_SERVICE_ROLE_KEY: 'test',
  TRANSPORT_JOBS_ENABLED: 'false',
  FEE_RECOVERY_JOBS_ENABLED: 'false',
  DIARY_DIGEST_ENABLED: 'true',
  DIARY_DIGEST_HOUR: '16',
  DIARY_DIGEST_CRON: '0 16 * * *',
  DIARY_DIGEST_TIMEZONE: 'UTC',
});

const schedules = [];
const workers = new Map();
const digestCalls = [];
mock.module('pg-boss', {
  defaultExport: class {
    on() {}
    async start() {}
    async stop() {}
    async unschedule() {}
    async work(name, worker) { workers.set(name, worker); }
    async schedule(name, cron, data, options) { schedules.push({ name, cron, data, options }); }
  },
});
mock.module('../db.js', { defaultExport: async () => [] });
mock.module('../utils/logger.js', { defaultExport: { info() {}, error() {} } });
mock.module('./diaryDigestService.js', {
  namedExports: { sendDailyDiaryDigests: async (options) => { digestCalls.push(options); return {}; } },
});

for (const [modulePath, namedExports] of [
  ['./transportOutboxService.js', { drainTransportOutbox: async () => 0 }],
  ['./transportMaintenanceService.js', { runTransportMaintenanceForSchool: async () => {} }],
  ['./feeAutomationJobService.js', { runNightlyFeeReminderScan: async () => {}, FEE_REMINDER_JOB_NAME: 'fees' }],
  ['./attendanceAutomationJobService.js', { runNightlyAttendanceRiskScan: async () => {}, ATTENDANCE_RISK_JOB_NAME: 'attendance' }],
  ['./transportSafeguardingService.js', { reconcileSafeguardingAttendance: async () => {} }],
  ['./fineLateFeeEngine.js', { runNightlyFineLateFeeScan: async () => {}, LATE_FEE_SCAN_JOB: 'late-fees' }],
  ['./admissionSlaJobService.js', { runAdmissionSlaScan: async () => {}, ADMISSION_SLA_JOB_NAME: 'admissions' }],
  ['./smartDiary/photoHistory.js', { purgeExpiredDiaryPhotos: async () => {} }],
]) {
  mock.module(modulePath, { namedExports });
}

const { default: config } = await import('../config/env.js');
const { startTransportJobs, stopTransportJobs, isDiaryDigestJobsReady, DAILY_DIARY_DIGEST_JOB } = await import('./transportJobService.js');

test('diary digest is registered at 5:30 PM IST and the worker receives the matching minute cutoff', async () => {
  assert.deepEqual(config.diaryDigestJobs, {
    enabled: true, cutoffHour: 17, cutoffMinute: 30, cron: '30 17 * * *', timezone: 'Asia/Kolkata',
  });
  assert.equal(isDiaryDigestJobsReady(), false);
  try {
    await startTransportJobs();
    assert.equal(isDiaryDigestJobsReady(), true);
    const digestSchedule = schedules.find(({ name }) => name === DAILY_DIARY_DIGEST_JOB);
    assert.ok(digestSchedule);
    assert.equal(digestSchedule.cron, '30 17 * * *');
    assert.equal(digestSchedule.options.tz, 'Asia/Kolkata');
    const next = cronParser.parseExpression(digestSchedule.cron, {
      tz: digestSchedule.options.tz,
      currentDate: '2026-09-28T11:59:00Z',
    }).next().toISOString();
    assert.equal(next, '2026-09-28T12:00:00.000Z');

    await workers.get(DAILY_DIARY_DIGEST_JOB)();
    assert.deepEqual(digestCalls, [{ timezone: 'Asia/Kolkata', cutoffHour: 17, cutoffMinute: 30 }]);
    await startTransportJobs();
    assert.equal(schedules.filter(({ name }) => name === DAILY_DIARY_DIGEST_JOB).length, 1);
  } finally {
    await stopTransportJobs();
  }
});
