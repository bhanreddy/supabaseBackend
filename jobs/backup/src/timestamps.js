/**
 * Deterministic backup ID and object-path timestamps.
 * Isolated from config so unit tests do not require DATABASE_URL.
 *
 * @param {Date} [date=new Date()]
 * @returns {{ backupId: string, dateStr: string, year: string, month: string }}
 */
export function formatBackupTimestamps(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const YYYY = date.getUTCFullYear();
  const MM = pad(date.getUTCMonth() + 1);
  const DD = pad(date.getUTCDate());
  const HH = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());

  return {
    backupId: `bkp_${YYYY}${MM}${DD}_${HH}${mm}${ss}`,
    dateStr: `${YYYY}-${MM}-${DD}-${HH}${mm}${ss}`,
    year: String(YYYY),
    month: MM,
  };
}

/**
 * Appends a disambiguator when a backup_id collision is detected on retry.
 * @param {string} backupId
 * @param {string|number} disambiguator
 */
export function withBackupIdDisambiguator(backupId, disambiguator) {
  return `${backupId}_r${disambiguator}`;
}
