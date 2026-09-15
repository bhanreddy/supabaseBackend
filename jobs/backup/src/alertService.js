import baseLogger from './logger.js';

export const AlertSeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
};

export const AlertCondition = {
  BACKUP_FAILED: 'BACKUP_FAILED',
  VERIFICATION_FAILED: 'BACKUP_VERIFICATION_FAILED',
  NO_RECENT_BACKUP: 'NO_RECENT_BACKUP_26H',
  SIZE_ANOMALY: 'BACKUP_SIZE_ANOMALY',
  GCS_UPLOAD_FAILED: 'GCS_UPLOAD_FAILED',
  ENCRYPTION_FAILED: 'ENCRYPTION_FAILED',
};

export class AlertService {
  /**
   * @param {Object} [options]
   * @param {string} [options.webhookUrl]
   * @param {Object} [options.logger]
   */
  constructor(options = {}) {
    this.webhookUrl = options.webhookUrl || process.env.ALERT_WEBHOOK_URL || '';
    this.logger = options.logger || baseLogger;
  }

  /**
   * Dispatches an alert through structured logs and optional webhook.
   *
   * @param {Object} params
   * @param {string} params.condition Value from AlertCondition
   * @param {string} params.severity Value from AlertSeverity
   * @param {string} params.backupId
   * @param {string} params.message
   * @param {Object} [params.metadata={}]
   * @returns {Promise<boolean>}
   */
  async triggerAlert({ condition, severity, backupId, message, metadata = {} }) {
    const payload = {
      alert: true,
      condition,
      severity,
      backup_id: backupId,
      message,
      timestamp: new Date().toISOString(),
      metadata,
    };

    if (severity === AlertSeverity.CRITICAL) {
      this.logger.error({ event: 'ALERT_TRIGGERED', ...payload }, message);
    } else {
      this.logger.warn({ event: 'ALERT_TRIGGERED', ...payload }, message);
    }

    if (this.webhookUrl) {
      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000), // 5-second timeout
        });
        if (!response.ok) {
          this.logger.warn(
            { event: 'ALERT_WEBHOOK_ERROR', status: response.status },
            `Alert webhook returned HTTP ${response.status}`
          );
        }
      } catch (err) {
        this.logger.warn(
          { event: 'ALERT_WEBHOOK_FAILED', error: err.message },
          `Failed to dispatch alert webhook: ${err.message}`
        );
      }
    }

    return true;
  }
}

export default new AlertService();
