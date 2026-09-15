import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'password',
      'secret',
      'key',
      'encryptionKey',
      'databaseUrl',
      'connectionString',
      'DATABASE_URL',
      'DATABASE_URL_DIRECT',
      'BACKUP_ENCRYPTION_KEY',
      'PGPASSWORD',
      'BACKUP_TRIGGER_SA_JSON',
    ],
    remove: true,
  },
  base: {
    service: 'schoolims-db-backup',
    env: process.env.NODE_ENV || 'production',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const createBackupLogger = (backupId) => {
  return {
    info: (event, metadata = {}) => {
      baseLogger.info({ event, backup_id: backupId, ...metadata });
    },
    warn: (event, metadata = {}) => {
      baseLogger.warn({ event, backup_id: backupId, ...metadata });
    },
    error: (event, metadata = {}) => {
      baseLogger.error({ event, backup_id: backupId, ...metadata });
    },
  };
};

export default baseLogger;
