/**
 * Future AI assistance layer for the Content Engine.
 * Assistive only — never auto-publishes school content.
 */
export const CONTENT_AI_CAPABILITIES = Object.freeze({
  HEADLINE_SUGGESTION: 'HEADLINE_SUGGESTION',
  SUMMARY_GENERATION: 'SUMMARY_GENERATION',
  TRANSLATION: 'TRANSLATION',
  GRAMMAR_CORRECTION: 'GRAMMAR_CORRECTION',
  CATEGORY_CLASSIFICATION: 'CATEGORY_CLASSIFICATION',
  DUPLICATE_DETECTION: 'DUPLICATE_DETECTION',
  QUALITY_CHECK: 'QUALITY_CHECK',
});

export async function suggestContentAssist(_capability, _payload = {}) {
  return {
    enabled: false,
    suggestions: [],
    requiresApproval: true,
  };
}
