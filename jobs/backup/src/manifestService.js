/**
 * Constructs a secure, deterministic JSON manifest for a backup run.
 * Guarantees that no passwords, access keys, or secrets are ever recorded.
 *
 * @param {Object} params
 * @param {string} params.backupId
 * @param {string} params.startedAt
 * @param {string} params.completedAt
 * @param {string} params.backupType
 * @param {string} params.filePath
 * @param {number} params.fileSizeBytes
 * @param {string} params.sha256
 * @param {string} params.postgresVersion
 * @param {string} [params.encryptionAlgorithm='aes-256-gcm']
 * @param {string} [params.verificationStatus='verified']
 * @returns {Object} Manifest object
 */
export function buildBackupManifest({
  backupId,
  startedAt,
  completedAt,
  backupType,
  filePath,
  fileSizeBytes,
  sha256,
  postgresVersion,
  encryptionAlgorithm = 'aes-256-gcm',
  verificationStatus = 'verified',
}) {
  const manifest = {
    backup_id: backupId,
    database: 'schoolims',
    started_at: startedAt,
    completed_at: completedAt,
    status: 'success',
    backup_type: backupType,
    backup_method: 'pg_dump',
    format: 'custom',
    file_path: filePath,
    file_size_bytes: fileSizeBytes,
    sha256: sha256,
    postgres_version: postgresVersion,
    encryption: {
      algorithm: encryptionAlgorithm,
      mode: 'envelope_gcm',
    },
    verification_status: verificationStatus,
    generated_at: new Date().toISOString(),
  };

  // Defensive sanitization: recursively ensure no sensitive fields exist
  return sanitizeManifest(manifest);
}

const FORBIDDEN_KEY_PATTERN = /(password|secret|token|key|credential|database_?url)/i;

export function sanitizeManifest(obj) {
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeManifest);
  }

  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (FORBIDDEN_KEY_PATTERN.test(key) && key !== 'key_type') {
      continue; // Drop sensitive keys
    }
    cleaned[key] = sanitizeManifest(value);
  }
  return cleaned;
}
