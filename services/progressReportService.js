import { hasSavedMark } from './marksTotalsService.js';

/**
 * A progress report must contain only subjects for which a mark row was saved.
 * A saved zero score and a saved absence are both real results and must remain.
 * The predicate lives in marksTotalsService so filtering and totalling agree.
 */
export function filterEnteredProgressReportSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  return subjects.filter(hasSavedMark);
}
