/**
 * Diary clients have used two sync markers over time:
 * - legacy builds send `updated_since`
 * - current builds also send `is_sync=true`
 *
 * Either marker means the caller needs an authoritative class snapshot. Diary
 * history is deliberately small (15 days), so a full snapshot is safer than a
 * timestamp delta: it repairs clock skew and a cleared/corrupt local cache.
 */
export function isDiarySyncRequest({
  classSectionId,
  updatedSince,
  isSync,
}) {
  if (!classSectionId) return false;

  const normalizedSyncFlag = String(isSync ?? '').trim().toLowerCase();
  return (
    updatedSince !== undefined
    || normalizedSyncFlag === 'true'
    || normalizedSyncFlag === '1'
  );
}
