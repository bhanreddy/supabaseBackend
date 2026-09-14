export const DIARY_RETENTION_DAYS = 15;
export const DIARY_PHOTO_RETENTION_DAYS = 30;

export function diaryRetentionOffsetDays(days = DIARY_RETENTION_DAYS) {
  return Math.max(days - 1, 0);
}
