// Earlier posts are collected by the daily digest. Posts published at or after
// this cutoff alert families immediately, independently of the server timezone.
export const DAILY_DIARY_DIGEST_SCHEDULE = Object.freeze({
  cutoffHour: 16,
  cutoffMinute: 30,
  cron: '30 16 * * *',
  timezone: 'Asia/Kolkata',
});

const diaryClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: DAILY_DIARY_DIGEST_SCHEDULE.timezone,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function isAfterDiaryNotificationCutoff(now = new Date()) {
  const parts = diaryClock.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour').value);
  const minute = Number(parts.find((part) => part.type === 'minute').value);
  return hour * 60 + minute >= DAILY_DIARY_DIGEST_SCHEDULE.cutoffHour * 60
    + DAILY_DIARY_DIGEST_SCHEDULE.cutoffMinute;
}
