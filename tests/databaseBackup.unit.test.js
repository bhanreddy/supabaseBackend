import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { formatBackupTimestamps, withBackupIdDisambiguator } from '../jobs/backup/src/timestamps.js';
import { encryptFile, decryptFile } from '../jobs/backup/src/encryptionService.js';
import { calculateFileSha256, calculateBufferSha256, calculateFileMd5Base64 } from '../jobs/backup/src/checksumService.js';
import { buildBackupManifest, sanitizeManifest } from '../jobs/backup/src/manifestService.js';
import { checkBackupSizeAnomaly, formatBytes, isBackupStale } from '../jobs/backup/src/anomalyService.js';
import { parseConnectionParams } from '../jobs/backup/src/pgDumpService.js';
import { assertDirectDatabaseUrl, resolveEncryptionKey } from '../jobs/backup/src/config.js';
import { GcsStorageService } from '../jobs/backup/src/gcsStorageService.js';

test('Backup Timestamps: generates deterministic and valid format', () => {
  const fixedDate = new Date('2026-09-14T02:00:00.000Z');
  const result = formatBackupTimestamps(fixedDate);

  assert.equal(result.backupId, 'bkp_20260914_020000');
  assert.equal(result.dateStr, '2026-09-14-020000');
  assert.equal(result.year, '2026');
  assert.equal(result.month, '09');
});

test('Backup ID: disambiguator does not overwrite the original id format', () => {
  assert.equal(withBackupIdDisambiguator('bkp_20260914_020000', 42), 'bkp_20260914_020000_r42');
});

test('Connection Parsing: extracts parameters without exposing passwords in process args', () => {
  const url = 'postgres://admin_user:SuperSecretPassword123%21@db.example.internal:5432/schoolims_prod?sslmode=require';
  const params = parseConnectionParams(url);

  assert.equal(params.user, 'admin_user');
  assert.equal(params.password, 'SuperSecretPassword123!');
  assert.equal(params.host, 'db.example.internal');
  assert.equal(params.port, '5432');
  assert.equal(params.database, 'schoolims_prod');
});

test('Config: rejects Supabase transaction pooler URLs for pg_dump', () => {
  assert.throws(
    () => assertDirectDatabaseUrl('postgresql://user:pass@db.pooler.supabase.com:6543/postgres'),
    /DATABASE_URL_DIRECT/
  );
  assert.doesNotThrow(() =>
    assertDirectDatabaseUrl('postgresql://user:pass@db.pooler.supabase.com:5432/postgres')
  );
});

test('Encryption key: hex, base64, and passphrase all produce 32-byte keys', () => {
  const hex = crypto.randomBytes(32).toString('hex');
  assert.equal(resolveEncryptionKey(hex).length, 32);
  const b64 = crypto.randomBytes(32).toString('base64');
  assert.equal(resolveEncryptionKey(b64).length, 32);
  assert.equal(resolveEncryptionKey('passphrase-not-a-raw-key').length, 32);
});

