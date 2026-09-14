import { publicStructuredFields } from '../services/smartDiary/composeContent.js';

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

export function presentDiaryEntriesForReader(entries, roles = []) {
  if (!Array.isArray(entries)) return entries;
  const staffReader = isStaffReader(roles);
  return entries.map((entry) => presentOne(entry, staffReader));
}

export function presentDiaryEntryForReader(entry, roles = []) {
  if (!entry) return entry;
  const [presented] = presentDiaryEntriesForReader([entry], roles);
  return presented;
}
