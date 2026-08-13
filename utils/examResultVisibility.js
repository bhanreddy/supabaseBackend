export const RESULT_PUBLICATION_GATED_EXAM_TYPES = Object.freeze([
  'fa_results',
  'sa_results',
]);

export function isResultPublicationGated(examType) {
  return RESULT_PUBLICATION_GATED_EXAM_TYPES.includes(
    String(examType || '').trim().toLowerCase(),
  );
}

export function isResultVisibleToFamilies({ examType, resultsPublished }) {
  return !isResultPublicationGated(examType) || resultsPublished === true;
}
