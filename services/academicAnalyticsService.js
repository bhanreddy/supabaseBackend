import { classifyHealth } from './academicPlannerMath.js';
import sql from '../db.js';
import { formatYMD } from './workingDayResolver.js';

/**
 * Service for Plan vs Actual Analytics & Management Intelligence
 * Calculates progress percentages, variance, velocity, projected completion,
 * and maintains the fast materialized cache `academic_plan_metrics`.
 */
class AcademicAnalyticsService {
  static classifyHealth(variance, actualPct, thresholds = {}) {
    return classifyHealth(variance, actualPct, thresholds);
  }

  /**
   * Recalculate metrics for a single academic plan and upsert into academic_plan_metrics
   */
  static async recalculatePlanMetrics({ schoolId, planId, dbClient = sql }) {
    const numericSchoolId = Number(schoolId);

    // Fetch plan details
    const [plan] = await dbClient`
      SELECT 
        id, academic_year_id, planned_start_date, planned_end_date, target_completion_date
      FROM academic_plans
      WHERE id = ${planId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    if (!plan) return null;

    // Fetch all scheduled items for this plan with their topic weights and estimated periods
    const items = await dbClient`
      SELECT 
        i.id, i.sequence, i.status, i.planned_periods, i.actual_periods_consumed,
        i.planned_start_date, i.planned_end_date,
        tp.weight, tp.estimated_periods
      FROM academic_plan_items i
      JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
      WHERE i.academic_plan_id = ${planId}
        AND i.school_id = ${numericSchoolId}
        AND i.deleted_at IS NULL
      ORDER BY i.sequence ASC
    `;

    const totalTopics = items.length;
    if (totalTopics === 0) {
      const emptyMetrics = {
        academic_plan_id: planId,
        school_id: numericSchoolId,
        total_topics: 0,
        completed_topics: 0,
        total_estimated_periods: 0,
        consumed_periods: 0,
        expected_progress: 0.00,
        actual_progress: 0.00,
        variance: 0.00,
        current_velocity: 0.00,
        required_velocity: 0.00,
        projected_completion_date: plan.target_completion_date,
        projected_delay_days: 0,
        projected_delay_periods: 0,
        health_status: 'ON_TRACK',
        last_calculated_at: new Date()
      };
      await dbClient`
        INSERT INTO academic_plan_metrics ${dbClient(emptyMetrics)}
        ON CONFLICT (academic_plan_id) DO UPDATE SET
          total_topics = EXCLUDED.total_topics,
          actual_progress = EXCLUDED.actual_progress,
          expected_progress = EXCLUDED.expected_progress,
          variance = EXCLUDED.variance,
          health_status = EXCLUDED.health_status,
          last_calculated_at = now()
      `;
      return emptyMetrics;
    }

    const todayStr = formatYMD(new Date());

    let totalWeight = 0;
    let completedWeight = 0;
    let expectedWeight = 0;
    let completedTopics = 0;
    let totalEstimatedPeriods = 0;
    let totalConsumedPeriods = 0;

    items.forEach(item => {
      const weight = Number(item.weight || 1.0);
      const estPeriods = Number(item.estimated_periods || item.planned_periods || 1);
      totalWeight += weight;
      totalEstimatedPeriods += estPeriods;
      totalConsumedPeriods += Number(item.actual_periods_consumed || 0);

      if (item.status === 'COMPLETED') {
        completedWeight += weight;
        completedTopics++;
      } else if (item.status === 'PARTIALLY_COMPLETED') {
        completedWeight += weight * 0.5; // Default partial weight 50%
      }

      // Expected progress: If planned_end_date is in the past, topic should be completed
      if (item.planned_end_date && formatYMD(item.planned_end_date) <= todayStr) {
        expectedWeight += weight;
      } else if (item.planned_start_date && formatYMD(item.planned_start_date) <= todayStr) {
        expectedWeight += weight * 0.5; // Halfway expected
      }
    });

    const actualPct = totalWeight > 0 ? Math.round((completedWeight / totalWeight) * 1000) / 10 : 0;
    const expectedPct = totalWeight > 0 ? Math.min(100, Math.round((expectedWeight / totalWeight) * 1000) / 10) : 0;
    const variance = Math.round((actualPct - expectedPct) * 10) / 10;

    // Teaching velocity calculation (periods/week)
    // Elapsed weeks between plan start and today
    const planStart = new Date(plan.planned_start_date);
    const today = new Date(todayStr);
    const elapsedDays = Math.max(1, Math.round((today - planStart) / (1000 * 60 * 60 * 24)));
    const elapsedWeeks = Math.max(0.5, elapsedDays / 7);
    const currentVelocity = Math.round((totalConsumedPeriods / elapsedWeeks) * 10) / 10;

    // Remaining periods and required velocity to hit target completion date
    const remainingPeriods = Math.max(0, totalEstimatedPeriods - totalConsumedPeriods);
    const targetDate = new Date(plan.target_completion_date);
    const remainingDays = Math.max(1, Math.round((targetDate - today) / (1000 * 60 * 60 * 24)));
    const remainingWeeks = Math.max(0.5, remainingDays / 7);
    const requiredVelocity = Math.round((remainingPeriods / remainingWeeks) * 10) / 10;

    // Projected completion date
    // At current velocity, how many weeks needed for remaining periods?
    const effectiveVelocity = currentVelocity > 0 ? currentVelocity : requiredVelocity;
    const weeksNeeded = effectiveVelocity > 0 ? remainingPeriods / effectiveVelocity : remainingWeeks;
    const projectedDate = new Date(today);
    projectedDate.setDate(projectedDate.getDate() + Math.round(weeksNeeded * 7));
    const projectedCompletionDate = formatYMD(projectedDate);

    // Projected delay
    const delayDays = Math.max(0, Math.round((projectedDate - targetDate) / (1000 * 60 * 60 * 24)));
    const delayPeriods = delayDays > 0 && effectiveVelocity > 0 ? Math.round((delayDays / 7) * effectiveVelocity * 10) / 10 : 0;

    // Academic Health Status Classification:
    // Completed: 100% actual progress
    // Ahead: variance > +5%
    // On Track: variance >= -5%
    // Slight Delay: -5% to -15%
    // At Risk: -15% to -25%
    // Critical: < -25%
    const healthStatus = AcademicAnalyticsService.classifyHealth(variance, actualPct);

    const metricsData = {
      academic_plan_id: planId,
      school_id: numericSchoolId,
      total_topics: totalTopics,
      completed_topics: completedTopics,
      total_estimated_periods: totalEstimatedPeriods,
      consumed_periods: totalConsumedPeriods,
      expected_progress: expectedPct,
      actual_progress: actualPct,
      variance: variance,
      current_velocity: currentVelocity,
      required_velocity: requiredVelocity,
      projected_completion_date: projectedCompletionDate,
      projected_delay_days: delayDays,
      projected_delay_periods: delayPeriods,
      health_status: healthStatus,
      last_calculated_at: new Date()
    };

    await dbClient`
      INSERT INTO academic_plan_metrics (
        academic_plan_id, school_id, total_topics, completed_topics,
        total_estimated_periods, consumed_periods, expected_progress,
        actual_progress, variance, current_velocity, required_velocity,
        projected_completion_date, projected_delay_days, projected_delay_periods,
        health_status, last_calculated_at
      ) VALUES (
        ${metricsData.academic_plan_id}, ${metricsData.school_id}, ${metricsData.total_topics},
        ${metricsData.completed_topics}, ${metricsData.total_estimated_periods}, ${metricsData.consumed_periods},
        ${metricsData.expected_progress}, ${metricsData.actual_progress}, ${metricsData.variance},
        ${metricsData.current_velocity}, ${metricsData.required_velocity}, ${metricsData.projected_completion_date},
        ${metricsData.projected_delay_days}, ${metricsData.projected_delay_periods}, ${metricsData.health_status},
        now()
      )
      ON CONFLICT (academic_plan_id) DO UPDATE SET
        total_topics = EXCLUDED.total_topics,
        completed_topics = EXCLUDED.completed_topics,
        total_estimated_periods = EXCLUDED.total_estimated_periods,
        consumed_periods = EXCLUDED.consumed_periods,
        expected_progress = EXCLUDED.expected_progress,
        actual_progress = EXCLUDED.actual_progress,
        variance = EXCLUDED.variance,
        current_velocity = EXCLUDED.current_velocity,
        required_velocity = EXCLUDED.required_velocity,
        projected_completion_date = EXCLUDED.projected_completion_date,
        projected_delay_days = EXCLUDED.projected_delay_days,
        projected_delay_periods = EXCLUDED.projected_delay_periods,
        health_status = EXCLUDED.health_status,
        last_calculated_at = now()
    `;

    return metricsData;
  }

  /**
   * Management Command Center Overview
   * Returns top summary cards: overall completion, expected, health counts, at-risk and critical counts
   */
  static async getCommandCenterSummary({ schoolId, academicYearId }) {
    const numericSchoolId = Number(schoolId);

    const [kpi] = await sql`
      SELECT 
        COUNT(p.id)::int AS total_plans,
        COALESCE(ROUND(AVG(m.actual_progress), 1), 0.0) AS overall_actual_completion,
        COALESCE(ROUND(AVG(m.expected_progress), 1), 0.0) AS overall_expected_completion,
        COALESCE(ROUND(AVG(m.variance), 1), 0.0) AS average_variance,
        COUNT(p.id) FILTER (WHERE m.health_status IN ('ON_TRACK', 'AHEAD'))::int AS on_track_count,
        COUNT(p.id) FILTER (WHERE m.health_status = 'SLIGHT_DELAY')::int AS slight_delay_count,
        COUNT(p.id) FILTER (WHERE m.health_status = 'AT_RISK')::int AS at_risk_count,
        COUNT(p.id) FILTER (WHERE m.health_status = 'CRITICAL')::int AS critical_count,
        COUNT(p.id) FILTER (WHERE m.health_status = 'COMPLETED')::int AS completed_count
      FROM academic_plans p
      JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
      WHERE p.school_id = ${numericSchoolId}
        AND p.deleted_at IS NULL
        ${academicYearId ? sql`AND p.academic_year_id = ${academicYearId}` : sql``}
    `;

    let overallHealth = 'GOOD';
    if ((kpi?.critical_count || 0) > 0) {
      overallHealth = 'CRITICAL';
    } else if ((kpi?.at_risk_count || 0) > 2) {
      overallHealth = 'ATTENTION_REQUIRED';
    } else if ((kpi?.slight_delay_count || 0) > 5) {
      overallHealth = 'MODERATE';
    }

    return {
      total_plans: kpi?.total_plans || 0,
      overall_actual_completion: Number(kpi?.overall_actual_completion || 0),
      overall_expected_completion: Number(kpi?.overall_expected_completion || 0),
      average_variance: Number(kpi?.average_variance || 0),
      overall_health: overallHealth,
      counts: {
        on_track: kpi?.on_track_count || 0,
        slight_delay: kpi?.slight_delay_count || 0,
        at_risk: kpi?.at_risk_count || 0,
        critical: kpi?.critical_count || 0,
        completed: kpi?.completed_count || 0
      }
    };
  }

  /**
   * Multi-level Drilldown:
   * School -> Class -> Section -> Subject -> Teacher
   */
  static async getDrilldown({ schoolId, academicYearId, classId, sectionId, subjectId }) {
    const numericSchoolId = Number(schoolId);

    return sql`
      SELECT 
        p.id AS plan_id,
        p.class_id,
        cl.name AS class_name,
        p.section_id,
        sec.name AS section_name,
        p.subject_id,
        s.name AS subject_name,
        p.teacher_id,
        per.display_name AS teacher_name,
        m.total_topics,
        m.completed_topics,
        m.actual_progress,
        m.expected_progress,
        m.variance,
        m.current_velocity,
        m.required_velocity,
        m.projected_completion_date,
        m.projected_delay_days,
        m.health_status,
        m.last_calculated_at
      FROM academic_plans p
      JOIN classes cl ON p.class_id = cl.id
      JOIN sections sec ON p.section_id = sec.id
      JOIN subjects s ON p.subject_id = s.id
      LEFT JOIN staff st ON p.teacher_id = st.id
      LEFT JOIN persons per ON st.person_id = per.id
      LEFT JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
      WHERE p.school_id = ${numericSchoolId}
        AND p.deleted_at IS NULL
        ${academicYearId ? sql`AND p.academic_year_id = ${academicYearId}` : sql``}
        ${classId ? sql`AND p.class_id = ${classId}` : sql``}
        ${sectionId ? sql`AND p.section_id = ${sectionId}` : sql``}
        ${subjectId ? sql`AND p.subject_id = ${subjectId}` : sql``}
      ORDER BY cl.name ASC, sec.name ASC, s.name ASC
    `;
  }

  /**
   * Cross-Section Discrepancy Analysis
   * Compares sections within the same class & subject to detect pace variance (e.g. 8A vs 8B vs 8C)
   */
  static async getCrossSectionAnalysis({ schoolId, academicYearId, classId }) {
    const numericSchoolId = Number(schoolId);

    const rows = await sql`
      SELECT 
        cl.id AS class_id,
        cl.name AS class_name,
        s.id AS subject_id,
        s.name AS subject_name,
        sec.id AS section_id,
        sec.name AS section_name,
        per.display_name AS teacher_name,
        m.actual_progress,
        m.expected_progress,
        m.variance,
        m.consumed_periods,
        m.total_estimated_periods,
        m.health_status
      FROM academic_plans p
      JOIN classes cl ON p.class_id = cl.id
      JOIN sections sec ON p.section_id = sec.id
      JOIN subjects s ON p.subject_id = s.id
      LEFT JOIN staff st ON p.teacher_id = st.id
      LEFT JOIN persons per ON st.person_id = per.id
      LEFT JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
      WHERE p.school_id = ${numericSchoolId}
        AND p.deleted_at IS NULL
        ${academicYearId ? sql`AND p.academic_year_id = ${academicYearId}` : sql``}
        ${classId ? sql`AND p.class_id = ${classId}` : sql``}
      ORDER BY cl.name ASC, s.name ASC, sec.name ASC
    `;

    // Group by class_id and subject_id
    const groups = new Map();
    rows.forEach(r => {
      const key = `${r.class_id}_${r.subject_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          class_id: r.class_id,
          class_name: r.class_name,
          subject_id: r.subject_id,
          subject_name: r.subject_name,
          sections: []
        });
      }
      groups.get(key).sections.push(r);
    });

    // Evaluate discrepancies across sections
    const results = [];
    groups.forEach(group => {
      if (group.sections.length > 1) {
        const progresses = group.sections.map(s => Number(s.actual_progress || 0));
        const maxPct = Math.max(...progresses);
        const minPct = Math.min(...progresses);
        const discrepancyPct = Math.round((maxPct - minPct) * 10) / 10;

        // Approximate periods lag
        const periodsArr = group.sections.map(s => Number(s.consumed_periods || 0));
        const periodLag = Math.round(Math.max(...periodsArr) - Math.min(...periodsArr));

        let insight = null;
        if (discrepancyPct > 15) {
          const lagging = group.sections.find(s => Number(s.actual_progress || 0) === minPct);
          insight = `${lagging?.section_name || 'One section'} is approximately ${periodLag} teaching periods behind other sections.`;
        }

        results.push({
          ...group,
          max_progress: maxPct,
          min_progress: minPct,
          discrepancy_pct: discrepancyPct,
          period_lag: periodLag,
          has_discrepancy: discrepancyPct > 10,
          insight
        });
      } else {
        results.push({
          ...group,
          max_progress: group.sections[0]?.actual_progress || 0,
          min_progress: group.sections[0]?.actual_progress || 0,
          discrepancy_pct: 0,
          period_lag: 0,
          has_discrepancy: false,
          insight: null
        });
      }
    });

    return results;
  }

  static async getWeeklySummary({ schoolId, academicYearId }) {
    const summary = await this.getCommandCenterSummary({ schoolId, academicYearId });
    const drilldown = await this.getDrilldown({ schoolId, academicYearId });
    const delayed = [...drilldown].sort(
      (a, b) => Number(a.variance || 0) - Number(b.variance || 0)
    )[0];
    return {
      ...summary,
      recovered_this_week: 0,
      largest_delay: delayed
        ? {
            class_name: delayed.class_name,
            section_name: delayed.section_name,
            subject_name: delayed.subject_name,
            variance: delayed.variance,
            health_status: delayed.health_status,
          }
        : null,
    };
  }
}

export default AcademicAnalyticsService;
