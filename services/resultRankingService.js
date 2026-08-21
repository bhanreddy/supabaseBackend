export const RESULT_RANKING_METHODS = Object.freeze({
  COMPETITION: 'competition',
  ATTENDANCE_TIEBREAK: 'attendance_tiebreak',
  DENSE: 'dense',
});

const VALID_METHODS = new Set(Object.values(RESULT_RANKING_METHODS));

export function normalizeResultRankingMethod(value) {
  return VALID_METHODS.has(value) ? value : RESULT_RANKING_METHODS.COMPETITION;
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Returns a sorted copy with ranks. Competition is the default: 1,1,1,4.
 * Attendance mode sorts equal academic scores by attendance percentage first.
 * Dense mode keeps rank numbers consecutive: 1,1,1,2.
 */
export function rankResultRows(rows, method = RESULT_RANKING_METHODS.COMPETITION) {
  const normalizedMethod = normalizeResultRankingMethod(method);
  const sorted = [...rows].sort((a, b) => {
    const scoreDifference = finiteNumber(b.percentage) - finiteNumber(a.percentage);
    if (scoreDifference !== 0) return scoreDifference;
    if (normalizedMethod === RESULT_RANKING_METHODS.ATTENDANCE_TIEBREAK) {
      const attendanceDifference = finiteNumber(b.attendance_percentage, -1)
        - finiteNumber(a.attendance_percentage, -1);
      if (attendanceDifference !== 0) return attendanceDifference;
    }
    return String(a.admission_no || a.student_id).localeCompare(
      String(b.admission_no || b.student_id),
      undefined,
      { numeric: true },
    );
  });

  let priorTieKey;
  let priorRank = 0;
  let denseRank = 0;

  return sorted.map((row, index) => {
    const tieKey = normalizedMethod === RESULT_RANKING_METHODS.ATTENDANCE_TIEBREAK
      ? `${finiteNumber(row.percentage)}:${finiteNumber(row.attendance_percentage, -1)}`
      : String(finiteNumber(row.percentage));

    if (priorTieKey === undefined || tieKey !== priorTieKey) {
      denseRank += 1;
      priorRank = normalizedMethod === RESULT_RANKING_METHODS.DENSE ? denseRank : index + 1;
      priorTieKey = tieKey;
    }

    return { ...row, rank: priorRank };
  });
}
