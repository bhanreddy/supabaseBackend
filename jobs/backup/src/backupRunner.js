import fs from 'node:fs';
import path from 'node:path';
import config, { assertDirectDatabaseUrl } from './config.js';
import { createBackupLogger } from './logger.js';
import { formatBackupTimestamps, withBackupIdDisambiguator } from './timestamps.js';
import { executePgDump, getPostgresVersion } from './pgDumpService.js';
import { encryptFile } from './encryptionService.js';
import { calculateFileSha256, calculateFileMd5Base64 } from './checksumService.js';
import { GcsStorageService } from './gcsStorageService.js';
import { buildBackupManifest } from './manifestService.js';
import { MetadataService } from './metadataService.js';
import { checkBackupSizeAnomaly, isBackupStale } from './anomalyService.js';
import { AlertService, AlertCondition, AlertSeverity } from './alertService.js';

export { formatBackupTimestamps };

const ALLOWED_BACKUP_TYPES = new Set(['daily', 'weekly', 'monthly', 'manual']);

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    // Best-effort cleanup of ephemeral artifacts.
  }
}

/**
 * Executes a full production database backup pipeline.
 *
 * @param {Object} [options]
 * @param {string} [options.backupType] 'daily' | 'weekly' | 'monthly' | 'manual'
 * @param {string} [options.databaseUrl]
 * @param {string} [options.gcsBucket]
 * @param {Buffer} [options.encryptionKey]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<Object>} Completed backup job summary
 */
