import PgBoss from 'pg-boss';
import { drainTransportOutbox } from './transportOutboxService.js';
import sql from '../db.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { sendDailyDiaryDigests } from './diaryDigestService.js';
import { runTransportMaintenanceForSchool } from './transportMaintenanceService.js';
import { runNightlyFeeReminderScan, FEE_REMINDER_JOB_NAME } from './feeAutomationJobService.js';
import { runNightlyAttendanceRiskScan, ATTENDANCE_RISK_JOB_NAME } from './attendanceAutomationJobService.js';
import { reconcileSafeguardingAttendance } from './transportSafeguardingService.js';
import { runNightlyFineLateFeeScan, LATE_FEE_SCAN_JOB } from './fineLateFeeEngine.js';
import { runAdmissionSlaScan, ADMISSION_SLA_JOB_NAME } from './admissionSlaJobService.js';
import { purgeExpiredDiaryPhotos } from './smartDiary/photoHistory.js';

export const TRANSPORT_MAINTENANCE_JOB = 'transport-nightly-maintenance';
export const DAILY_DIARY_DIGEST_JOB = 'daily-diary-digest';
export const DIARY_PHOTO_PURGE_JOB = 'diary-photo-history-purge';
let boss;
let scheduledJobsReady = false;

export const isTransportJobsReady = () => !config.transportJobs.enabled || scheduledJobsReady;
export const isFeeRecoveryJobsReady = () => !config.feeRecoveryJobs.enabled || scheduledJobsReady;
export const isDiaryDigestJobsReady = () => !config.diaryDigestJobs.enabled || scheduledJobsReady;

