import postgres from 'postgres';

export class MetadataService {
  /**
   * @param {string} databaseUrl
   */
  constructor(databaseUrl) {
    this.sql = postgres(databaseUrl, {
      max: 2,
      ssl: { rejectUnauthorized: false },
      connect_timeout: 15,
      idle_timeout: 20,
    });
  }

  /**
   * Closes database connection pool.
   */
  async close() {
    await this.sql.end({ timeout: 5 });
  }

  /**
   * Finds an existing job by backup_id.
   * @param {string} backupId
   * @returns {Promise<Object|null>}
   */
  async getJobByBackupId(backupId) {
    const rows = await this.sql`
      SELECT * FROM public.backup_jobs
      WHERE backup_id = ${backupId}
      LIMIT 1
    `;
    return rows[0] || null;
  }

  /**
   * Inserts an initial job record with status 'in_progress'.
   *
   * @param {Object} params
   * @param {string} params.backupId
   * @param {string} params.backupType
   * @param {string} params.databaseVersion
   * @param {Object} [params.metadata={}]
   * @returns {Promise<Object>} Created job row
   */
  async createJob({ backupId, backupType, databaseVersion, metadata = {} }) {
    const rows = await this.sql`
      INSERT INTO public.backup_jobs (
        backup_id,
        backup_type,
        status,
        started_at,
        database_version,
        verification_status,
        metadata
      ) VALUES (
        ${backupId},
        ${backupType},
        'in_progress',
        now(),
        ${databaseVersion},
        'unverified',
        ${this.sql.json(metadata)}
      )
      RETURNING *
    `;
    return rows[0];
  }

  /**
   * Records an audit event for a backup job.
   *
   * @param {Object} params
   * @param {string} params.backupJobId
   * @param {string} params.eventType
   * @param {string} params.message
   * @param {Object} [params.metadata={}]
   * @returns {Promise<Object>} Created event row
   */
  async recordEvent({ backupJobId, eventType, message = '', metadata = {} }) {
    const rows = await this.sql`
      INSERT INTO public.backup_events (
        backup_job_id,
        event_type,
        message,
        metadata
      ) VALUES (
        ${backupJobId},
        ${eventType},
        ${message},
        ${this.sql.json(metadata)}
      )
      RETURNING *
    `;
    return rows[0];
  }

  /**
   * Updates an existing backup job record with final status and metrics.
   *
   * @param {Object} params
   * @param {string} params.backupJobId
   * @param {string} params.status
   * @param {number} [params.durationSeconds]
   * @param {number} [params.fileSizeBytes]
   * @param {string} [params.storagePath]
   * @param {string} [params.checksumSha256]
   * @param {string} [params.verificationStatus]
   * @param {Date} [params.verifiedAt]
   * @param {string} [params.errorMessage]
   * @param {Object} [params.metadata]
   * @returns {Promise<Object>}
   */
  async updateJob({
    backupJobId,
    status,
    durationSeconds = null,
    fileSizeBytes = null,
    storagePath = null,
    checksumSha256 = null,
    verificationStatus = null,
    verifiedAt = null,
    errorMessage = null,
    metadata = null,
  }) {
    const rows = await this.sql`
      UPDATE public.backup_jobs
      SET
        status = ${status},
        completed_at = now(),
        duration_seconds = COALESCE(${durationSeconds}, duration_seconds),
        file_size_bytes = COALESCE(${fileSizeBytes}, file_size_bytes),
        storage_path = COALESCE(${storagePath}, storage_path),
        checksum_sha256 = COALESCE(${checksumSha256}, checksum_sha256),
        verification_status = COALESCE(${verificationStatus}, verification_status),
        verified_at = COALESCE(${verifiedAt}, verified_at),
        error_message = ${errorMessage},
        metadata = CASE 
          WHEN ${metadata ? this.sql.json(metadata) : null}::jsonb IS NOT NULL 
          THEN metadata || ${metadata ? this.sql.json(metadata) : null}::jsonb
          ELSE metadata
        END
      WHERE id = ${backupJobId}
      RETURNING *
    `;
    return rows[0];
  }

  /**
   * Fetches recent successful backup jobs for anomaly detection.
   * @param {number} [limit=5]
   * @returns {Promise<Array<Object>>}
   */
  async getRecentSuccessfulBackups(limit = 5) {
    return this.sql`
      SELECT id, backup_id, file_size_bytes, duration_seconds, created_at
      FROM public.backup_jobs
      WHERE status = 'success' AND file_size_bytes IS NOT NULL AND file_size_bytes > 0
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Returns the most recent successful backup, if any.
   * @returns {Promise<Object|null>}
   */
  async getLastSuccessfulBackup() {
    const rows = await this.sql`
      SELECT id, backup_id, completed_at, file_size_bytes, duration_seconds
      FROM public.backup_jobs
      WHERE status = 'success'
      ORDER BY completed_at DESC NULLS LAST
      LIMIT 1
    `;
    return rows[0] || null;
  }

  /**
   * Marks abandoned in_progress jobs as failed so retries can proceed cleanly.
   * @param {number} [maxAgeMinutes=120]
   * @returns {Promise<Array<{backup_id: string}>>}
   */
  async markStaleInProgressJobs(maxAgeMinutes = 120) {
    return this.sql`
      UPDATE public.backup_jobs
      SET
        status = 'failed',
        completed_at = now(),
        verification_status = 'failed',
        error_message = 'Marked failed: job was still in_progress after timeout (likely interrupted)'
      WHERE status = 'in_progress'
        AND started_at < now() - make_interval(mins => ${maxAgeMinutes})
      RETURNING backup_id
    `;
  }
}
