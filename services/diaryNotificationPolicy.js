// Uploads only publish diary content. Automatic family alerts are sent by the
// daily digest worker at this fixed time, independently of the server timezone.
export const DAILY_DIARY_DIGEST_SCHEDULE = Object.freeze({
  cutoffHour: 17,
  cutoffMinute: 30,
  cron: '30 17 * * *',
  timezone: 'Asia/Kolkata',
});