export async function startTransportJobs() {
  if ((!config.transportJobs.enabled && !config.diaryDigestJobs.enabled && !config.feeRecoveryJobs.enabled) || boss) return;
  boss = new PgBoss({
    connectionString: config.transportJobs.databaseUrl,
    schema: 'pgboss',
    application_name: 'schoolims-pgboss',
    // Small pool: the Supabase session pooler has limited slots and scheduled
    // jobs need only a couple of connections.
    max: 3,
    // TCP keepalive so a connection the pooler/NAT silently drops is detected and
    // recycled promptly, instead of surfacing minutes later as read ETIMEDOUT on
    // pg-boss's idle long-poll workers.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 30_000,
  });
  // Log a concise summary — pg errors carry the whole pg client object, which
  // otherwise floods the logs with thousands of lines per transient blip.
  boss.on('error', (error) => logger.error(
    { code: error?.code, message: error?.message, queue: error?.queue },
    'pg-boss scheduled worker error',
  ));
  await boss.start();

  if (config.transportJobs.enabled) {
    await boss.work('transport-outbox-drain', async () => {
      for (let batch=0; batch<20; batch++) { if (await drainTransportOutbox() < 30) break; }
    });
    await boss.schedule('transport-outbox-drain', '* * * * *', {}, { singletonKey: 'transport-outbox', retryLimit: 3, retryDelay: 5 });
    await boss.work(TRANSPORT_MAINTENANCE_JOB, async () => {
      // This is the trusted system-level dispatcher. Each maintenance operation
      // below receives one school id and scopes every read/write to that tenant.
      const schools = await sql`SELECT id FROM schools WHERE is_active = true ORDER BY id`;
      for (const school of schools) {
        const result = await runTransportMaintenanceForSchool(
          school.id,
          config.transportJobs.historyRetentionDays,
          sql,
        );
        logger.info(result, 'Transport nightly maintenance completed for school');
      }
    });

    await boss.schedule(
      TRANSPORT_MAINTENANCE_JOB,
      config.transportJobs.cron,
      {},
      { tz: config.transportJobs.timezone, singletonKey: 'nightly' },
    );
    logger.info({ cron: config.transportJobs.cron }, 'pg-boss transport maintenance scheduled');
  }

  if (config.diaryDigestJobs.enabled) {
    await boss.work(DAILY_DIARY_DIGEST_JOB, async () => {
      const result = await sendDailyDiaryDigests({
        timezone: config.diaryDigestJobs.timezone,
        cutoffHour: config.diaryDigestJobs.cutoffHour,
      });
      logger.info(result, 'Daily diary digest completed');
    });

    await boss.schedule(
      DAILY_DIARY_DIGEST_JOB,
      config.diaryDigestJobs.cron,
      {},
      {
        tz: config.diaryDigestJobs.timezone,
        singletonKey: 'daily',
        retryLimit: 2,
        retryDelay: 60,
        expireInMinutes: 60,
      },
    );
    logger.info(
      {
        cron: config.diaryDigestJobs.cron,
        timezone: config.diaryDigestJobs.timezone,
        cutoffHour: config.diaryDigestJobs.cutoffHour,
      },
      'pg-boss daily diary digest scheduled',
    );
  }

  if (config.feeRecoveryJobs.enabled) {
  await boss.work(FEE_REMINDER_JOB_NAME, async () => {
    const result = await runNightlyFeeReminderScan();
    logger.info(result, 'Fee reminder scan job completed');
  });

  await boss.schedule(
    FEE_REMINDER_JOB_NAME,
    '0 9 * * *', // Daily at 9:00 AM IST
    {},
    {
      tz: 'Asia/Kolkata',
      singletonKey: 'daily-fee-scan',
      retryLimit: 2,
      retryDelay: 120,
      expireInMinutes: 60,
    },
  );
  logger.info('pg-boss fee reminder scan scheduled');
  } else {
    await boss.unschedule(FEE_REMINDER_JOB_NAME);
  }

  // Register and schedule nightly automated attendance risk scan
  await boss.work(ATTENDANCE_RISK_JOB_NAME, async () => {
    try {
      const result = await runNightlyAttendanceRiskScan();
      logger.info({ count: result.length }, 'Attendance risk scan job completed');
    } catch (err) {
      logger.error({ err: err.message }, 'Attendance risk scan job failed');
    }
  });

  await boss.schedule(
    ATTENDANCE_RISK_JOB_NAME,
    '0 18 * * *', // Daily at 6:00 PM IST
    {},
    {
      tz: 'Asia/Kolkata',
      singletonKey: 'daily-attendance-risk-scan',
      retryLimit: 2,
      retryDelay: 120,
      expireInMinutes: 60,
    },
  );
  logger.info('pg-boss attendance risk scan scheduled');

  // Register and schedule morning safeguarding reconciliation worker
  const SAFEGUARDING_JOB_NAME = 'transport-safeguarding-reconcile';
  await boss.work(SAFEGUARDING_JOB_NAME, async () => {
    try {
      const activeSchools = await sql`SELECT id FROM schools WHERE is_active = true`;
      for (const school of activeSchools) {
        try {
          await reconcileSafeguardingAttendance({ schoolId: school.id, db: sql });
        } catch (schoolErr) {
          logger.error({ err: schoolErr.message, schoolId: school.id }, 'Safeguarding reconciliation failed for school');
        }
      }
      logger.info({ schoolsCount: activeSchools.length }, 'Safeguarding reconciliation completed');
    } catch (err) {
      logger.error({ err: err.message }, 'Safeguarding reconciliation job failed');
    }
  });

  await boss.schedule(
    SAFEGUARDING_JOB_NAME,
    '*/30 * * * 1-6', // Timings differ by school; reconciliation acts only on submitted attendance.
    {},
    {
      tz: 'Asia/Kolkata',
      singletonKey: 'morning-safeguarding-reconcile',
      retryLimit: 1,
      retryDelay: 60,
      expireInMinutes: 25,
    },
  );
  logger.info('pg-boss transport safeguarding reconciliation scheduled');

  // Register and schedule nightly automated fine late fee scanner
  await boss.work(LATE_FEE_SCAN_JOB, async () => {
    try {
      const result = await runNightlyFineLateFeeScan();
      logger.info(result, 'Fine late fee scan job completed');
    } catch (err) {
      logger.error({ err: err.message }, 'Fine late fee scan job failed');
    }
  });

  await boss.schedule(
    LATE_FEE_SCAN_JOB,
    '0 2 * * *', // Daily at 2:00 AM IST
    {},
    {
      tz: 'Asia/Kolkata',
      singletonKey: 'nightly-fine-late-fee-scan',
      retryLimit: 2,
      retryDelay: 120,
      expireInMinutes: 60,
    },
  );
  logger.info('pg-boss fine late fee scan scheduled');

  await boss.work(ADMISSION_SLA_JOB_NAME, async () => {
    try {
      const result = await runAdmissionSlaScan();
      logger.info(result, 'Admission SLA scan job completed');
    } catch (err) {
      logger.error({ err: err.message }, 'Admission SLA scan job failed');
    }
  });

  await boss.schedule(
    ADMISSION_SLA_JOB_NAME,
    '15 * * * *',
    {},
    {
      tz: 'Asia/Kolkata',
      singletonKey: 'hourly-admission-sla',
      retryLimit: 1,
      retryDelay: 120,
      expireInMinutes: 25,
    },
  );
  logger.info('pg-boss admission SLA scan scheduled');

  if (config.transportJobs.enabled || config.diaryDigestJobs.enabled) {
    await boss.work(DIARY_PHOTO_PURGE_JOB, async () => {
      const result = await purgeExpiredDiaryPhotos({ limit: 400 });
      logger.info(result, 'Expired diary photo history purged');
    });
    await boss.schedule(
      DIARY_PHOTO_PURGE_JOB,
      '15 2 * * *',
      {},
      { tz: 'Asia/Kolkata', singletonKey: 'nightly', retryLimit: 1 },
    );
    logger.info({ cron: '15 2 * * *' }, 'pg-boss diary photo history purge scheduled');
  }

  scheduledJobsReady = true;
}

export async function stopTransportJobs() {
  const active = boss;
  boss = undefined;
  scheduledJobsReady = false;
  if (active) await active.stop({ graceful: true, timeout: 5000 });
}
