/**
 * Recommendation engine.
 *
 * Suggestions only. Never auto-executes discipline, parent communication,
 * or any high-impact student decision.
 */
const RULE_RECOMMENDATIONS = Object.freeze({
  BEHAVIOUR_RECURRENCE_001: [
    'Teacher review of recent classroom context',
    'Follow-up observation during the next two weeks',
    'Optional parent communication if the pattern continues',
  ],
  ACADEMIC_DECLINE_001: [
    'Teacher review of recent assessment scripts',
    'Additional practice on the weakest recent topics',
    'Follow-up observation after the next assessment',
  ],
  POSITIVE_LEADERSHIP_001: [
    'Acknowledge the student in class',
    'Offer a peer-support or group-lead opportunity',
    'Record a follow-up observation if the strength continues',
  ],
  ATTENDANCE_DROP_001: [
    'Teacher review of recent absence notes and leave records',
    'Share missed classwork for the days away',
    'Optional parent communication if the drop continues',
  ],
  ACADEMIC_GROWTH_001: [
    'Acknowledge the sustained improvement',
    'Offer a stretch activity to maintain momentum',
  ],
  CROSS_MODULE_CONCERN_001: [
    'Joint staff review of the signals that occurred together',
    'Teacher mentoring check-in over a four-week window',
    'Follow-up observation after the review period',
  ],
  HOMEWORK_CONCERN_001: [
    'Teacher review of recent homework observations',
    'Additional practice with a short follow-up date',
    'Follow-up observation after two weeks',
  ],
});

const DEFAULT_RECOMMENDATIONS = Object.freeze([
  'Teacher review',
  'Follow-up observation',
]);

export function recommendationsForRule(ruleCode) {
  return [...(RULE_RECOMMENDATIONS[ruleCode] || DEFAULT_RECOMMENDATIONS)];
}

export function buildRecommendations({ rule, signals = [] } = {}) {
  const recs = recommendationsForRule(rule?.rule_code);
  const modules = Array.from(new Set((signals || []).map((s) => s.source_module).filter(Boolean)));
  if (modules.length >= 2 && !recs.some((item) => item.toLowerCase().includes('occurred together') || item.toLowerCase().includes('joint'))) {
    recs.push('Review the signals that occurred together before choosing an action');
  }
  return recs;
}
