/**
 * Rank teachers who have already passed the hard availability checks.
 *
 * Hard constraints (free in the period, active account, not absent, no other
 * substitution) live in the route query. This function only orders eligible
 * teachers using explainable signals so admins can trust the recommendation.
 */
export function rankSubstitutionCandidates(candidates = []) {
  return candidates
    .map((candidate) => {
      const subjectMatch = Boolean(candidate.subject_match);
      const classFamiliarity = Boolean(candidate.class_familiarity);
      const isClassTeacher = Boolean(candidate.is_class_teacher);
      const dailyLoad = Number(candidate.daily_load || 0);
      const adjacentLoad = Number(candidate.adjacent_load || 0);
      const recentCovers = Number(candidate.recent_substitution_count || 0);
      const attendanceStatus = candidate.attendance_status || null;

      let score = 72;
      if (subjectMatch) score += 24;
      if (classFamiliarity) score += 10;
      if (isClassTeacher) score += 8;
      if (attendanceStatus === 'present') score += 4;
      if (attendanceStatus === 'half_day') score -= 10;
      score -= Math.min(dailyLoad * 3, 18);
      score -= Math.min(adjacentLoad * 6, 12);
      score -= Math.min(recentCovers * 8, 32);
      score = Math.max(1, Math.min(99, Math.round(score)));

      const reasons = [];
      if (subjectMatch) reasons.push(`Teaches ${candidate.subject_name}`);
      if (isClassTeacher) reasons.push('Class teacher');
      else if (classFamiliarity) reasons.push('Already teaches this class');
      if (adjacentLoad === 0) reasons.push('Free before and after');
      if (dailyLoad <= 2) reasons.push(`Light day · ${dailyLoad} class${dailyLoad === 1 ? '' : 'es'}`);
      if (recentCovers === 0) reasons.push('No recent cover duties');
      if (reasons.length === 0) reasons.push('Available this period');

      return {
        ...candidate,
        daily_load: dailyLoad,
        adjacent_load: adjacentLoad,
        recent_substitution_count: recentCovers,
        score,
        recommendation:
          score >= 85 ? 'Best match' : score >= 70 ? 'Great fit' : 'Available',
        reasons: reasons.slice(0, 3),
      };
    })
    .sort((a, b) =>
      b.score - a.score ||
      a.recent_substitution_count - b.recent_substitution_count ||
      a.daily_load - b.daily_load ||
      String(a.teacher_name || '').localeCompare(String(b.teacher_name || ''))
    );
}
