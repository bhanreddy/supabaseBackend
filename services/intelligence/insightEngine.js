import sql from '../../db.js';
import logger from '../../utils/logger.js';
import { extractStudentSignals } from './signalEngine.js';
import { evaluateRules } from './ruleEngine.js';
import { recordDetectedPatterns } from './patternEngine.js';
import { getStudentBaseline } from './studentBaselineService.js';
import { notifyAttentionInsight } from './intelligenceNotificationService.js';

/**
 * Full student intelligence evaluation cycle:
 * Extract Signals → Evaluate Rules → Detect Patterns → Generate Explainable Insights → Refresh Profile.
 */
export async function evaluateStudentIntelligence({ schoolId, studentId }) {
  // 1. Extract and normalize signals from real operational data
  const signals = await extractStudentSignals({ schoolId, studentId });

  // 2. Evaluate against active rules
  const ruleMatches = await evaluateRules({ schoolId, studentId, signals });

  // 3. Record detected patterns
  await recordDetectedPatterns({ schoolId, studentId, ruleMatches });

  // 4. Resolve class_section_id
  const [enrollment] = await sql`
    SELECT class_section_id
    FROM public.student_enrollments
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY start_date DESC
    LIMIT 1
  `;
  const classSectionId = enrollment?.class_section_id || null;

  // 5. Generate / Update Insights & Explanations
  const baseline = await getStudentBaseline({ schoolId, studentId, windowDays: 60 });
  const generatedInsights = [];

  for (const match of ruleMatches) {
    const { rule, title, summary, confidence, recommendations, supportingSignals } = match;
    const anecdoteIds = Array.from(new Set(
      (signals || [])
        .filter((s) => (supportingSignals || []).includes(s.id))
        .flatMap((s) => s.metadata?.anecdote_ids || [])
        .filter(Boolean)
    ));

    // Map severity to insight_type
    let insightType = 'WATCH';
    if (rule.category === 'SOCIAL' || rule.category === 'ACHIEVEMENT') {
      insightType = 'STRENGTH';
    } else if (rule.severity === 'LEVEL_1_POSITIVE') {
      insightType = 'GROWTH';
    } else if (rule.severity === 'LEVEL_3_ATTENTION') {
      insightType = 'ATTENTION';
    } else if (rule.severity === 'LEVEL_4_CRITICAL') {
      insightType = 'CRITICAL_REVIEW';
    }

    // Check if an active insight for this rule already exists
    const [existing] = await sql`
      SELECT id FROM public.intelligence_insights
      WHERE school_id = ${schoolId}
        AND student_id = ${studentId}
        AND rule_code = ${rule.rule_code}
        AND status = 'ACTIVE'
      LIMIT 1
    `;

    let insightId;
    let isNewInsight = false;
    if (existing) {
      insightId = existing.id;
      await sql`
        UPDATE public.intelligence_insights
        SET
          summary = ${summary},
          confidence = ${confidence},
          supporting_signal_ids = ${sql.json(supportingSignals || [])},
          recommendations = ${sql.json(recommendations || [])},
          updated_at = now()
        WHERE id = ${insightId}
      `;
    } else {
      const [newInsight] = await sql`
        INSERT INTO public.intelligence_insights (
          school_id,
          student_id,
          class_section_id,
          title,
          summary,
          insight_type,
          confidence,
          rule_id,
          rule_code,
          rule_version,
          supporting_signal_ids,
          supporting_anecdote_ids,
          recommendations,
          status
        ) VALUES (
          ${schoolId},
          ${studentId},
          ${classSectionId},
          ${title},
          ${summary},
          ${insightType},
          ${confidence},
          ${rule.id},
          ${rule.rule_code},
          ${rule.version || 1},
          ${sql.json(supportingSignals || [])},
          ${sql.json(anecdoteIds)},
          ${sql.json(recommendations || [])},
          'ACTIVE'
        )
        RETURNING *
      `;
      insightId = newInsight.id;
      isNewInsight = true;
    }

    // Build transparent explanation points
    const matchedSignalsData = signals.filter((s) => supportingSignals.includes(s.id));
    const explanationBullets = matchedSignalsData.map((s) => s.metadata?.note || `${s.signal_type} detected`).filter(Boolean);
    if (explanationBullets.length === 0) {
      explanationBullets.push(summary);
    }

    const baselineComparison = {
      attendance_baseline: baseline.attendance.baselinePct,
      academic_baseline: baseline.academic.baselinePct,
      personal_observations: baseline.observations,
    };

    const dataSources = Array.from(new Set(matchedSignalsData.map((s) => s.source_module)));

    // Upsert explanation
    await sql`
      DELETE FROM public.intelligence_explanations WHERE insight_id = ${insightId}
    `;
    await sql`
      INSERT INTO public.intelligence_explanations (
        insight_id,
        explanation_text,
        bullet_points,
        baseline_comparison,
        data_sources
      ) VALUES (
        ${insightId},
        ${summary},
        ${sql.json(explanationBullets)},
        ${sql.json(baselineComparison)},
        ${sql.json(dataSources)}
      )
    `;

    generatedInsights.push({
      id: insightId,
      title,
      summary,
      insight_type: insightType,
      confidence,
      rule_code: rule.rule_code,
      recommendations,
      explanation_bullets: explanationBullets,
    });

    if (isNewInsight && (insightType === 'ATTENTION' || insightType === 'CRITICAL_REVIEW')) {
      await notifyAttentionInsight({
        schoolId,
        studentId,
        insight: { id: insightId, title },
      });
    }
  }

  // 6. Refresh Student Intelligence Profile
  const activeInsights = await sql`
    SELECT insight_type FROM public.intelligence_insights
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
      AND status = 'ACTIVE'
  `;

  let profileTier = 'STABLE';
  const hasCritical = activeInsights.some((i) => i.insight_type === 'CRITICAL_REVIEW');
  const hasAttention = activeInsights.some((i) => i.insight_type === 'ATTENTION');
  const hasWatch = activeInsights.some((i) => i.insight_type === 'WATCH');
  const hasGrowth = activeInsights.some((i) => i.insight_type === 'GROWTH' || i.insight_type === 'STRENGTH');

  if (hasCritical || hasAttention) {
    profileTier = 'ATTENTION';
  } else if (hasWatch) {
    profileTier = 'WATCH';
  } else if (hasGrowth) {
    profileTier = 'GROWTH';
  } else {
    profileTier = 'STABLE';
  }

  const [activeInterventions] = await sql`
    SELECT count(*)::int AS count
    FROM public.student_interventions
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
      AND status IN ('RECOMMENDED', 'ACCEPTED', 'IN_PROGRESS', 'FOLLOW_UP')
  `;

  await sql`
    INSERT INTO public.student_intelligence_profiles (
      school_id,
      student_id,
      status_tier,
      attendance_rate_30d,
      assessment_avg_recent,
      total_anecdotes_positive,
      total_anecdotes_concern,
      active_insights_count,
      active_interventions_count,
      last_evaluated_at
    ) VALUES (
      ${schoolId},
      ${studentId},
      ${profileTier},
      ${baseline.attendance.baselinePct},
      ${baseline.academic.baselinePct},
      ${baseline.observations.positiveCount},
      ${baseline.observations.concernCount},
      ${activeInsights.length},
      ${activeInterventions?.count || 0},
      now()
    )
    ON CONFLICT (school_id, student_id)
    DO UPDATE SET
      status_tier = EXCLUDED.status_tier,
      attendance_rate_30d = EXCLUDED.attendance_rate_30d,
      assessment_avg_recent = EXCLUDED.assessment_avg_recent,
      total_anecdotes_positive = EXCLUDED.total_anecdotes_positive,
      total_anecdotes_concern = EXCLUDED.total_anecdotes_concern,
      active_insights_count = EXCLUDED.active_insights_count,
      active_interventions_count = EXCLUDED.active_interventions_count,
      last_evaluated_at = now(),
      updated_at = now()
  `;

  return {
    studentId,
    profileTier,
    baseline,
    signalsCount: signals.length,
    activeInsights: generatedInsights,
  };
}

