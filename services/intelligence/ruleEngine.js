import sql from '../../db.js';
import { buildRecommendations } from './recommendationEngine.js';

/**
 * Loads all active intelligence rules for a school (combining system rules and tenant rules).
 */
export async function getActiveRules({ schoolId }) {
  return sql`
    SELECT
      id, school_id, rule_code, name, description,
      category, conditions, threshold, severity, version
    FROM public.intelligence_rules
    WHERE (school_id IS NULL OR school_id = ${schoolId})
      AND enabled = true
    ORDER BY rule_code ASC
  `;
}

/**
 * Evaluates signals and observations against configured intelligence rules.
 *
 * @param {object} params
 * @param {number} params.schoolId
 * @param {string} params.studentId
 * @param {Array} params.signals - Generated signals from signalEngine
 * @returns {Promise<Array>} List of matched rule evaluations
 */
export async function evaluateRules({ schoolId, studentId, signals = [] }) {
  const rules = await getActiveRules({ schoolId });
  const matches = [];

  for (const rule of rules) {
    const code = rule.rule_code;
    let isMatched = false;
    let supportingSignals = [];
    let matchDetails = {};

    switch (code) {
      case 'BEHAVIOUR_RECURRENCE_001': {
        const minCount = Number(rule.conditions?.min_count || rule.threshold?.count || 3);
        const matchingSig = signals.find((s) => s.signal_type === 'BEHAVIOUR_CONCERN');
        if (matchingSig && (matchingSig.value_numeric >= minCount || matchingSig.metadata?.count >= minCount)) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'RECURRENCE',
            title: 'Recurring Behaviour Concern Pattern',
            summary: `${minCount} or more behaviour concerns recorded within the last ${rule.conditions?.window_days || 21} days.`,
            confidence: 'HIGH',
            recommendations: buildRecommendations({ rule, signals: [matchingSig] }),
          };
        }
        break;
      }

      case 'ACADEMIC_DECLINE_001': {
        const matchingSig = signals.find((s) => s.signal_type === 'ACADEMIC_DECLINE');
        if (matchingSig) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'CONSECUTIVE_CHANGE',
            title: 'Consecutive Assessment Score Decline',
            summary: matchingSig.metadata?.note || 'Assessment scores have declined across 3 consecutive evaluations.',
            confidence: matchingSig.confidence || 'HIGH',
            recommendations: buildRecommendations({ rule, signals: [matchingSig] }),
          };
        }
        break;
      }

      case 'POSITIVE_LEADERSHIP_001': {
        const minCount = Number(rule.conditions?.min_count || rule.threshold?.count || 3);
        const matchingSig = signals.find((s) => s.signal_type === 'LEADERSHIP_POSITIVE');
        if (matchingSig && (matchingSig.value_numeric >= minCount || matchingSig.metadata?.count >= minCount)) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'POSITIVE_GROWTH',
            title: 'Emerging Leadership & Peer Collaboration Strength',
            summary: matchingSig.metadata?.note || 'Student demonstrated recurring peer support and leadership initiative.',
            confidence: matchingSig.confidence || 'HIGH',
            recommendations: buildRecommendations({ rule, signals: [matchingSig] }),
          };
        }
        break;
      }

      case 'ATTENDANCE_DROP_001': {
        const matchingSig = signals.find((s) => s.signal_type === 'ATTENDANCE_DROP');
        if (matchingSig) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'TREND',
            title: 'Attendance Deviation from Historical Baseline',
            summary: matchingSig.metadata?.note || 'Student attendance has experienced a noticeable drop over the last 14 days.',
            confidence: matchingSig.confidence || 'MODERATE',
            recommendations: buildRecommendations({ rule, signals: [matchingSig] }),
          };
        }
        break;
      }

      case 'ACADEMIC_GROWTH_001': {
        const matchingSig = signals.find((s) => s.signal_type === 'ACADEMIC_IMPROVEMENT');
        if (matchingSig) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'POSITIVE_GROWTH',
            title: 'Positive Academic Acceleration',
            summary: matchingSig.metadata?.note || 'Student marks show consistent growth across consecutive exams.',
            confidence: 'HIGH',
            recommendations: buildRecommendations({ rule, signals: [matchingSig] }),
          };
        }
        break;
      }

      case 'CROSS_MODULE_CONCERN_001': {
        const matchingSig = signals.find((s) => s.signal_type === 'CROSS_MODULE_CORRELATION');
        if (matchingSig) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'CROSS_MODULE_CONVERGENCE',
            title: 'Emerging Multi-Domain Attention Signal',
            summary: 'These signals occurred together across attendance, homework, and assessment results over the last 30 days.',
            confidence: 'HIGH',
            recommendations: buildRecommendations({ rule, signals }),
          };
        }
        break;
      }

      case 'HOMEWORK_CONCERN_001': {
        const minCount = Number(rule.conditions?.min_count || rule.threshold?.count || 2);
        const matchingSig = signals.find((s) => s.signal_type === 'HOMEWORK_INCOMPLETE');
        if (matchingSig && (matchingSig.value_numeric >= minCount || matchingSig.metadata?.count >= minCount)) {
          isMatched = true;
          supportingSignals = [matchingSig.id];
          matchDetails = {
            pattern_type: 'RECURRENCE',
            title: 'Repeated Homework Completion Concern',
            summary: matchingSig.metadata?.note || 'Multiple homework concerns were recorded in the recent window.',
            confidence: matchingSig.confidence || 'MODERATE',
            recommendations: buildRecommendations({ rule, signals: [matchingSig] }),
          };
        }
        break;
      }

      default:
        break;
    }

    if (isMatched) {
      matches.push({
        rule,
        supportingSignals,
        ...matchDetails,
      });
    }
  }

  return matches;
}