export async function runBackup(options = {}) {
  const now = new Date();
  const timestamps = formatBackupTimestamps(now);
  let backupId = timestamps.backupId;
  const backupType = (options.backupType || config.backupType || 'daily').toLowerCase();
  if (!ALLOWED_BACKUP_TYPES.has(backupType)) {
    throw new Error(`[CONFIG_ERROR] Invalid BACKUP_TYPE '${backupType}'. Allowed: daily, weekly, monthly, manual`);
  }

  const databaseUrl = options.databaseUrl || config.databaseUrl;
  const gcsBucket = options.gcsBucket || config.gcsBucket;
  const isDryRun = options.dryRun !== undefined ? options.dryRun : config.dryRun;
  const localBackupDir = options.localBackupDir || config.localBackupDir;
  const encryptionKey = options.encryptionKey || config.encryptionKey;

  assertDirectDatabaseUrl(databaseUrl);

  if (!isDryRun && !gcsBucket) {
    throw new Error('[CONFIG_ERROR] GCS_BACKUP_BUCKET is required unless BACKUP_DRY_RUN=true');
  }

  let logger = createBackupLogger(backupId);
  const metadataService = new MetadataService(databaseUrl);
  const storageService = new GcsStorageService({
    bucketName: gcsBucket,
    projectId: config.projectId,
    isDryRun,
    localBackupDir,
  });
  const alertService = new AlertService({ webhookUrl: config.alertWebhookUrl, logger });

  fs.mkdirSync(localBackupDir, { recursive: true, mode: 0o700 });
  let rawDumpPath = path.join(localBackupDir, `${backupId}.dump`);
  let encDumpPath = path.join(localBackupDir, `${backupId}.dump.enc`);

  let gcsRelativeArchive = `database/${backupType}/${timestamps.year}/${timestamps.month}/schoolims-db-${timestamps.dateStr}.dump.enc`;
  let gcsRelativeManifest = `manifests/${backupType}/${timestamps.year}/${timestamps.month}/${timestamps.dateStr}.json`;

  const applyDisambiguator = (token) => {
    backupId = withBackupIdDisambiguator(timestamps.backupId, token);
    rawDumpPath = path.join(localBackupDir, `${backupId}.dump`);
    encDumpPath = path.join(localBackupDir, `${backupId}.dump.enc`);
    gcsRelativeArchive = `database/${backupType}/${timestamps.year}/${timestamps.month}/schoolims-db-${timestamps.dateStr}-r${token}.dump.enc`;
    gcsRelativeManifest = `manifests/${backupType}/${timestamps.year}/${timestamps.month}/${timestamps.dateStr}-r${token}.json`;
  };

  let currentStage = 'BACKUP_STARTED';
  let createdJob = null;
  const startedAt = now.toISOString();
  const startTimeMs = Date.now();

  try {
    const abandoned = await metadataService.markStaleInProgressJobs(120);
    if (abandoned.length > 0) {
      logger.warn('STALE_IN_PROGRESS_MARKED_FAILED', {
        abandoned_backup_ids: abandoned.map((row) => row.backup_id),
      });
    }

    const lastSuccess = await metadataService.getLastSuccessfulBackup();
    const stale = isBackupStale(lastSuccess?.completed_at, config.staleBackupHours);
    if (stale.stale) {
      await alertService.triggerAlert({
        condition: AlertCondition.NO_RECENT_BACKUP,
        severity: lastSuccess ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
        backupId,
        message: stale.message,
        metadata: { age_hours: stale.ageHours, threshold_hours: config.staleBackupHours },
      });
    }

    const existingJob = await metadataService.getJobByBackupId(backupId);
    if (existingJob || (await storageService.exists(gcsRelativeArchive))) {
      const token = Date.now() % 100000;
      applyDisambiguator(token);
      logger = createBackupLogger(backupId);
      logger.warn('BACKUP_ID_DISAMBIGUATED', {
        original_backup_id: timestamps.backupId,
        backup_id: backupId,
        reason: existingJob ? `existing_job_status=${existingJob.status}` : 'gcs_object_exists',
      });
    }

    const postgresVersion = await getPostgresVersion(databaseUrl);

    try {
      createdJob = await metadataService.createJob({
        backupId,
        backupType,
        databaseVersion: postgresVersion,
        metadata: { is_dry_run: isDryRun, gcs_bucket: gcsBucket || null },
      });
    } catch (insertErr) {
      if (String(insertErr.message || '').includes('backup_jobs_backup_id_key') || insertErr.code === '23505') {
        applyDisambiguator(Date.now() % 100000);
        logger = createBackupLogger(backupId);
        createdJob = await metadataService.createJob({
          backupId,
          backupType,
          databaseVersion: postgresVersion,
          metadata: { is_dry_run: isDryRun, gcs_bucket: gcsBucket || null, disambiguated: true },
        });
      } else {
        throw insertErr;
      }
    }

    logger.info('BACKUP_STARTED', { backup_type: backupType, database_version: postgresVersion });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'BACKUP_STARTED',
      message: `Starting ${backupType} backup for database schoolims`,
    });

    currentStage = 'DUMP_STARTED';
    logger.info('DUMP_STARTED', { outputPath: rawDumpPath });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'DUMP_STARTED',
      message: 'Invoking pg_dump in PostgreSQL custom format (-Fc)',
    });

    const dumpResult = await executePgDump({
      databaseUrl,
      outputPath: rawDumpPath,
      pgDumpPath: config.pgDumpPath,
    });

    currentStage = 'DUMP_COMPLETED';
    logger.info('DUMP_COMPLETED', {
      raw_size_bytes: dumpResult.fileSizeBytes,
      dump_duration_seconds: dumpResult.durationSeconds,
    });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'DUMP_COMPLETED',
      message: `pg_dump completed (${dumpResult.fileSizeBytes} bytes in ${dumpResult.durationSeconds}s)`,
      metadata: { raw_size_bytes: dumpResult.fileSizeBytes },
    });

    currentStage = 'COMPRESSION_STARTED';
    logger.info('COMPRESSION_STARTED', { method: 'pg_dump -Fc custom archive' });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'COMPRESSION_STARTED',
      message: 'Compression is included in pg_dump custom format (-Fc); no separate gzip pass',
    });

    currentStage = 'ENCRYPTION_STARTED';
    logger.info('ENCRYPTION_STARTED', { algorithm: 'aes-256-gcm' });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'ENCRYPTION_STARTED',
      message: 'Encrypting archive with AES-256-GCM',
    });

    const encResult = await encryptFile(rawDumpPath, encDumpPath, encryptionKey);
    safeUnlink(rawDumpPath);

    currentStage = 'CHECKSUM_CREATED';
    const sha256 = await calculateFileSha256(encDumpPath);
    const md5Base64 = await calculateFileMd5Base64(encDumpPath);
    logger.info('CHECKSUM_CREATED', { sha256, encrypted_size_bytes: encResult.fileSizeBytes });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'CHECKSUM_CREATED',
      message: `SHA-256 checksum generated: ${sha256}`,
      metadata: { sha256, encrypted_size_bytes: encResult.fileSizeBytes },
    });

    const recentBackups = await metadataService.getRecentSuccessfulBackups(5);
    const anomaly = checkBackupSizeAnomaly({
      currentSizeBytes: encResult.fileSizeBytes,
      recentBackups,
      thresholdPercent: config.anomalyThresholdPercent,
    });

    if (anomaly.isAnomaly) {
      logger.warn('BACKUP_SIZE_ANOMALY', { anomaly });
      await metadataService.recordEvent({
        backupJobId: createdJob.id,
        eventType: 'BACKUP_SIZE_ANOMALY',
        message: anomaly.message,
        metadata: anomaly,
      });
      await alertService.triggerAlert({
        condition: AlertCondition.SIZE_ANOMALY,
        severity: AlertSeverity.WARNING,
        backupId,
        message: anomaly.message,
        metadata: anomaly,
      });
    }

    currentStage = 'UPLOAD_STARTED';
    logger.info('UPLOAD_STARTED', { target_path: gcsRelativeArchive });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'UPLOAD_STARTED',
      message: `Uploading encrypted archive to ${gcsRelativeArchive}`,
    });

    const uploadResult = await storageService.uploadBackupArchive({
      localFilePath: encDumpPath,
      destinationPath: gcsRelativeArchive,
      backupId,
      sha256,
    });

    currentStage = 'UPLOAD_COMPLETED';
    logger.info('UPLOAD_COMPLETED', {
      storage_path: uploadResult.storagePath,
      size_bytes: uploadResult.sizeBytes,
    });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'UPLOAD_COMPLETED',
      message: `Encrypted archive uploaded to ${uploadResult.storagePath}`,
      metadata: { storage_path: uploadResult.storagePath },
    });

    currentStage = 'UPLOAD_VERIFIED';
    const verifyResult = await storageService.verifyObject(
      gcsRelativeArchive,
      encResult.fileSizeBytes,
      sha256,
      md5Base64
    );

    if (!verifyResult.verified) {
      throw new Error(
        `Remote verification failed for ${gcsRelativeArchive}. ` +
          `Expected size: ${encResult.fileSizeBytes}, remote size: ${verifyResult.sizeBytes}` +
          `${verifyResult.reason ? `, reason: ${verifyResult.reason}` : ''}`
      );
    }

    logger.info('UPLOAD_VERIFIED', { verified: true, size_bytes: verifyResult.sizeBytes });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'UPLOAD_VERIFIED',
      message: 'Remote archive verified against local SHA-256, MD5, and byte length',
    });

    currentStage = 'MANIFEST_CREATED';
    const completedAt = new Date().toISOString();
    const manifest = buildBackupManifest({
      backupId,
      startedAt,
      completedAt,
      backupType,
      filePath: uploadResult.storagePath,
      fileSizeBytes: encResult.fileSizeBytes,
      sha256,
      postgresVersion,
      encryptionAlgorithm: 'aes-256-gcm',
      verificationStatus: 'verified',
    });

    const manifestStoragePath = await storageService.uploadManifest(manifest, gcsRelativeManifest);
    logger.info('MANIFEST_CREATED', { manifest_storage_path: manifestStoragePath });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'MANIFEST_CREATED',
      message: `Backup manifest uploaded to ${manifestStoragePath}`,
      metadata: { manifest_storage_path: manifestStoragePath },
    });

    const durationSeconds = Math.round((Date.now() - startTimeMs) / 1000);
    const updatedJob = await metadataService.updateJob({
      backupJobId: createdJob.id,
      status: 'success',
      durationSeconds,
      fileSizeBytes: encResult.fileSizeBytes,
      storagePath: uploadResult.storagePath,
      checksumSha256: sha256,
      verificationStatus: 'verified',
      verifiedAt: new Date(),
      metadata: {
        manifest_path: manifestStoragePath,
        anomaly_flag: anomaly.isAnomaly,
      },
    });

    logger.info('BACKUP_COMPLETED', {
      duration_seconds: durationSeconds,
      file_size_bytes: encResult.fileSizeBytes,
      storage_path: uploadResult.storagePath,
    });
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'BACKUP_COMPLETED',
      message: `Backup completed successfully in ${durationSeconds}s (${encResult.fileSizeBytes} bytes)`,
    });

    return updatedJob;
  } catch (err) {
    const durationSeconds = Math.round((Date.now() - startTimeMs) / 1000);
    logger.error('BACKUP_FAILED', {
      failed_stage: currentStage,
      error: err.message,
      stack: err.stack,
    });

    let failureEventType = 'BACKUP_FAILED';
    let alertCondition = AlertCondition.BACKUP_FAILED;
    if (currentStage === 'DUMP_STARTED' || currentStage === 'DUMP_COMPLETED') {
      failureEventType = 'DUMP_FAILED';
    } else if (currentStage === 'ENCRYPTION_STARTED') {
      failureEventType = 'ENCRYPTION_FAILED';
      alertCondition = AlertCondition.ENCRYPTION_FAILED;
    } else if (currentStage === 'UPLOAD_STARTED' || currentStage === 'UPLOAD_COMPLETED') {
      failureEventType = 'UPLOAD_FAILED';
      alertCondition = AlertCondition.GCS_UPLOAD_FAILED;
    } else if (currentStage === 'UPLOAD_VERIFIED') {
      failureEventType = 'VERIFICATION_FAILED';
      alertCondition = AlertCondition.VERIFICATION_FAILED;
    }

    if (createdJob) {
      try {
        await metadataService.recordEvent({
          backupJobId: createdJob.id,
          eventType: failureEventType,
          message: err.message,
          metadata: { failed_stage: currentStage },
        });

        await metadataService.updateJob({
          backupJobId: createdJob.id,
          status: 'failed',
          durationSeconds,
          verificationStatus: 'failed',
          errorMessage: `[Stage: ${currentStage}] ${err.message}`,
        });
      } catch (recordErr) {
        logger.error('RECORD_FAILURE_ERROR', { error: recordErr.message });
      }
    }

    try {
      await alertService.triggerAlert({
        condition: alertCondition,
        severity: AlertSeverity.CRITICAL,
        backupId,
        message: `Backup failed at stage ${currentStage}: ${err.message}`,
        metadata: { stage: currentStage, duration_seconds: durationSeconds },
      });
    } catch (_) {}

    throw err;
  } finally {
    safeUnlink(rawDumpPath);
    safeUnlink(encDumpPath);
    await metadataService.close();
  }
}
