import { Storage } from '@google-cloud/storage';
import fs from 'node:fs';
import path from 'node:path';
import { calculateFileMd5Base64, calculateFileSha256 } from './checksumService.js';

/**
 * Service to manage secure uploads, verification, and downloads in Google Cloud Storage.
 */
export class GcsStorageService {
  /**
   * @param {Object} options
   * @param {string} options.bucketName
   * @param {string} [options.projectId]
   * @param {boolean} [options.isDryRun=false]
   * @param {string} [options.localBackupDir]
   */
  constructor({ bucketName, projectId, isDryRun = false, localBackupDir = '/tmp/schoolims-backups' }) {
    this.bucketName = bucketName;
    this.projectId = projectId;
    this.isDryRun = isDryRun || !bucketName;
    this.localBackupDir = localBackupDir;

    if (!this.isDryRun) {
      this.storage = new Storage({ projectId: this.projectId });
      this.bucket = this.storage.bucket(this.bucketName);
    }
  }

  /**
   * Checks if an object already exists in GCS.
   * @param {string} destinationPath
   * @returns {Promise<boolean>}
   */
  async exists(destinationPath) {
    if (this.isDryRun) {
      const localPath = path.join(this.localBackupDir, destinationPath);
      return fs.existsSync(localPath);
    }

    const file = this.bucket.file(destinationPath);
    const [exists] = await file.exists();
    return exists;
  }

  /**
   * Two-phase atomic upload:
   * 1. Check destination doesn't already exist.
   * 2. Upload to temporary object (.tmp).
   * 3. Verify temporary object size and GCS-computed MD5.
   * 4. Copy temporary object to destination.
   * 5. Delete staging object.
   *
   * @param {Object} params
   * @param {string} params.localFilePath
   * @param {string} params.destinationPath
   * @param {string} params.backupId
   * @param {string} params.sha256
   * @returns {Promise<{ storagePath: string, sizeBytes: number, md5Hash: string|null }>}
   */
  async uploadBackupArchive({ localFilePath, destinationPath, backupId, sha256 }) {
    const stats = fs.statSync(localFilePath);
    const localSize = stats.size;
    const localMd5 = await calculateFileMd5Base64(localFilePath);

    if (await this.exists(destinationPath)) {
      throw new Error(
        `[IDEMPOTENCY_CONFLICT] Object already exists at ${destinationPath}. Overwriting is strictly prevented.`
      );
    }

    if (this.isDryRun) {
      const targetLocal = path.join(this.localBackupDir, destinationPath);
      fs.mkdirSync(path.dirname(targetLocal), { recursive: true });
      fs.copyFileSync(localFilePath, targetLocal);
      return {
        storagePath: `gs://local-dry-run/${destinationPath}`,
        sizeBytes: localSize,
        md5Hash: localMd5,
      };
    }

    const stagingPath = `${destinationPath}.tmp.${Date.now()}`;
    const stagingFile = this.bucket.file(stagingPath);

    try {
      await this.bucket.upload(localFilePath, {
        destination: stagingPath,
        resumable: localSize > 50 * 1024 * 1024,
        metadata: {
          contentType: 'application/octet-stream',
          md5Hash: localMd5,
          metadata: {
            backupId,
            sha256,
            originalSize: String(localSize),
            md5: localMd5,
          },
        },
      });

      const [stagingMeta] = await stagingFile.getMetadata();
      const uploadedSize = Number(stagingMeta.size);
      if (uploadedSize !== localSize) {
        throw new Error(
          `Upload verification failed: size mismatch (local: ${localSize} bytes, remote: ${uploadedSize} bytes)`
        );
      }

      const remoteMd5 = stagingMeta.md5Hash || stagingMeta.metadata?.md5;
      if (remoteMd5 && remoteMd5 !== localMd5) {
        throw new Error(
          `Upload verification failed: MD5 mismatch (local: ${localMd5}, remote: ${remoteMd5})`
        );
      }

      const destinationFile = this.bucket.file(destinationPath);
      await stagingFile.copy(destinationFile);

      const [finalMeta] = await destinationFile.getMetadata();
      if (Number(finalMeta.size) !== localSize) {
        throw new Error(`Finalized object verification failed for ${destinationPath}`);
      }

      return {
        storagePath: `gs://${this.bucketName}/${destinationPath}`,
        sizeBytes: Number(finalMeta.size),
        md5Hash: finalMeta.md5Hash || localMd5,
      };
    } finally {
      try {
        await stagingFile.delete({ ignoreNotFound: true });
      } catch (_) {
        // Staging cleanup is best-effort; failed jobs must not leave the process hanging.
      }
    }
  }

