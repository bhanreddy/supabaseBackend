import sql from '../db.js';

/**
 * Service for Detecting & Managing Academic Risks
 * Filters out daily noise and flags persistent, high-severity delays,
 * velocity collapses, and exam proximity bottlenecks.
 */
class AcademicRiskService {
  /**
   * Scan all active plans in the school and evaluate risk triggers
   */
  static async scanAndDetectRisks({ schoolId, academicYearId }) {
    const numericSchoolId = Number(schoolId);

    // Fetch all active plans with their metrics and progress events count
    const plans = await sql`
      SELECT 
        p.id AS plan_id,
        p.class_id, p.section_id, p.subject_id, p.teacher_id,
        cl.name AS class_name,
        sec.name AS section_name,
        s.name AS subject_name,
        m.actual_progress,
        m.expected_progress,
        m.variance,
        m.current_velocity,
        m.required_velocity,
        m.projected_completion_date,
        m.projected_delay_days,
        m.health_status,
        -- Count how many consecutive continue/delay events in the past 14 days
        COUNT(e.id) FILTER (WHERE e.status = 'CONTINUE_NEXT_PERIOD' AND e.date >= CURRENT_DATE - INTERVAL '14 days')::int AS recent_continue_count,
        COUNT(e.id) FILTER (WHERE e.date >= CURRENT_DATE - INTERVAL '14 days')::int AS recent_event_count
      FROM academic_plans p
      JOIN classes cl ON p.class_id = cl.id
      JOIN sections sec ON p.section_id = sec.id
      JOIN subjects s ON p.subject_id = s.id
      JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
      LEFT JOIN academic_progress_events e ON p.id = e.academic_plan_id
      WHERE p.school_id = ${numericSchoolId}
        AND p.status IN ('ACTIVE', 'APPROVED')
        AND p.deleted_at IS NULL
        ${academicYearId ? sql`AND p.academic_year_id = ${academicYearId}` : sql``}
      GROUP BY p.id, cl.name, sec.name, s.name, m.actual_progress, m.expected_progress,
               m.variance, m.current_velocity, m.required_velocity, m.projected_completion_date,
               m.projected_delay_days, m.health_status
    `;

    const detectedRisks = [];

    for (const plan of plans) {
      const variance = Number(plan.variance || 0);
      const delayDays = Number(plan.projected_delay_days || 0);
      const currentVel = Number(plan.current_velocity || 0);
      const reqVel = Number(plan.required_velocity || 0);
      const continues = Number(plan.recent_continue_count || 0);

      let riskType = null;
      let severity = 'MEDIUM';
      let reason = null;

      // Trigger 1: Critical syllabus delay (variance < -25% or projected delay > 21 days)
      if (variance < -25 || delayDays > 21) {
        riskType = 'SYLLABUS_DELAY';
        severity = 'CRITICAL';
        reason = `Severe syllabus delay of ${delayDays} days (Variance: ${variance}%). Immediate academic intervention needed.`;
      }
      // Trigger 2: Persistent syllabus delay (variance between -15% and -25% or delay > 10 days)
      else if (variance < -15 || delayDays > 10) {
        riskType = 'SYLLABUS_DELAY';
        severity = 'HIGH';
        reason = `Persistent syllabus delay of ${delayDays} days (Variance: ${variance}%). Pacing recovery recommended.`;
      }
      // Trigger 3: Low teaching velocity (progress is actively slipping below required pace)
      else if (reqVel > 0 && currentVel > 0 && currentVel < 0.6 * reqVel) {
        riskType = 'LOW_TEACHING_VELOCITY';
        severity = 'MEDIUM';
        reason = `Teaching velocity (${currentVel} periods/wk) is significantly below required pace (${reqVel} periods/wk).`;
      }
      // Trigger 4: Repeated topic stalls (teacher had to continue the same topic 3+ times in recent weeks)
      else if (continues >= 3) {
        riskType = 'REPEATED_TOPIC_DELAY';
        severity = 'MEDIUM';
        reason = `Topics repeatedly rolling over to next periods (${continues} continuations in the last 14 days).`;
      }

      if (riskType) {
        // Upsert active risk event (avoid duplicate active risks for the same plan & riskType)
        const [existing] = await sql`
          SELECT id FROM academic_risk_events
          WHERE academic_plan_id = ${plan.plan_id}
            AND school_id = ${numericSchoolId}
            AND risk_type = ${riskType}
            AND status = 'ACTIVE'
          LIMIT 1
        `;

        if (!existing) {
          const [inserted] = await sql`
            INSERT INTO academic_risk_events (
              school_id, academic_plan_id, risk_type, severity,
              expected_progress, actual_progress, variance,
              projected_completion_date, reason, status
            ) VALUES (
              ${numericSchoolId}, ${plan.plan_id}, ${riskType}, ${severity},
              ${plan.expected_progress}, ${plan.actual_progress}, ${plan.variance},
              ${plan.projected_completion_date}, ${reason}, 'ACTIVE'
            )
            RETURNING *
          `;
          detectedRisks.push({
            ...inserted,
            class_name: plan.class_name,
            section_name: plan.section_name,
            subject_name: plan.subject_name
          });
        }
      } else {
        // If plan is now healthy, resolve any prior active risks automatically
        await sql`
          UPDATE academic_risk_events
          SET status = 'RESOLVED', resolved_at = now()
          WHERE academic_plan_id = ${plan.plan_id}
            AND school_id = ${numericSchoolId}
            AND status = 'ACTIVE'
        `;
      }
    }

    return detectedRisks;
  }

