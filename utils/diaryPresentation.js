import { publicStructuredFields } from '../services/smartDiary/composeContent.js';
import { isSchoolDiaryImageUrl } from './diaryStoragePath.js';
import config from '../config/env.js';

const STAFF_DIARY_ROLES = new Set(['staff', 'teacher', 'principal']);

/**
 * The released staff diary screen prefers `*_te` whenever those fields are
 * present, even when the teacher authored the entry in English. Staff reads
 * therefore expose only the canonical English fields; parent/student reads
 * keep both languages so their UI can localize normally.
 */
function isStaffReader(roles = []) {
  return roles.some((role) => STAFF_DIARY_ROLES.has(role));
}

export function filterFamilyDiaryAttachments(entries, roles = [], schoolId, supabaseUrl = config.supabase.url) {
  if (!Array.isArray(entries)) return entries;
  if (!roles.includes('student') && !roles.includes('parent')) return entries;
  if (roles.some((role) => STAFF_DIARY_ROLES.has(role) || role === 'admin')) return entries;
  return entries.map((entry) => {
    if (entry.attachments == null) return entry;
    let attachments = entry.attachments;
    if (typeof attachments === 'string') {
      try { attachments = JSON.parse(attachments); } catch { attachments = [attachments]; }
    }
    return {
      ...entry,
      attachments: (Array.isArray(attachments) ? attachments : [])
        .filter((item) => isSchoolDiaryImageUrl(
          typeof item === 'string' ? item : item?.url,
          schoolId,
          supabaseUrl,
        )),
    };
  });
}

function presentOne(entry, staffReader) {
  if (!entry || typeof entry !== 'object') return entry;
  const metadata = entry.processing_metadata;
  const structured = publicStructuredFields(metadata);
  const presented = { ...entry };
  if (structured) presented.structured = structured;
  if (!staffReader) {
    delete presented.processing_metadata;
    delete presented.ocr_status;
    delete presented.ai_status;
    delete presented.original_text;
  } else {
    const { title_te: _titleTe, content_te: _contentTe, ...rest } = presented;
    return rest;
  }
  return presented;
}

export function presentDiaryEntriesForReader(entries, roles = [], schoolId) {
  if (!Array.isArray(entries)) return entries;
  const staffReader = isStaffReader(roles);
  return filterFamilyDiaryAttachments(entries.map((entry) => presentOne(entry, staffReader)), roles, schoolId);
}

export function presentDiaryEntryForReader(entry, roles = [], schoolId) {
  if (!entry) return entry;
  const [presented] = presentDiaryEntriesForReader([entry], roles, schoolId);
  return presented;
}
