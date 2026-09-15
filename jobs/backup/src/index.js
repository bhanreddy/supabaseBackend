#!/usr/bin/env node
import { runBackup } from './backupRunner.js';
import baseLogger from './logger.js';

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {};

  for (const arg of args) {
    if (arg.startsWith('--type=')) {
      options.backupType = arg.split('=')[1];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

// Graceful shutdown handling for Cloud Run Job termination
let isShuttingDown = false;
const handleSignal = (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  baseLogger.warn({ event: 'JOB_INTERRUPTED', signal }, `Received ${signal}, aborting backup job`);
  process.exit(130);
};

process.on('SIGTERM', () => handleSignal('SIGTERM'));
process.on('SIGINT', () => handleSignal('SIGINT'));

async function main() {
  const cliOptions = parseCliArgs();
  const backupType = cliOptions.backupType || process.env.BACKUP_TYPE || 'daily';

  baseLogger.info(
    { event: 'JOB_INITIALIZING', backup_type: backupType },
    `Initializing schoolims-db-backup Cloud Run Job (${backupType})`
  );

  try {
    const job = await runBackup({
      backupType,
      dryRun: cliOptions.dryRun,
    });

    baseLogger.info(
      {
        event: 'JOB_EXIT_SUCCESS',
        backup_id: job.backup_id,
        duration_seconds: job.duration_seconds,
        file_size_bytes: job.file_size_bytes,
      },
      `Backup job ${job.backup_id} completed successfully. Exiting cleanly.`
    );
    process.exit(0);
  } catch (err) {
    baseLogger.error(
      {
        event: 'JOB_EXIT_FAILURE',
        error: err.message,
        stack: err.stack,
      },
      `Backup job failed with fatal error: ${err.message}`
    );
    process.exit(1);
  }
}

main();
