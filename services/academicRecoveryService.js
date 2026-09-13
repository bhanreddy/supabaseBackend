import sql from '../db.js';
import { formatYMD } from './workingDayResolver.js';

/**
 * Service for Academic Recovery Planning & Disruption Management
 * Proposes actionable recovery strategies (+1 period/wk, +2 periods, buffer adjustment,
 * optional topic deferrals) and manages school closure/holiday rebalancing.
 */
class AcademicRecoveryService {
  /**
   * Generate recovery scenarios for an at-risk academic plan
   *
   * @param {Object} params
   * @param {number|string} params.schoolId
   * @param {string} params.planId
   * @param {string} [params.riskEventId]
   * @param {string} [params.createdBy]
   */
  static async generateRecoveryOptions({ schoolId, planId, riskEventId, createdBy }) {
    const numericSchoolId = Number(schoolId);

    const [plan] = await sql`
      SELECT 
        p.*,
        cl.name AS class_name,
        sec.name AS section_name,
        s.name AS subject_name,
        m.actual_progress,
        m.expected_progress,
        m.variance,
        m.current_velocity,
        m.required_velocity,
        m.projected_delay_days,
        m.projected_delay_periods
      FROM academic_plans p
      JOIN classes cl ON p.class_id = cl.id
      JOIN sections sec ON p.section_id = sec.id
      JOIN subjects s ON p.subject_id = s.id
      LEFT JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
      WHERE p.id = ${planId} AND p.school_id = ${numericSchoolId}
    `;
    if (!plan) throw new Error('Academic Plan not found');

    const delayPeriods = Math.max(1, Number(plan.projected_delay_periods || Math.round((plan.projected_delay_days || 7) * 0.7)));
    const targetDate = plan.target_completion_date;
    const revisionDays = plan.revision_days || 0;

    // Check optional topics count
    const [opt] = await sql`
      SELECT COUNT(i.id)::int AS count, COALESCE(SUM(i.planned_periods), 0)::int AS periods
      FROM academic_plan_items i
      JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
      WHERE i.academic_plan_id = ${planId}
        AND i.school_id = ${numericSchoolId}
        AND tp.is_optional = true
        AND i.status = 'NOT_STARTED'
    `;
    const optionalPeriods = opt?.periods || 0;

    // Build 4 clear options
    const weeksForOptionA = Math.ceil(delayPeriods / 1.0);
    const dateOptionA = new Date();
    dateOptionA.setDate(dateOptionA.getDate() + weeksForOptionA * 7);

    const weeksForOptionB = Math.ceil(delayPeriods / 2.0);
    const dateOptionB = new Date();
    dateOptionB.setDate(dateOptionB.getDate() + weeksForOptionB * 7);

    const options = [
      {
        key: 'OPTION_A',
        title: '+1 Period per Week',
        description: `Add 1 extra ${plan.subject_name} period per week via substitution or timetable adjustment.`,
        added_periods_per_week: 1,
        recovery_duration_weeks: weeksForOptionA,
        expected_recovery_date: formatYMD(dateOptionA),
        tradeoffs: 'Requires 1 additional timetable slot per week.'
      },
      {
        key: 'OPTION_B',
        title: 'Accelerated Catch-Up (+2 Periods/Week)',
        description: `Add 2 extra periods per week for rapid syllabus alignment.`,
        added_periods_per_week: 2,
        recovery_duration_weeks: weeksForOptionB,
        expected_recovery_date: formatYMD(dateOptionB),
        tradeoffs: 'High intensity; recovers schedule twice as fast.'
      }
    ];

    if (revisionDays >= 7) {
      const bufferDaysUsed = Math.min(revisionDays - 3, Math.ceil(delayPeriods * 1.5));
      const remainingBuffer = revisionDays - bufferDaysUsed;
      options.push({
        key: 'OPTION_C',
        title: `Absorb via Revision Buffer (${bufferDaysUsed} days)`,
        description: `Reduce scheduled pre-exam revision buffer from ${revisionDays} days to ${remainingBuffer} days.`,
        added_periods_per_week: 0,
        recovery_duration_weeks: 1,
        expected_recovery_date: formatYMD(new Date()),
        tradeoffs: `Leaves ${remainingBuffer} days for final exam preparation instead of ${revisionDays} days.`
      });
    }

    if (optionalPeriods > 0) {
      options.push({
        key: 'OPTION_D',
        title: `Defer Optional Topics (${optionalPeriods} periods saved)`,
        description: `Move ${opt?.count || 0} non-core optional topics to post-exam enrichment.`,
        added_periods_per_week: 0,
        recovery_duration_weeks: 1,
        expected_recovery_date: formatYMD(new Date()),
        tradeoffs: 'Saves immediate syllabus pressure without affecting core exam topics.'
      });
    }

    const strategyPayload = {
      plan_id: planId,
      class_name: plan.class_name,
      section_name: plan.section_name,
      subject_name: plan.subject_name,
      delay_periods: delayPeriods,
      target_completion_date: targetDate,
      options
    };

    // Save recovery proposal
    const [proposal] = await sql`
      INSERT INTO academic_recovery_plans (
        school_id, academic_plan_id, risk_event_id, strategy,
        status, created_by
      ) VALUES (
        ${numericSchoolId}, ${planId}, ${riskEventId || null},
        ${JSON.stringify(strategyPayload)}, 'PROPOSED', ${createdBy || null}
      )
      RETURNING *
    `;

    return proposal;
  }

