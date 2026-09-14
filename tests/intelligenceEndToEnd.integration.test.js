import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import sql from '../db.js';
import { evaluateStudentIntelligence, getStudentInsights } from '../services/intelligence/insightEngine.js';
import { createIntervention, recordInterventionOutcome, getInterventions } from '../services/intelligence/interventionService.js';
import { getSchoolIntelligenceOverview } from '../services/intelligence/schoolIntelligenceService.js';

let testSchoolId;
let testStudentId;
let testUserId;

test.before(async () => {
  const [school] = await sql`SELECT id FROM public.schools LIMIT 1`;
  testSchoolId = school ? school.id : 1;

  const [student] = await sql`
    SELECT id FROM public.students
    WHERE school_id = ${testSchoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  testStudentId = student ? student.id : randomUUID();

  const [user] = await sql`
    SELECT id FROM public.users
    WHERE school_id = ${testSchoolId}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  testUserId = user ? user.id : randomUUID();
});

test.after(async () => {
  await sql.end({ timeout: 1 }).catch(() => {});
});

test('Intelligence End-to-End: Evaluation, explanation, intervention, and outcome tracking', async () => {
  // 1. Evaluate Student Intelligence
  const evaluation = await evaluateStudentIntelligence({
    schoolId: testSchoolId,
    studentId: testStudentId,
  });

  assert.ok(evaluation.profileTier, 'Must assign a status tier');
  assert.ok(['STABLE', 'WATCH', 'ATTENTION', 'GROWTH'].includes(evaluation.profileTier));
  assert.ok(evaluation.baseline, 'Must calculate personal baseline');

  // 2. Fetch Explainable Insights with "Why?" details
  const insights = await getStudentInsights({
    schoolId: testSchoolId,
    studentId: testStudentId,
    userRoles: ['teacher'],
  });

  // Verify that any generated insight has explainability fields
  for (const insight of insights) {
    assert.ok(insight.title);
    assert.ok(insight.summary);
    assert.ok(insight.confidence);
    assert.ok(Array.isArray(insight.bullet_points), 'bullet_points must be an array');
    assert.ok(insight.baseline_comparison, 'baseline_comparison must exist');
  }

  // 3. Create an Intervention from Recommendation
  const intervention = await createIntervention({
    schoolId: testSchoolId,
    userId: testUserId,
    payload: {
      student_id: testStudentId,
      action_type: 'TEACHER_REVIEW',
      title: 'Targeted Mathematics Review & Homework Check',
      description: 'Weekly 15-minute review session to address algebra concept gaps',
      start_date: '2026-09-14',
      target_date: '2026-10-14',
      follow_up_date: '2026-09-21',
      baseline_metric: { homework_completion: 52, math_score: 60 },
    },
  });

  assert.ok(intervention.id);
  assert.equal(intervention.status, 'IN_PROGRESS');

  // 4. Record Intervention Outcome (Before vs After)
  const recorded = await recordInterventionOutcome({
    schoolId: testSchoolId,
    interventionId: intervention.id,
    userId: testUserId,
    outcomeStatus: 'EFFECTIVE',
    outcomeNotes: 'Significant improvement observed following 4-week mentoring. Homework completion increased to 85%.',
    afterMetric: { homework_completion: 85, math_score: 76 },
  });

  assert.equal(recorded.outcome_status, 'EFFECTIVE');
  assert.equal(recorded.status, 'OUTCOME_RECORDED');
  assert.ok(recorded.completed_at);

  // 5. Query Interventions List
  const list = await getInterventions({
    schoolId: testSchoolId,
    studentId: testStudentId,
  });
  assert.ok(list.items.length >= 1);
  const found = list.items.find((item) => item.id === intervention.id);
  assert.ok(found);
  assert.equal(found.outcome_status, 'EFFECTIVE');

  // 6. Verify School Intelligence Cockpit metrics
  const cockpit = await getSchoolIntelligenceOverview({ schoolId: testSchoolId });
  assert.ok(cockpit.overview.totalStudents >= 0);
  assert.ok(cockpit.overview.stableCount >= 0);
  assert.ok(Array.isArray(cockpit.classTrends));
  assert.ok(Array.isArray(cockpit.reviewQueue));
});
