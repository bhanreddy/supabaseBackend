export const DIARY_ATTACHMENTS_BUCKET = 'diary-attachments';

export function diaryStoragePathFromUrl(url, bucket = DIARY_ATTACHMENTS_BUCKET) {
  const text = String(url || '');
  const marker = `/object/public/${bucket}/`;
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  try {
    return decodeURIComponent(text.slice(idx + marker.length).split('?')[0]);
  } catch {
    return text.slice(idx + marker.length).split('?')[0];
  }
}
