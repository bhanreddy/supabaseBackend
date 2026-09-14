/**
 * SchoolIMS — OMR Analytics Service
 * Real-time item analysis, difficulty indicators, option distribution, and class performance metrics.
 */

import sql from '../../db.js';

/**
 * Computes deep psychometric item analysis for an OMR exam.
 */
export async function getOmrExamAnalytics(schoolId, omrExamId) {
  // 1. Fetch exam details and answer key
  const [omrExam] = await sql`
    SELECT oe.id, oe.title, oe.status, es.max_marks, es.passing_marks,
           s.name as subject_name, c.name as class_name, e.name as exam_name
    FROM omr_exams oe
    JOIN exam_subjects es ON es.id = oe.exam_subject_id AND es.school_id = ${schoolId}
    JOIN subjects s ON s.id = es.subject_id
    JOIN classes c ON c.id = es.class_id
    JOIN exams e ON e.id = es.exam_id AND e.school_id = ${schoolId}
    WHERE oe.id = ${omrExamId} AND oe.school_id = ${schoolId}
    LIMIT 1
  `;

  if (!omrExam) {
    throw new Error('OMR Exam not found');
  }

  // 2. Fetch all scans for this exam
  const scans = await sql`
    SELECT id, total_score, max_possible_score, percentage, status, correct_count, wrong_count, blank_count
    FROM omr_scans
    WHERE omr_exam_id = ${omrExamId} AND school_id = ${schoolId}
      AND status IN ('PROCESSED', 'VERIFIED', 'FINALIZED')
  `;

  const totalSheets = scans.length;
  if (totalSheets === 0) {
    return {
      exam: omrExam,
      totalSheets: 0,
      summary: null,
      questionAnalytics: []
    };
  }

  // 3. Summary score statistics
  const scores = scans.map((s) => Number(s.total_score)).sort((a, b) => a - b);
  const sumScores = scores.reduce((acc, v) => acc + v, 0);
  const meanScore = Number((sumScores / totalSheets).toFixed(2));
  const minScore = scores[0];
  const maxScore = scores[scores.length - 1];
  const medianScore = scores[Math.floor(scores.length / 2)];

  const passingMarks = Number(omrExam.passing_marks) || 35;
  const passingCount = scans.filter((s) => Number(s.total_score) >= passingMarks).length;
  const passPercentage = Number(((passingCount / totalSheets) * 100).toFixed(1));

  // Score distribution buckets: [0-35, 36-50, 51-70, 71-85, 86-100]
  const scoreBuckets = {
    '0-35%': 0,
    '36-50%': 0,
    '51-70%': 0,
    '71-85%': 0,
    '86-100%': 0
  };

  scans.forEach((s) => {
    const pct = Number(s.percentage) || 0;
    if (pct <= 35) scoreBuckets['0-35%']++;
    else if (pct <= 50) scoreBuckets['36-50%']++;
    else if (pct <= 70) scoreBuckets['51-70%']++;
    else if (pct <= 85) scoreBuckets['71-85%']++;
    else scoreBuckets['86-100%']++;
  });

  // 4. Per-Question Option Distribution & Difficulty Index
  const answers = await sql`
    SELECT sa.question_number, sa.detected_option, sa.manual_override_option,
           sa.is_correct, sa.is_blank, sa.is_multiple, sa.confidence
    FROM omr_scan_answers sa
    JOIN omr_scans s ON s.id = sa.scan_id
    WHERE s.omr_exam_id = ${omrExamId} AND s.school_id = ${schoolId}
      AND s.status IN ('PROCESSED', 'VERIFIED', 'FINALIZED')
    ORDER BY sa.question_number ASC
  `;

  // Group by question_number
  const questionGroups = new Map();
  answers.forEach((ans) => {
    const qNum = ans.question_number;
    if (!questionGroups.has(qNum)) {
      questionGroups.set(qNum, []);
    }
    questionGroups.get(qNum).push(ans);
  });

  const questionAnalytics = [];
  questionGroups.forEach((qAnswers, qNum) => {
    const totalResp = qAnswers.length;
    let correct = 0;
    let blank = 0;
    let multiple = 0;
    const optionCounts = { A: 0, B: 0, C: 0, D: 0, E: 0 };

    qAnswers.forEach((a) => {
      const opt = a.manual_override_option || a.detected_option;
      if (a.is_correct) correct++;
      if (a.is_blank || opt === 'BLANK') blank++;
      if (a.is_multiple || opt === 'MULTIPLE') multiple++;
      if (optionCounts[opt] != null) {
        optionCounts[opt]++;
      }
    });

    const correctPct = Number(((correct / (totalResp || 1)) * 100).toFixed(1));
    const blankPct = Number(((blank / (totalResp || 1)) * 100).toFixed(1));
    const multiplePct = Number(((multiple / (totalResp || 1)) * 100).toFixed(1));

    // Empirical difficulty indicator: Easy (>75% correct), Moderate (45-75%), Challenging (<45%)
    let difficulty = 'Moderate';
    if (correctPct > 75) difficulty = 'Easy';
    else if (correctPct < 45) difficulty = 'Challenging';

    const distribution = {};
    Object.keys(optionCounts).forEach((k) => {
      distribution[k] = {
        count: optionCounts[k],
        percentage: Number(((optionCounts[k] / (totalResp || 1)) * 100).toFixed(1))
      };
    });

    questionAnalytics.push({
      questionNumber: qNum,
      totalResponses: totalResp,
      correctCount: correct,
      correctPercentage: correctPct,
      blankPercentage: blankPct,
      multiplePercentage: multiplePct,
      difficulty,
      optionDistribution: distribution
    });
  });

  return {
    exam: omrExam,
    totalSheets,
    summary: {
      meanScore,
      minScore,
      maxScore,
      medianScore,
      passPercentage,
      scoreBuckets
    },
    questionAnalytics
  };
}