  /**
   * Approve a recovery strategy option
   */
  static async approveRecoveryOption({ schoolId, recoveryPlanId, selectedOption, approvedBy }) {
    const numericSchoolId = Number(schoolId);

    const [recoveryPlan] = await sql`
      SELECT * FROM academic_recovery_plans
      WHERE id = ${recoveryPlanId} AND school_id = ${numericSchoolId}
    `;
    if (!recoveryPlan) throw new Error('Recovery plan not found');

    const strategy = recoveryPlan.strategy || {};
    const selected = (strategy.options || []).find(o => o.key === selectedOption);
    const expectedDate = selected ? selected.expected_recovery_date : null;

    return sql.begin(async (tx) => {
      const [updated] = await tx`
        UPDATE academic_recovery_plans
        SET 
          status = 'APPROVED',
          selected_option = ${selectedOption},
          expected_recovery_date = ${expectedDate},
          approved_by = ${approvedBy || null},
          approved_at = now(),
          updated_at = now()
        WHERE id = ${recoveryPlanId} AND school_id = ${numericSchoolId}
        RETURNING *
      `;

      // If tied to a risk event, resolve or update the risk
      if (recoveryPlan.risk_event_id) {
        await tx`
          UPDATE academic_risk_events
          SET status = 'RESOLVED', resolved_at = now(), resolved_by = ${approvedBy || null}
          WHERE id = ${recoveryPlan.risk_event_id} AND school_id = ${numericSchoolId}
        `;
      }

      // If OPTION_D was chosen, mark unstarted optional items as DEFERRED
      if (selectedOption === 'OPTION_D') {
        await tx`
          UPDATE academic_plan_items
          SET status = 'DEFERRED', updated_at = now()
          FROM curriculum_topics tp
          WHERE academic_plan_items.curriculum_topic_id = tp.id
            AND academic_plan_items.academic_plan_id = ${recoveryPlan.academic_plan_id}
            AND academic_plan_items.school_id = ${numericSchoolId}
            AND tp.is_optional = true
            AND academic_plan_items.status = 'NOT_STARTED'
        `;
      }

      return updated;
    });
  }

  /**
   * Unexpected Holiday Replanning Simulator
   * Identifies all academic plans impacted by sudden school closure dates
   *
   * @param {Object} params
   * @param {number|string} params.schoolId
   * @param {string} params.startDate - YYYY-MM-DD
   * @param {string} params.endDate - YYYY-MM-DD
   */
  static async simulateHolidayDisruption({ schoolId, startDate, endDate }) {
    const numericSchoolId = Number(schoolId);
    const start = formatYMD(startDate);
    const end = formatYMD(endDate);

    // Find all plan items scheduled during this date window that are not completed
    const affectedItems = await sql`
      SELECT 
        i.id AS plan_item_id,
        i.academic_plan_id,
        i.planned_start_date,
        i.planned_end_date,
        i.planned_periods,
        tp.title AS topic_title,
        p.class_id, p.section_id, p.subject_id,
        cl.name AS class_name,
        sec.name AS section_name,
        s.name AS subject_name,
        per.display_name AS teacher_name
      FROM academic_plan_items i
      JOIN academic_plans p ON i.academic_plan_id = p.id
      JOIN classes cl ON p.class_id = cl.id
      JOIN sections sec ON p.section_id = sec.id
      JOIN subjects s ON p.subject_id = s.id
      JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
      LEFT JOIN staff st ON p.teacher_id = st.id
      LEFT JOIN persons per ON st.person_id = per.id
      WHERE i.school_id = ${numericSchoolId}
        AND i.status IN ('NOT_STARTED', 'IN_PROGRESS')
        AND i.planned_start_date <= ${end}::date
        AND i.planned_end_date >= ${start}::date
        AND i.deleted_at IS NULL
    `;

    // Group by plan
    const planMap = new Map();
    affectedItems.forEach(item => {
      if (!planMap.has(item.academic_plan_id)) {
        planMap.set(item.academic_plan_id, {
          plan_id: item.academic_plan_id,
          class_name: item.class_name,
          section_name: item.section_name,
          subject_name: item.subject_name,
          teacher_name: item.teacher_name,
          displaced_periods: 0,
          items: []
        });
      }
      const entry = planMap.get(item.academic_plan_id);
      entry.displaced_periods += Number(item.planned_periods || 1);
      entry.items.push(item);
    });

    const closureDays = Math.max(1, Math.round((new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24)) + 1);

    return {
      start_date: start,
      end_date: end,
      closure_calendar_days: closureDays,
      total_affected_plans: planMap.size,
      total_displaced_items: affectedItems.length,
      affected_plans: Array.from(planMap.values())
    };
  }

  /**
   * Shift affected plan items forward after an unexpected holiday
   */
  static async shiftPlansForHoliday({ schoolId, startDate, endDate, shiftDays }) {
    const numericSchoolId = Number(schoolId);
    const start = formatYMD(startDate);
    const end = formatYMD(endDate);
    const days = Number(shiftDays) || 1;

    return sql.begin(async (tx) => {
      // Shift all uncompleted items that were scheduled on or after the closure start
      const updated = await tx`
        UPDATE academic_plan_items
        SET 
          planned_start_date = planned_start_date + (${days} * INTERVAL '1 day'),
          planned_end_date = planned_end_date + (${days} * INTERVAL '1 day'),
          updated_at = now()
        WHERE school_id = ${numericSchoolId}
          AND status IN ('NOT_STARTED', 'IN_PROGRESS')
          AND planned_start_date >= ${start}::date
          AND deleted_at IS NULL
        RETURNING academic_plan_id
      `;

      // Get distinct plan IDs to trigger recalculation
      const uniquePlanIds = [...new Set(updated.map(u => u.academic_plan_id))];

      return {
        shifted_items_count: updated.length,
        affected_plans_count: uniquePlanIds.length,
        plan_ids: uniquePlanIds
      };
    });
  }
}

export default AcademicRecoveryService;
