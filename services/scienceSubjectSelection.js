// EVS and general Science are alternatives. Physics, Biology and Social are
// separate subjects and must not be collapsed by this rule.
export const PREFERRED_SCIENCE_SUBJECT = 'science';

export function scienceAlternativeKind(name) {
  const normalized = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (['evs', 'environmentalstudies', 'environmentstudies', 'environmentalscience'].includes(normalized)) return 'evs';
  if (['science', 'generalscience', 'sci'].includes(normalized)) return 'science';
  return null;
}

export function hasScienceAlternatives(rows = []) {
  const kinds = new Set(rows.map((row) => scienceAlternativeKind(row.subject_name)));
  return kinds.has('evs') && kinds.has('science');
}

/** Higher availability wins; the preferred subject resolves equally entered alternatives. */
export function selectScienceAlternative(rows = [], availability = () => 0) {
  if (!hasScienceAlternatives(rows)) return rows;
  const quality = { evs: 0, science: 0 };
  for (const row of rows) {
    const kind = scienceAlternativeKind(row.subject_name);
    if (kind) quality[kind] = Math.max(quality[kind], availability(row));
  }
  const chosen = quality.evs === quality.science ? PREFERRED_SCIENCE_SUBJECT
    : quality.evs > quality.science ? 'evs' : 'science';
  return rows.filter((row) => !scienceAlternativeKind(row.subject_name)
    || scienceAlternativeKind(row.subject_name) === chosen);
}

export function scienceAlternativeNote(papers) {
  return hasScienceAlternatives(papers)
    ? `EVS/Science: only one counts in totals; use the entered subject, or ${PREFERRED_SCIENCE_SUBJECT === 'evs' ? 'EVS' : 'Science'} when both have marks.`
    : '';
}
