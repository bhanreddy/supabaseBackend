export const DIARY_ATTACHMENTS_BUCKET = 'diary-attachments';

/** Accept only this project's uploaded image paths when a client publishes a diary. */
export function isSchoolDiaryImageUrl(url, schoolId, supabaseUrl) {
  if (typeof url !== 'string' || !schoolId || !supabaseUrl) return false;
  try {
    const parsed = new URL(url);
    const origin = new URL(supabaseUrl);
    if (parsed.origin !== origin.origin || parsed.username || parsed.password || parsed.hash) return false;
    const prefix = `/storage/v1/object/public/${DIARY_ATTACHMENTS_BUCKET}/`;
    if (!parsed.pathname.startsWith(prefix)) return false;
    const path = decodeURIComponent(parsed.pathname.slice(prefix.length));
    const parts = path.split('/');
    return parts.length === 3
      && parts[0] === String(schoolId)
      && (parts[1] === 'photos' || parts[1] === 'class-diary')
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|webp)$/i.test(parts[2]);
  } catch {
    return false;
  }
}

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
