/**
 * A progress report must contain only subjects for which a mark row was saved.
 * A saved zero score and a saved absence are both real results and must remain.
 */
export function filterEnteredProgressReportSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];

  return subjects.filter((subject) =>
    subject?.hasMarks === true
    || subject?.has_marks === true
    || subject?.mark_id != null
  );
}