  /**
   * Uploads manifest JSON file to GCS.
   * @param {Object} manifest
   * @param {string} destinationPath
   * @returns {Promise<string>}
   */
  async uploadManifest(manifest, destinationPath) {
    const content = JSON.stringify(manifest, null, 2);

    if (this.isDryRun) {
      const localPath = path.join(this.localBackupDir, destinationPath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      fs.writeFileSync(localPath, content, 'utf8');
      return `gs://local-dry-run/${destinationPath}`;
    }

    const file = this.bucket.file(destinationPath);
    await file.save(content, {
      contentType: 'application/json',
      metadata: {
        cacheControl: 'no-cache, max-age=0',
      },
    });

    return `gs://${this.bucketName}/${destinationPath}`;
  }

  /**
   * Verifies an uploaded object against expected size, SHA-256, and MD5.
   * Dry-run recomputes hashes from the local copy. Live GCS uses independently
   * computed object MD5 plus custom SHA-256 metadata written at upload time.
   *
   * @param {string} destinationPath
   * @param {number} expectedSizeBytes
   * @param {string} expectedSha256
   * @param {string} [expectedMd5]
   * @returns {Promise<{ verified: boolean, sizeBytes: number, reason?: string }>}
   */
  async verifyObject(destinationPath, expectedSizeBytes, expectedSha256, expectedMd5) {
    if (this.isDryRun) {
      const localPath = path.join(this.localBackupDir, destinationPath);
      if (!fs.existsSync(localPath)) return { verified: false, sizeBytes: 0, reason: 'object_missing' };
      const stats = fs.statSync(localPath);
      const actualSha = await calculateFileSha256(localPath);
      const sizeMatches = stats.size === expectedSizeBytes;
      const shaMatches = actualSha.toLowerCase() === String(expectedSha256 || '').toLowerCase();
      return {
        verified: sizeMatches && shaMatches,
        sizeBytes: stats.size,
        reason: sizeMatches && shaMatches ? undefined : 'checksum_or_size_mismatch',
      };
    }

    const file = this.bucket.file(destinationPath);
    const [exists] = await file.exists();
    if (!exists) {
      return { verified: false, sizeBytes: 0, reason: 'object_missing' };
    }

    const [metadata] = await file.getMetadata();
    const actualSize = Number(metadata.size);
    const sizeMatches = actualSize === expectedSizeBytes;
    const customSha = metadata.metadata?.sha256;
    const sha256Matches = customSha
      ? customSha.toLowerCase() === String(expectedSha256 || '').toLowerCase()
      : false;
    const remoteMd5 = metadata.md5Hash || metadata.metadata?.md5;
    const md5Matches = expectedMd5 && remoteMd5 ? remoteMd5 === expectedMd5 : true;

    const verified = sizeMatches && sha256Matches && md5Matches;
    let reason;
    if (!verified) {
      if (!sizeMatches) reason = 'size_mismatch';
      else if (!sha256Matches) reason = 'sha256_mismatch';
      else reason = 'md5_mismatch';
    }

    return {
      verified,
      sizeBytes: actualSize,
      reason,
    };
  }

  /**
   * Downloads a backup file from GCS to local disk for restore validation.
   * @param {string} sourcePath GCS relative path
   * @param {string} localDestinationPath
   * @returns {Promise<string>}
   */
  async downloadFile(sourcePath, localDestinationPath) {
    if (this.isDryRun) {
      const localSource = path.join(this.localBackupDir, sourcePath);
      if (!fs.existsSync(localSource)) {
        throw new Error(`File not found in local backup dir: ${sourcePath}`);
      }
      fs.copyFileSync(localSource, localDestinationPath);
      return localDestinationPath;
    }

    const file = this.bucket.file(sourcePath);
    await file.download({ destination: localDestinationPath });
    return localDestinationPath;
  }
}