test('Encryption & Decryption: AES-256-GCM roundtrip preserves exact binary content', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  const originalFile = path.join(tmpDir, 'source.bin');
  const encryptedFile = path.join(tmpDir, 'source.bin.enc');
  const decryptedFile = path.join(tmpDir, 'restored.bin');

  const key = crypto.randomBytes(32);
  const sampleData = Buffer.from('PGDMP-test-sample-database-payload-bytes-'.repeat(100));
  fs.writeFileSync(originalFile, sampleData);

  try {
    const encResult = await encryptFile(originalFile, encryptedFile, key);
    assert.ok(encResult.fileSizeBytes > sampleData.length);
    assert.ok(encResult.iv);
    assert.ok(encResult.tag);

    const decResult = await decryptFile(encryptedFile, decryptedFile, key);
    assert.equal(decResult.restoredSizeBytes, sampleData.length);

    const restoredData = fs.readFileSync(decryptedFile);
    assert.ok(restoredData.equals(sampleData));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Encryption: Tampered ciphertext or wrong key fails with authentication error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-tamper-'));
  const originalFile = path.join(tmpDir, 'source.bin');
  const encryptedFile = path.join(tmpDir, 'source.bin.enc');
  const decryptedFile = path.join(tmpDir, 'restored.bin');

  const key = crypto.randomBytes(32);
  const wrongKey = crypto.randomBytes(32);
  fs.writeFileSync(originalFile, Buffer.from('Sensitive database table records'));

  try {
    await encryptFile(originalFile, encryptedFile, key);

    await assert.rejects(
      async () => {
        await decryptFile(encryptedFile, decryptedFile, wrongKey);
      },
      /Unsupported state or unable to authenticate data|Invalid archive/
    );

    const encBytes = fs.readFileSync(encryptedFile);
    encBytes[30] = encBytes[30] ^ 0xff;
    fs.writeFileSync(encryptedFile, encBytes);

    await assert.rejects(
      async () => {
        await decryptFile(encryptedFile, decryptedFile, key);
      },
      /Unsupported state or unable to authenticate data/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Encryption failure: rejects non-32-byte keys', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-badkey-'));
  const originalFile = path.join(tmpDir, 'source.bin');
  const encryptedFile = path.join(tmpDir, 'source.bin.enc');
  fs.writeFileSync(originalFile, Buffer.from('payload'));
  try {
    await assert.rejects(
      () => encryptFile(originalFile, encryptedFile, Buffer.from('too-short')),
      /32-byte Buffer/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Checksum: SHA-256 and MD5 calculation matches crypto standard', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-hash-'));
  const sampleFile = path.join(tmpDir, 'hash_test.txt');
  const payload = Buffer.from('SchoolIMS-Database-Backup-Payload-2026');
  fs.writeFileSync(sampleFile, payload);

  try {
    const fileHash = await calculateFileSha256(sampleFile);
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
    assert.equal(fileHash, expectedHash);
    assert.equal(calculateBufferSha256(payload), expectedHash);

    const md5 = await calculateFileMd5Base64(sampleFile);
    const expectedMd5 = crypto.createHash('md5').update(payload).digest('base64');
    assert.equal(md5, expectedMd5);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Manifest: Sanitizes all secrets, passwords, and tokens', () => {
  const manifest = buildBackupManifest({
    backupId: 'bkp_20260914_020000',
    startedAt: '2026-09-14T02:00:00Z',
    completedAt: '2026-09-14T02:02:30Z',
    backupType: 'daily',
    filePath: 'gs://schoolims-backups/database/daily/2026/09/sample.dump.enc',
    fileSizeBytes: 1048576,
    sha256: 'abc123sha256checksum',
    postgresVersion: 'PostgreSQL 17.6',
  });

  assert.equal(manifest.backup_id, 'bkp_20260914_020000');
  assert.equal(manifest.status, 'success');
  assert.equal(manifest.file_size_bytes, 1048576);
  assert.equal(manifest.backup_method, 'pg_dump');

  const dirtyObject = {
    backup_id: 'bkp_test',
    database_url: 'postgres://user:pass@host/db',
    password: 'SuperSecretPassword',
    api_token: 'secret_token_123',
    nested: {
      secret_key: 'my-key',
      safe_field: 'public_value',
    },
  };
  const cleaned = sanitizeManifest(dirtyObject);

  assert.equal(cleaned.database_url, undefined);
  assert.equal(cleaned.password, undefined);
  assert.equal(cleaned.api_token, undefined);
  assert.equal(cleaned.nested.secret_key, undefined);
  assert.equal(cleaned.nested.safe_field, 'public_value');
});

test('Anomaly Detection: Detects significant size changes without failing backup', () => {
  const recentBackups = [
    { file_size_bytes: 1000000 },
    { file_size_bytes: 1020000 },
    { file_size_bytes: 980000 },
  ];

  const normal = checkBackupSizeAnomaly({
    currentSizeBytes: 1020000,
    recentBackups,
    thresholdPercent: 25,
  });
  assert.equal(normal.isAnomaly, false);
  assert.equal(normal.deviationPercent, 2);

  const dropAnomaly = checkBackupSizeAnomaly({
    currentSizeBytes: 600000,
    recentBackups,
    thresholdPercent: 25,
  });
  assert.equal(dropAnomaly.isAnomaly, true);
  assert.equal(dropAnomaly.deviationPercent, 40);
  assert.match(dropAnomaly.message, /WARNING: Backup size changed significantly/);

  const spikeAnomaly = checkBackupSizeAnomaly({
    currentSizeBytes: 1500000,
    recentBackups,
    thresholdPercent: 25,
  });
  assert.equal(spikeAnomaly.isAnomaly, true);
  assert.equal(spikeAnomaly.deviationPercent, 50);

  const customThreshold = checkBackupSizeAnomaly({
    currentSizeBytes: 800000,
    recentBackups,
    thresholdPercent: 50,
  });
  assert.equal(customThreshold.isAnomaly, false);
});

test('Stale backup: flags missing and overdue successful backups', () => {
  const none = isBackupStale(null, 26);
  assert.equal(none.stale, true);

  const fresh = isBackupStale(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), 26);
  assert.equal(fresh.stale, false);

  const overdue = isBackupStale(new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(), 26);
  assert.equal(overdue.stale, true);
  assert.match(overdue.message, /No successful backup for/);
});

test('Format Bytes: converts raw bytes to readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1048576), '1.00 MB');
  assert.equal(formatBytes(1073741824), '1.00 GB');
});

test('GCS dry-run: two-phase upload, verification, and overwrite protection', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-gcs-'));
  const localFile = path.join(tmpDir, 'archive.dump.enc');
  fs.writeFileSync(localFile, Buffer.from('encrypted-archive-bytes'));
  const sha256 = await calculateFileSha256(localFile);
  const storage = new GcsStorageService({
    bucketName: '',
    isDryRun: true,
    localBackupDir: path.join(tmpDir, 'gcs'),
  });

  try {
    const destination = 'database/daily/2026/09/schoolims-db-2026-09-14-020000.dump.enc';
    const uploaded = await storage.uploadBackupArchive({
      localFilePath: localFile,
      destinationPath: destination,
      backupId: 'bkp_20260914_020000',
      sha256,
    });
    assert.match(uploaded.storagePath, /local-dry-run/);

    const verified = await storage.verifyObject(destination, uploaded.sizeBytes, sha256);
    assert.equal(verified.verified, true);

    const mismatch = await storage.verifyObject(destination, uploaded.sizeBytes + 1, sha256);
    assert.equal(mismatch.verified, false);

    await assert.rejects(
      () => storage.uploadBackupArchive({
        localFilePath: localFile,
        destinationPath: destination,
        backupId: 'bkp_20260914_020000',
        sha256,
      }),
      /IDEMPOTENCY_CONFLICT/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GCS verification failure: missing object is not marked verified', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-gcs-missing-'));
  const storage = new GcsStorageService({
    bucketName: '',
    isDryRun: true,
    localBackupDir: tmpDir,
  });
  try {
    const result = await storage.verifyObject('database/daily/missing.dump.enc', 10, 'abc');
    assert.equal(result.verified, false);
    assert.equal(result.reason, 'object_missing');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SchoolIMS public API does not expose a backup endpoint', () => {
  const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal(/backup/i.test(serverSrc), false);
});
