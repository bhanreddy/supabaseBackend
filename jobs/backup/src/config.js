import 'dotenv/config';
import crypto from 'node:crypto';

const optional = (key, fallback = undefined) => {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return typeof value === 'string' ? value.trim() : value;
};

/**
 * Normalizes encryption key to 32 bytes (AES-256).
 * Accepts 64-char hex, 44-char base64, or any passphrase (SHA-256 derived).
 * @param {string} rawKey
 * @returns {Buffer}
 */
export const resolveEncryptionKey = (rawKey) => {
  if (!rawKey) {
    throw new Error('[SECURITY_ERROR] BACKUP_ENCRYPTION_KEY must be provided');
  }
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }
  if (/^[A-Za-z0-9+/=]{44}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'base64');
  }
  return crypto.createHash('sha256').update(rawKey).digest();
};

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('[CONFIG_ERROR] Neither DATABASE_URL_DIRECT nor DATABASE_URL is configured');
  }
  return databaseUrl.trim();
}

/**
 * pg_dump cannot run through the Supabase transaction pooler (port 6543).
 * @param {string} databaseUrl
 */
export function assertDirectDatabaseUrl(databaseUrl) {
  if (/pooler\.supabase\.com:6543/i.test(databaseUrl) || /[?&]pgbouncer=true/i.test(databaseUrl)) {
    throw new Error(
      '[CONFIG_ERROR] pg_dump requires DATABASE_URL_DIRECT (session/direct Postgres). ' +
        'The transaction pooler on port 6543 is not supported.'
    );
  }
}

export const config = {
  nodeEnv: optional('NODE_ENV', 'production'),
  get isProduction() {
    return this.nodeEnv === 'production';
  },
  projectId: optional('GCP_PROJECT_ID') || optional('GOOGLE_CLOUD_PROJECT'),
  get databaseUrl() {
    return requireDatabaseUrl();
  },
  gcsBucket: optional('GCS_BACKUP_BUCKET', ''),
  gcsPrefix: optional('GCS_BACKUP_PREFIX', 'database/'),
  gcsManifestPrefix: optional('GCS_MANIFEST_PREFIX', 'manifests/'),
  rawEncryptionKey: optional('BACKUP_ENCRYPTION_KEY', ''),
  get encryptionKey() {
    return resolveEncryptionKey(this.rawEncryptionKey);
  },
  backupType: (optional('BACKUP_TYPE', 'daily') || 'daily').toLowerCase(),
  anomalyThresholdPercent: Number(optional('ANOMALY_THRESHOLD_PERCENT', '25')),
  staleBackupHours: Number(optional('STALE_BACKUP_HOURS', '26')),
  localBackupDir: optional('LOCAL_BACKUP_DIR', '/tmp/schoolims-backups'),
  alertWebhookUrl: optional('ALERT_WEBHOOK_URL', ''),
  pgDumpPath: optional('PG_DUMP_PATH', 'pg_dump'),
  pgRestorePath: optional('PG_RESTORE_PATH', 'pg_restore'),
  dryRun: optional('BACKUP_DRY_RUN', 'false') === 'true',
};

Object.freeze(config);
export default config;
