import sql from '../../db.js';
import logger from '../../utils/logger.js';
import { supabaseRemovePaths } from '../../utils/diaryAttachmentStorage.js';
import { diaryStoragePathFromUrl } from '../../utils/diaryStoragePath.js';
import { DIARY_PHOTO_RETENTION_DAYS, DIARY_RETENTION_DAYS } from '../../utils/diaryRetention.js';

export { diaryStoragePathFromUrl };

function attachmentUrls(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && /^https?:\/\//i.test(item));
  }
  if (typeof value === 'string') {
    try {
      return attachmentUrls(JSON.parse(value));
    } catch {
      return /^https?:\/\//i.test(value) ? [value] : [];
    }
  }
  return [];
}

export async function recordDiaryPhotoHistory({
  schoolId,
  diaryEntryId,
  classSectionId,
  subjectId,
  createdBy,
  entryDate,
  attachments,
}) {
  const urls = attachmentUrls(attachments);
  if (!schoolId || urls.length === 0) return { recorded: 0 };

  let recorded = 0;
  for (const imageUrl of urls) {
    const storagePath = diaryStoragePathFromUrl(imageUrl);
    try {
      await sql`
        INSERT INTO diary_photo_history (
          school_id, diary_entry_id, class_section_id, subject_id, created_by,
          entry_date, image_url, storage_path, expires_at
        ) VALUES (
          ${schoolId}, ${diaryEntryId || null}, ${classSectionId || null}, ${subjectId || null},
          ${createdBy || null}, ${entryDate}, ${imageUrl}, ${storagePath},
          now() + (${DIARY_PHOTO_RETENTION_DAYS} * INTERVAL '1 day')
        )
        ON CONFLICT (school_id, image_url) DO NOTHING
      `;
      recorded += 1;
    } catch (error) {
      logger.warn({ err: error, event: 'diary_photo_history_record_failed' }, 'Could not record diary photo history');
    }
  }
  return { recorded };
}

export async function purgeTextDiaryOlderThanRetention(schoolId) {
  if (!schoolId) return { deleted: 0 };
  const offset = DIARY_RETENTION_DAYS - 1;
  const rows = await sql`
    DELETE FROM diary_entries
    WHERE school_id = ${schoolId}
      AND entry_date < (CURRENT_DATE - (${offset} * INTERVAL '1 day'))
      AND (attachments IS NULL OR attachments = '[]'::jsonb)
      AND COALESCE(entry_source, 'MANUAL') NOT IN ('PHOTO', 'CLASS_DIARY_AI')
    RETURNING id
  `;
  return { deleted: rows.length };
}

export async function purgeExpiredDiaryPhotos({ schoolId = null, limit = 200 } = {}) {
  const expired = schoolId
    ? await sql`
        SELECT id, school_id, image_url, storage_path, diary_entry_id
        FROM diary_photo_history
        WHERE school_id = ${schoolId}
          AND expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT ${limit}
      `
    : await sql`
        SELECT id, school_id, image_url, storage_path, diary_entry_id
        FROM diary_photo_history
        WHERE expires_at <= now()
        ORDER BY expires_at ASC
        LIMIT ${limit}
      `;

  const paths = [...new Set(expired.map((row) => row.storage_path || diaryStoragePathFromUrl(row.image_url)).filter(Boolean))];
  if (paths.length) {
    try {
      await supabaseRemovePaths(paths);
    } catch (error) {
      logger.warn({ err: error, event: 'diary_photo_storage_purge_failed', count: paths.length }, 'Could not delete expired diary photos from storage');
    }
  }

  if (expired.length) {
    const ids = expired.map((row) => row.id);
    await sql`DELETE FROM diary_photo_history WHERE id = ANY(${ids})`;
  }

  const photoOffset = DIARY_PHOTO_RETENTION_DAYS - 1;
  const photoRows = schoolId
    ? await sql`
        DELETE FROM diary_entries
        WHERE school_id = ${schoolId}
          AND entry_date < (CURRENT_DATE - (${photoOffset} * INTERVAL '1 day'))
          AND (
            (attachments IS NOT NULL AND attachments <> '[]'::jsonb)
            OR COALESCE(entry_source, 'MANUAL') IN ('PHOTO', 'CLASS_DIARY_AI')
          )
        RETURNING id
      `
    : await sql`
        DELETE FROM diary_entries
        WHERE entry_date < (CURRENT_DATE - (${photoOffset} * INTERVAL '1 day'))
          AND (
            (attachments IS NOT NULL AND attachments <> '[]'::jsonb)
            OR COALESCE(entry_source, 'MANUAL') IN ('PHOTO', 'CLASS_DIARY_AI')
          )
        RETURNING id
      `;

  return { historyDeleted: expired.length, filesRemoved: paths.length, photoEntriesDeleted: photoRows.length };
}
