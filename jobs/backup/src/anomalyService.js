/**
 * Compares current backup size against recent successful backups.
 * If deviation exceeds the configured threshold percentage, returns an anomaly warning.
 *
 * NOTE: An anomaly is a non-fatal warning requiring investigation, not an automatic failure.
 *
 * @param {Object} params
 * @param {number} params.currentSizeBytes
 * @param {Array<{ file_size_bytes: number|string }>} params.recentBackups
 * @param {number} [params.thresholdPercent=25]
 * @returns {{ isAnomaly: boolean, message: string, averageSizeBytes: number|null, deviationPercent: number }}
 */
export function checkBackupSizeAnomaly({
  currentSizeBytes,
  recentBackups = [],
  thresholdPercent = 25,
}) {
  if (!recentBackups || recentBackups.length === 0) {
    return {
      isAnomaly: false,
      message: 'No previous successful backups available for baseline comparison',
      averageSizeBytes: null,
      deviationPercent: 0,
    };
  }

  const validSizes = recentBackups
    .map((b) => Number(b.file_size_bytes))
    .filter((s) => Number.isFinite(s) && s > 0);

  if (validSizes.length === 0) {
    return {
      isAnomaly: false,
      message: 'No valid previous backup sizes found for comparison',
      averageSizeBytes: null,
      deviationPercent: 0,
    };
  }

  const sum = validSizes.reduce((acc, s) => acc + s, 0);
  const averageSizeBytes = Math.round(sum / validSizes.length);

  const diffBytes = currentSizeBytes - averageSizeBytes;
  const deviationPercent = Math.round((Math.abs(diffBytes) / averageSizeBytes) * 100);

  const isAnomaly = deviationPercent >= thresholdPercent;
  const direction = diffBytes >= 0 ? 'increased' : 'decreased';

  let message = `Backup size ${direction} by ${deviationPercent}% (current: ${formatBytes(currentSizeBytes)}, baseline avg: ${formatBytes(averageSizeBytes)})`;
  if (isAnomaly) {
    message = `WARNING: Backup size changed significantly: ${message} (threshold: ${thresholdPercent}%)`;
  }

  return {
    isAnomaly,
    message,
    averageSizeBytes,
    deviationPercent,
  };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Determines whether the last successful backup is older than the allowed window.
 * Used by Founder Console and the worker health check. Does not fail a backup run.
 *
 * @param {string|Date|null} lastSuccessCompletedAt
 * @param {number} [maxAgeHours=26]
 * @returns {{ stale: boolean, ageHours: number|null, message: string }}
 */
export function isBackupStale(lastSuccessCompletedAt, maxAgeHours = 26) {
  if (!lastSuccessCompletedAt) {
    return {
      stale: true,
      ageHours: null,
      message: 'No successful backup recorded',
    };
  }

  const completedMs = new Date(lastSuccessCompletedAt).getTime();
  if (!Number.isFinite(completedMs)) {
    return {
      stale: true,
      ageHours: null,
      message: 'Last successful backup timestamp is invalid',
    };
  }

  const ageHours = Math.round(((Date.now() - completedMs) / (1000 * 60 * 60)) * 10) / 10;
  const stale = ageHours > maxAgeHours;
  return {
    stale,
    ageHours,
    message: stale
      ? `WARNING: No successful backup for ${ageHours} hours (threshold: ${maxAgeHours}h)`
      : `Last successful backup was ${ageHours} hours ago`,
  };
}