  /**
   * List active academic risks
   */
  static async listRisks({ schoolId, academicYearId, status = 'ACTIVE' }) {
    const numericSchoolId = Number(schoolId);

    return sql`
      SELECT 
        r.*,
        p.class_id, p.section_id, p.subject_id, p.teacher_id,
        cl.name AS class_name,
        sec.name AS section_name,
        s.name AS subject_name,
        per.display_name AS teacher_name,
        m.current_velocity,
        m.required_velocity,
        m.projected_delay_days,
        rec.id AS recovery_plan_id,
        rec.status AS recovery_plan_status
      FROM academic_risk_events r
      JOIN academic_plans p ON r.academic_plan_id = p.id
      JOIN classes cl ON p.class_id = cl.id
      JOIN sections sec ON p.section_id = sec.id
      JOIN subjects s ON p.subject_id = s.id
      LEFT JOIN staff st ON p.teacher_id = st.id
      LEFT JOIN persons per ON st.person_id = per.id
      LEFT JOIN academic_plan_metrics m ON p.id = m.academic_plan_id
      LEFT JOIN academic_recovery_plans rec ON rec.risk_event_id = r.id AND rec.status != 'REJECTED'
      WHERE r.school_id = ${numericSchoolId}
        ${status ? sql`AND r.status = ${status}` : sql``}
        ${academicYearId ? sql`AND p.academic_year_id = ${academicYearId}` : sql``}
      ORDER BY 
        CASE r.severity
          WHEN 'CRITICAL' THEN 1
          WHEN 'HIGH' THEN 2
          WHEN 'MEDIUM' THEN 3
          WHEN 'LOW' THEN 4
          ELSE 5
        END,
        r.detected_at DESC
    `;
  }

  /**
   * Mark a risk event as resolved or dismissed
   */
  static async resolveRisk({ schoolId, riskId, resolvedBy, status = 'RESOLVED' }) {
    const numericSchoolId = Number(schoolId);

    const [updated] = await sql`
      UPDATE academic_risk_events
      SET
        status = ${status},
        resolved_at = now(),
        resolved_by = ${resolvedBy || null}
      WHERE id = ${riskId} AND school_id = ${numericSchoolId}
      RETURNING *
    `;

    return updated;
  }
}

export default AcademicRiskService;