/**
 * Fetch insights with their "Why?" explanations for a student.
 */
export async function getStudentInsights({ schoolId, studentId, userRoles = [] }) {
  const isParent = userRoles.includes('parent');
  const isStudent = userRoles.includes('student');

  const conditions = [
    sql`i.school_id = ${schoolId}`,
    sql`i.student_id = ${studentId}`,
  ];

  if (isParent) {
    conditions.push(sql`i.parent_visible = true`);
  }
  if (isStudent) {
    conditions.push(sql`i.parent_visible = true`); // Students only see approved parent-visible progress
  }

  const whereClause = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const rows = await sql`
    SELECT
      i.id,
      i.student_id,
      i.title,
      i.summary,
      i.insight_type,
      i.confidence,
      i.rule_code,
      i.rule_version,
      i.recommendations,
      i.status,
      i.parent_visible,
      i.created_at,
      i.supporting_signal_ids,
      i.supporting_anecdote_ids,
      e.explanation_text,
      e.bullet_points,
      e.baseline_comparison,
      e.data_sources
    FROM public.intelligence_insights i
    LEFT JOIN public.intelligence_explanations e ON e.insight_id = i.id
    WHERE ${whereClause}
    ORDER BY i.created_at DESC
  `;

  return rows.map((row) => ({
    ...row,
    explanation_bullets: row.bullet_points || [],
    recommended_actions: row.recommendations || [],
    baseline_context: row.baseline_comparison || null,
  }));
}

