const STAFF_DIARY_ROLES = new Set(['staff', 'teacher', 'principal']);

/**
 * The released staff diary screen prefers `*_te` whenever those fields are
 * present, even when the teacher authored the entry in English. Staff reads
 * therefore expose only the canonical English fields; parent/student reads
 * keep both languages so their UI can localize normally.
 */
export function presentDiaryEntriesForReader(entries, roles = []) {
  if (!Array.isArray(entries)) return entries;
  if (!roles.some((role) => STAFF_DIARY_ROLES.has(role))) return entries;

  return entries.map(({ title_te: _titleTe, content_te: _contentTe, ...entry }) => entry);
}

export function presentDiaryEntryForReader(entry, roles = []) {
  if (!entry) return entry;
  const [presented] = presentDiaryEntriesForReader([entry], roles);
  return presented;
}
