import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import sql from '../db.js';
import { MetadataService } from '../jobs/backup/src/metadataService.js';
import { encryptFile, decryptFile } from '../jobs/backup/src/encryptionService.js';
import { calculateFileSha256 } from '../jobs/backup/src/checksumService.js';
import { GcsStorageService } from '../jobs/backup/src/gcsStorageService.js';
import { buildBackupManifest } from '../jobs/backup/src/manifestService.js';
import { checkBackupSizeAnomaly } from '../jobs/backup/src/anomalyService.js';

test('Backup Pipeline Integration: End-to-end archive, encrypt, persist metadata and verify in DB', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-e2e-'));
  const testBackupId = `bkp_test_${Date.now()}`;
  const rawDumpPath = path.join(tmpDir, `${testBackupId}.dump`);
  const encDumpPath = path.join(tmpDir, `${testBackupId}.dump.enc`);
  const gcsRelativeArchive = `database/manual/2026/09/${testBackupId}.dump.enc`;
  const gcsRelativeManifest = `manifests/manual/2026/09/${testBackupId}.json`;

  const encryptionKey = crypto.randomBytes(32);
  const metadataService = new MetadataService(process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL);
  const storageService = new GcsStorageService({
    bucketName: 'test-schoolims-backup-bucket',
    isDryRun: true,
    localBackupDir: path.join(tmpDir, 'gcs-storage'),
  });

  try {
    // 1. Prepare a synthetic PostgreSQL dump with valid PGDMP magic header
    const pgHeader = Buffer.from('PGDMP\x01\x0f\x00\x00\x00');
    const dummyDbContent = Buffer.from('CREATE TABLE dummy_test (id int); INSERT INTO dummy_test VALUES (1);'.repeat(50));
    fs.writeFileSync(rawDumpPath, Buffer.concat([pgHeader, dummyDbContent]));

    // 2. Create job in public.backup_jobs
    const createdJob = await metadataService.createJob({
      backupId: testBackupId,
      backupType: 'manual',
      databaseVersion: 'PostgreSQL 17.6 (Test)',
      metadata: { test_run: true },
    });
    assert.ok(createdJob.id);
    assert.equal(createdJob.status, 'in_progress');

    // 3. Record BACKUP_STARTED & DUMP_STARTED
    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'BACKUP_STARTED',
      message: 'Integration test backup pipeline initiated',
    });

    // 4. Encrypt raw dump
    const encResult = await encryptFile(rawDumpPath, encDumpPath, encryptionKey);
    assert.ok(encResult.fileSizeBytes > 0);

    // 5. Calculate SHA-256
    const sha256 = await calculateFileSha256(encDumpPath);
    assert.ok(sha256);
    assert.equal(sha256.length, 64);

    await metadataService.recordEvent({
      backupJobId: createdJob.id,
      eventType: 'CHECKSUM_CREATED',
      message: `SHA-256 computed: ${sha256}`,
      metadata: { sha256 },
    });

    // 6. Anomaly detection check
    const recentJobs = await metadataService.getRecentSuccessfulBackups(5);
    const anomaly = checkBackupSizeAnomaly({
      currentSizeBytes: encResult.fileSizeBytes,
      recentBackups: recentJobs,
      thresholdPercent: 25,
    });
    assert.equal(typeof anomaly.isAnomaly, 'boolean');

    // 7. Upload to GCS Storage (atomic two-phase)
    const uploadResult = await storageService.uploadBackupArchive({
      localFilePath: encDumpPath,
      destinationPath: gcsRelativeArchive,
      backupId: testBackupId,
      sha256,
    });
    assert.ok(uploadResult.storagePath);

    // 8. Verify uploaded object
    const verifyResult = await storageService.verifyObject(
      gcsRelativeArchive,
      encResult.fileSizeBytes,
      sha256
    );
    assert.equal(verifyResult.verified, true);
    assert.equal(verifyResult.sizeBytes, encResult.fileSizeBytes);

    // 9. Build and upload manifest
    const manifest = buildBackupManifest({
      backupId: testBackupId,
      startedAt: createdJob.started_at,
      completedAt: new Date().toISOString(),
      backupType: 'manual',
      filePath: uploadResult.storagePath,
      fileSizeBytes: encResult.fileSizeBytes,
      sha256,
      postgresVersion: 'PostgreSQL 17.6',
    });
    const manifestPath = await storageService.uploadManifest(manifest, gcsRelativeManifest);
    assert.ok(manifestPath);

    // 10. Update job in database to success
    const updatedJob = await metadataService.updateJob({
      backupJobId: createdJob.id,
      status: 'success',
      durationSeconds: 2,
      fileSizeBytes: encResult.fileSizeBytes,
      storagePath: uploadResult.storagePath,
      checksumSha256: sha256,
      verificationStatus: 'verified',
      verifiedAt: new Date(),
    });
    assert.equal(updatedJob.status, 'success');
    assert.equal(updatedJob.verification_status, 'verified');

    // 11. Verify persisted row via direct SQL
    const [persisted] = await sql`
      SELECT id, backup_id, status, verification_status, checksum_sha256, file_size_bytes
      FROM public.backup_jobs
      WHERE id = ${createdJob.id}
    `;
    assert.equal(persisted.backup_id, testBackupId);
    assert.equal(persisted.status, 'success');
    assert.equal(persisted.verification_status, 'verified');
    assert.equal(persisted.checksum_sha256, sha256);

    // 12. Verify events were recorded
    const events = await sql`
      SELECT event_type FROM public.backup_events
      WHERE backup_job_id = ${createdJob.id}
      ORDER BY created_at ASC
    `;
    const eventTypes = events.map((e) => e.event_type);
    assert.ok(eventTypes.includes('BACKUP_STARTED'));
    assert.ok(eventTypes.includes('CHECKSUM_CREATED'));

    // 13. Test idempotency: attempting to upload duplicate path must fail
    await assert.rejects(
      async () => {
        await storageService.uploadBackupArchive({
          localFilePath: encDumpPath,
          destinationPath: gcsRelativeArchive,
          backupId: testBackupId,
          sha256,
        });
      },
      /IDEMPOTENCY_CONFLICT/
    );
  } finally {
    await metadataService.close();
    // Clean up test rows from database
    try {
      await sql`DELETE FROM public.backup_jobs WHERE backup_id = ${testBackupId}`;
    } catch (_) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
