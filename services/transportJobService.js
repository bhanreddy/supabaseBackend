import PgBoss from 'pg-boss';
import sql from '../db.js';
import config from '../config/env.js';
import logger from '../utils/logger.js';
import { sendDailyDiaryDigests } from './diaryDigestService.js';
import { runTransportMaintenanceForSchool } from './transportMaintenanceService.js';

export const TRANSPORT_MAINTENANCE_JOB = 'transport-nightly-maintenance';
export const DAILY_DIARY_DIGEST_JOB = 'daily-diary-digest';
let boss;
let scheduledJobsReady = false;

export const isTransportJobsReady = () => !config.transportJobs.enabled || scheduledJobsReady;
export const isDiaryDigestJobsReady = () => !config.diaryDigestJobs.enabled || scheduledJobsReady;

export async function startTransportJobs() {
  if ((!config.transportJobs.enabled && !config.diaryDigestJobs.enabled) || boss) return;
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

  scheduledJobsReady = true;
}

export async function stopTransportJobs() {
  const active = boss;
  boss = undefined;
  scheduledJobsReady = false;
  if (active) await active.stop({ graceful: true, timeout: 5000 });
}
