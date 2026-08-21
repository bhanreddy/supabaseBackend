const round = (value) => Number(Number(value).toFixed(2));

const GRADE_BANDS = [
  { minimum: 91, grade: 'A1', gpa: 10 },
  { minimum: 81, grade: 'B1', gpa: 9 },
  { minimum: 71, grade: 'B2', gpa: 8 },
  { minimum: 61, grade: 'C1', gpa: 7 },
  { minimum: 51, grade: 'C2', gpa: 6 },
  { minimum: 41, grade: 'D1', gpa: 5 },
  { minimum: 0, grade: 'D2', gpa: 4 },
];

export function gradeForFinalPercentage(percentage) {
  const normalized = Math.max(0, Math.min(100, Number(percentage) || 0));
  return GRADE_BANDS.find((band) => normalized >= band.minimum) || GRADE_BANDS.at(-1);
}

/** Converts any source maximum to its contribution in the target weight. */
export function weightedContribution(assessment, targetWeight) {
  if (!assessment || assessment.status === 'missing') return null;
  if (assessment.status === 'absent') return 0;
  const score = Number(assessment.score);
  const maximum = Number(assessment.maximum);
  if (!Number.isFinite(score) || !Number.isFinite(maximum) || maximum <= 0) return null;
  return round((score / maximum) * targetWeight);
}

const averageComplete = (values) => values.some((value) => value == null)
  ? null
  : round(values.reduce((total, value) => total + value, 0) / values.length);

const calculatedResult = (firstContribution, secondContribution, missingSources) => {
  const complete = firstContribution != null && secondContribution != null;
  const total = complete ? round(firstContribution + secondContribution) : null;
  const band = complete ? gradeForFinalPercentage(total) : null;
  return {
    first_contribution: firstContribution,
    second_contribution: secondContribution,
    total,
    percentage: total,
    grade: band?.grade ?? null,
    gpa: band?.gpa ?? null,
    status: complete ? 'complete' : 'incomplete',
    missing_sources: missingSources,
  };
};

/** SA-1 = average(FA-1, FA-2) /20 + SA-1 exam /80. */
export function calculateSummativeOne(sources) {
  const fa1 = weightedContribution(sources.fa1, 20);
  const fa2 = weightedContribution(sources.fa2, 20);
  const formative = averageComplete([fa1, fa2]);
  const exam = weightedContribution(sources.sa1, 80);
  return {
    ...calculatedResult(
      formative,
      exam,
      [fa1 == null ? 'FA-1' : null, fa2 == null ? 'FA-2' : null, exam == null ? 'SA-1' : null].filter(Boolean),
    ),
    formative_contribution: formative,
    exam_contribution: exam,
  };
}

/** SA-2 = average(FA-3, FA-4) /20 + SA-2 exam /80. */
export function calculateSummativeTwo(sources) {
  const fa3 = weightedContribution(sources.fa3, 20);
  const fa4 = weightedContribution(sources.fa4, 20);
  const formative = averageComplete([fa3, fa4]);
  const exam = weightedContribution(sources.sa2, 80);
  return {
    ...calculatedResult(
      formative,
      exam,
      [fa3 == null ? 'FA-3' : null, fa4 == null ? 'FA-4' : null, exam == null ? 'SA-2' : null].filter(Boolean),
    ),
    formative_contribution: formative,
    exam_contribution: exam,
  };
}

/** Annual = average(FA-1…FA-4) /20 + average(SA-1, SA-2) /80. */
export function calculateAnnualResult(sources) {
  const formativeValues = ['fa1', 'fa2', 'fa3', 'fa4'].map((key) =>
    weightedContribution(sources[key], 20),
  );
  const summativeValues = ['sa1', 'sa2'].map((key) =>
    weightedContribution(sources[key], 80),
  );
  const formative = averageComplete(formativeValues);
  const summative = averageComplete(summativeValues);
  const sourceNames = ['FA-1', 'FA-2', 'FA-3', 'FA-4', 'SA-1', 'SA-2'];
  const allValues = [...formativeValues, ...summativeValues];
  return {
    ...calculatedResult(
      formative,
      summative,
      sourceNames.filter((_, index) => allValues[index] == null),
    ),
    formative_contribution: formative,
    summative_contribution: summative,
  };
}

export function calculateFinalSubjectResult(sources) {
  return {
    summative_1: calculateSummativeOne(sources),
    summative_2: calculateSummativeTwo(sources),
    annual: calculateAnnualResult(sources),
  };
}

export function summarizeCalculatedSubjects(subjects, period) {
  const results = subjects.map((subject) => subject[period]);
  const complete = results.length > 0 && results.every((result) => result.status === 'complete');
  const totalObtained = complete
    ? round(results.reduce((total, result) => total + result.total, 0))
    : null;
  const totalMax = results.length * 100;
  const percentage = complete && totalMax > 0
    ? round((totalObtained / totalMax) * 100)
    : null;
  const band = percentage == null ? null : gradeForFinalPercentage(percentage);
  return {
    status: complete ? 'complete' : 'incomplete',
    total_obtained: totalObtained,
    total_max: totalMax,
    percentage,
    grade: band?.grade ?? null,
    gpa: band?.gpa ?? null,
    completed_subjects: results.filter((result) => result.status === 'complete').length,
    subject_count: results.length,
    missing_sources: [...new Set(results.flatMap((result) => result.missing_sources))],
  };
}

const romanNumber = (value) => {
  const normalized = value.toUpperCase();
  if (/\bIV\b/.test(normalized)) return 4;
  if (/\bIII\b/.test(normalized)) return 3;
  if (/\bII\b/.test(normalized)) return 2;
  if (/\bI\b/.test(normalized)) return 1;
  return null;
};

/** Maps canonical and human-readable exam names to fa1…fa4 / sa1…sa2. */
export function canonicalFinalSourceKey(examType, examName) {
  const type = String(examType || '').toLowerCase();
  const name = String(examName || '').trim();
  const numericMatches = [...name.matchAll(/(?:^|\D)([1-4])(?=\D|$)/g)];
  const numeric = numericMatches.at(-1)?.[1];
  const index = numeric ? Number(numeric) : romanNumber(name);
  if (type === 'fa_results' && index >= 1 && index <= 4) return `fa${index}`;
  if (type === 'sa_results' && index >= 1 && index <= 2) return `sa${index}`;
  return null;
}