export async function attachSupportingSignals(insights = []) {
  const ids = Array.from(new Set(
    insights.flatMap((insight) => {
      const raw = insight.supporting_signal_ids;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return []; }
      }
      return [];
    }).filter(Boolean)
  ));
  if (ids.length === 0) {
    return insights.map((insight) => ({ ...insight, supporting_signals: [] }));
  }

  const signals = await sql`
    SELECT id, signal_type, source_module, severity, confidence, metadata, detected_at
    FROM public.intelligence_signals
    WHERE id IN ${sql(ids)}
  `;
  const byId = new Map(signals.map((s) => [s.id, {
    ...s,
    summary: s.metadata?.note || s.signal_type,
    description: s.metadata?.note || s.signal_type,
  }]));

  return insights.map((insight) => {
    const raw = Array.isArray(insight.supporting_signal_ids)
      ? insight.supporting_signal_ids
      : [];
    return {
      ...insight,
      supporting_signals: raw.map((id) => byId.get(id)).filter(Boolean),
    };
  });
}

export async function getStudentSignals({ schoolId, studentId, limit = 40 }) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 40));
  return sql`
    SELECT
      id, signal_type, source_module, severity, confidence,
      value_numeric, baseline_value, delta_percentage, window_days,
      metadata, detected_at
    FROM public.intelligence_signals
    WHERE school_id = ${schoolId}
      AND student_id = ${studentId}
    ORDER BY detected_at DESC
    LIMIT ${safeLimit}
  `;
}

export async function reviewInsight({ schoolId, insightId, userId, status, dismissedReason = null }) {
  const allowed = ['ACKNOWLEDGED', 'DISMISSED', 'ACTIVE'];
  if (!allowed.includes(status)) {
    throw new Error('Invalid insight status');
  }

  const [updated] = await sql`
    UPDATE public.intelligence_insights
    SET
      status = ${status},
      dismissed_reason = ${status === 'DISMISSED' ? dismissedReason : null},
      reviewed_by = ${userId},
      reviewed_at = now(),
      updated_at = now()
    WHERE school_id = ${schoolId}
      AND id = ${insightId}
    RETURNING *
  `;

  if (!updated) throw new Error('Insight not found');
  return updated;
}
