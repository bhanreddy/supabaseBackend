import sql from '../db.js';
import AcademicSchedulingService from './academicSchedulingService.js';
import { formatYMD } from './workingDayResolver.js';

/**
 * Service for Academic Execution Plans
 * Manages plan lifecycle, item generation, review/approval workflow, and teacher handovers.
 */
class AcademicPlanService {
  /**
   * List academic plans with filters and status
   */
  static async listPlans({
    schoolId,
    academicYearId,
    termId,
    classId,
    sectionId,
    subjectId,
    teacherId,
    status
  }) {
    const numericSchoolId = Number(schoolId);

    return sql`
      SELECT 
        p.*,
        cl.name AS class_name,
        sec.name AS section_name,
        s.name AS subject_name,
        ay.code AS academic_year_code,
        per.display_name AS teacher_name,
        m.actual_progress,
        m.expected_progress,
        m.variance,
        m.health_status,
        m.current_velocity,
        m.required_velocity,
        m.projected_completion_date,
        m.projected_delay_days,
        COUNT(i.id)::int AS items_count,
        COUNT(i.id) FILTER (WHERE i.status = 'COMPLETED')::int AS completed_items_count
      FROM academic_plans p
      JOIN classes cl ON p.class_id = cl.id AND cl.school_id = ${numericSchoolId}
      JOIN sections sec ON p.section_id = sec.id AND sec.school_id = ${numericSchoolId}
      JOIN subjects s ON p.subject_id = s.id AND s.school_id = ${numericSchoolId}
      JOIN academic_years ay ON p.academic_year_id = ay.id AND ay.school_id = ${numericSchoolId}
      LEFT JOIN staff st ON p.teacher_id = st.id AND st.school_id = ${numericSchoolId}
      LEFT JOIN persons per ON st.person_id = per.id
      LEFT JOIN academic_plan_metrics m ON m.academic_plan_id = p.id AND m.school_id = ${numericSchoolId}
      LEFT JOIN academic_plan_items i ON i.academic_plan_id = p.id AND i.school_id = ${numericSchoolId} AND i.deleted_at IS NULL
      WHERE p.school_id = ${numericSchoolId}
        AND p.deleted_at IS NULL
        ${academicYearId ? sql`AND p.academic_year_id = ${academicYearId}` : sql``}
        ${termId ? sql`AND p.term_id = ${termId}` : sql``}
        ${classId ? sql`AND p.class_id = ${classId}` : sql``}
        ${sectionId ? sql`AND p.section_id = ${sectionId}` : sql``}
        ${subjectId ? sql`AND p.subject_id = ${subjectId}` : sql``}
        ${teacherId ? sql`AND p.teacher_id = ${teacherId}` : sql``}
        ${status ? sql`AND p.status = ${status}` : sql``}
      GROUP BY p.id, cl.name, sec.name, s.name, ay.code, per.display_name,
               m.actual_progress, m.expected_progress, m.variance, m.health_status,
               m.current_velocity, m.required_velocity, m.projected_completion_date, m.projected_delay_days
      ORDER BY cl.name ASC, sec.name ASC, s.name ASC
    `;
  }

  /**
   * Get single plan by ID with its scheduled items
   */
  static async getPlanById({ schoolId, planId, includeItems = true }) {
    const numericSchoolId = Number(schoolId);

    const [plan] = await sql`
      SELECT 
        p.*,
        cl.name AS class_name,
        sec.name AS section_name,
        s.name AS subject_name,
        ay.code AS academic_year_code,
        per.display_name AS teacher_name,
        c.name AS curriculum_name,
        c.version AS curriculum_version,
        m.actual_progress,
        m.expected_progress,
        m.variance,
        m.health_status,
        m.current_velocity,
        m.required_velocity,
        m.projected_completion_date,
        m.projected_delay_days
      FROM academic_plans p
      JOIN classes cl ON p.class_id = cl.id AND cl.school_id = ${numericSchoolId}
      JOIN sections sec ON p.section_id = sec.id AND sec.school_id = ${numericSchoolId}
      JOIN subjects s ON p.subject_id = s.id AND s.school_id = ${numericSchoolId}
      JOIN academic_years ay ON p.academic_year_id = ay.id AND ay.school_id = ${numericSchoolId}
      JOIN curricula c ON p.curriculum_id = c.id AND c.school_id = ${numericSchoolId}
      LEFT JOIN staff st ON p.teacher_id = st.id AND st.school_id = ${numericSchoolId}
      LEFT JOIN persons per ON st.person_id = per.id
      LEFT JOIN academic_plan_metrics m ON m.academic_plan_id = p.id AND m.school_id = ${numericSchoolId}
      WHERE p.id = ${planId}
        AND p.school_id = ${numericSchoolId}
        AND p.deleted_at IS NULL
    `;

    if (!plan) return null;

    let items = [];
    if (includeItems) {
      items = await sql`
        SELECT 
          i.*,
          tp.title AS topic_title,
          tp.sequence AS topic_sequence,
          tp.is_optional,
          ch.id AS chapter_id,
          ch.title AS chapter_title,
          ch.sequence AS chapter_sequence,
          u.id AS unit_id,
          u.title AS unit_title,
          lp.id AS lesson_plan_id,
          lp.status AS lesson_plan_status
        FROM academic_plan_items i
        JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id AND tp.school_id = ${numericSchoolId}
        JOIN curriculum_chapters ch ON tp.chapter_id = ch.id AND ch.school_id = ${numericSchoolId}
        LEFT JOIN curriculum_units u ON ch.unit_id = u.id AND u.school_id = ${numericSchoolId}
        LEFT JOIN lesson_plans lp ON lp.academic_plan_item_id = i.id AND lp.school_id = ${numericSchoolId}
        WHERE i.academic_plan_id = ${planId}
          AND i.school_id = ${numericSchoolId}
          AND i.deleted_at IS NULL
        ORDER BY i.sequence ASC, i.planned_start_date ASC
      `;
    }

    return {
      ...plan,
      items
    };
  }

  /**
   * Create an Academic Plan and optionally auto-generate its scheduled items
   */
  static async createPlan({
    schoolId,
    academicYearId,
    termId,
    classId,
    sectionId,
    subjectId,
    teacherId,
    curriculumId,
    plannedStartDate,
    plannedEndDate,
    targetCompletionDate,
    revisionDays = 15,
    createdBy,
    status = 'ACTIVE',
    autoGenerate = true
  }) {
    const numericSchoolId = Number(schoolId);

    const [year] = await sql`
      SELECT start_date, end_date FROM academic_years
      WHERE id = ${academicYearId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
    `;
    const startDate = plannedStartDate || formatYMD(year?.start_date) || formatYMD(new Date());
    const targetDate = targetCompletionDate || formatYMD(year?.end_date) || startDate;
    const endDate = plannedEndDate || targetDate;

    // If teacherId is not supplied, look up assigned teacher from class_subjects
    let assignedTeacherId = teacherId;
    if (!assignedTeacherId) {
      const [cs] = await sql`
        SELECT cs.teacher_id
        FROM class_subjects cs
        JOIN class_sections csec ON cs.class_section_id = csec.id
        WHERE csec.school_id = ${numericSchoolId}
          AND csec.academic_year_id = ${academicYearId}
          AND csec.class_id = ${classId}
          AND csec.section_id = ${sectionId}
          AND cs.subject_id = ${subjectId}
          AND cs.deleted_at IS NULL
        LIMIT 1
      `;
      assignedTeacherId = cs?.teacher_id || null;
    }

    // Insert AcademicPlan
    const [plan] = await sql`
      INSERT INTO academic_plans (
        school_id, academic_year_id, term_id, class_id, section_id,
        subject_id, teacher_id, curriculum_id, status,
        planned_start_date, planned_end_date, target_completion_date,
        revision_days, created_by
      ) VALUES (
        ${numericSchoolId}, ${academicYearId}, ${termId || null}, ${classId}, ${sectionId},
        ${subjectId}, ${assignedTeacherId || null}, ${curriculumId}, ${status},
        ${startDate}, ${endDate}, ${targetDate},
        ${revisionDays || 0}, ${createdBy || null}
      )
      ON CONFLICT (school_id, academic_year_id, class_id, section_id, subject_id) WHERE deleted_at IS NULL
      DO UPDATE SET
        teacher_id = EXCLUDED.teacher_id,
        curriculum_id = EXCLUDED.curriculum_id,
        target_completion_date = EXCLUDED.target_completion_date,
        revision_days = EXCLUDED.revision_days,
        updated_at = now()
      RETURNING *
    `;

    if (autoGenerate) {
      await this.generatePlanItems({ schoolId: numericSchoolId, planId: plan.id });
    }

    return this.getPlanById({ schoolId: numericSchoolId, planId: plan.id });
  }

  /**
   * Run the scheduling engine to populate/replace academic_plan_items
   */
  static async generatePlanItems({ schoolId, planId }) {
    const numericSchoolId = Number(schoolId);
    const plan = await this.getPlanById({ schoolId: numericSchoolId, planId, includeItems: false });
    if (!plan) throw new Error('Academic Plan not found');

    const schedule = await AcademicSchedulingService.generateSchedule({
      schoolId: numericSchoolId,
      academicYearId: plan.academic_year_id,
      termId: plan.term_id,
      classId: plan.class_id,
      sectionId: plan.section_id,
      subjectId: plan.subject_id,
      curriculumId: plan.curriculum_id,
      plannedStartDate: plan.planned_start_date,
      targetCompletionDate: plan.target_completion_date,
      revisionDays: plan.revision_days
    });

    return sql.begin(async (tx) => {
      // 1. Soft-delete any existing uncompleted items
      await tx`
        DELETE FROM academic_plan_items
        WHERE academic_plan_id = ${planId}
          AND school_id = ${numericSchoolId}
          AND status = 'NOT_STARTED'
      `;

      // 2. Insert generated items
      for (const item of schedule.items) {
        await tx`
          INSERT INTO academic_plan_items (
            school_id, academic_plan_id, curriculum_topic_id,
            planned_start_date, planned_end_date, planned_periods,
            sequence, priority, status
          ) VALUES (
            ${numericSchoolId}, ${planId}, ${item.curriculum_topic_id},
            ${item.planned_start_date}, ${item.planned_end_date}, ${item.planned_periods},
            ${item.sequence}, ${item.priority}, 'NOT_STARTED'
          )
        `;
      }

      // 3. Update plan planned_end_date
      await tx`
        UPDATE academic_plans
        SET 
          planned_end_date = ${schedule.planned_end_date},
          updated_at = now()
        WHERE id = ${planId} AND school_id = ${numericSchoolId}
      `;

      return schedule;
    });
  }

  /**
   * Update single plan item
   */
  static async updatePlanItem({ schoolId, planItemId, data }) {
    const numericSchoolId = Number(schoolId);
    const { planned_start_date, planned_end_date, planned_periods, priority, status } = data;

    const [updated] = await sql`
      UPDATE academic_plan_items
      SET
        planned_start_date = COALESCE(${planned_start_date}, planned_start_date),
        planned_end_date = COALESCE(${planned_end_date}, planned_end_date),
        planned_periods = COALESCE(${planned_periods}, planned_periods),
        priority = COALESCE(${priority}, priority),
        status = COALESCE(${status}, status),
        updated_at = now()
      WHERE id = ${planItemId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;

    return updated;
  }

  /**
   * Submit plan for approval
   */
  static async submitPlanForApproval({ schoolId, planId, submittedBy }) {
    const numericSchoolId = Number(schoolId);

    const [updated] = await sql`
      UPDATE academic_plans
      SET status = 'SUBMITTED', updated_at = now()
      WHERE id = ${planId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      RETURNING *
    `;

    return updated;
  }

  /**
   * Review plan (Approve / Request Revision / Reject)
   */
  static async reviewPlan({ schoolId, planId, reviewerId, action, remarks }) {
    const numericSchoolId = Number(schoolId);

    let nextStatus = 'APPROVED';
    if (action === 'REVISE' || action === 'REVISION_REQUIRED') nextStatus = 'REVISION_REQUIRED';
    if (action === 'REJECT') nextStatus = 'DRAFT';

    return sql.begin(async (tx) => {
      const [updatedPlan] = await tx`
        UPDATE academic_plans
        SET 
          status = ${nextStatus},
          approved_by = CASE WHEN ${nextStatus} = 'APPROVED' THEN ${reviewerId} ELSE approved_by END,
          approved_at = CASE WHEN ${nextStatus} = 'APPROVED' THEN now() ELSE approved_at END,
          updated_at = now()
        WHERE id = ${planId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
        RETURNING *
      `;

      await tx`
        INSERT INTO academic_plan_approvals (
          school_id, academic_plan_id, reviewer_id, status, remarks, reviewed_at
        ) VALUES (
          ${numericSchoolId}, ${planId}, ${reviewerId}, ${nextStatus}, ${remarks || null}, now()
        )
      `;

      return updatedPlan;
    });
  }

  /**
   * Teacher Handover: Transfer academic plan to a new teacher
   * Preserves full teaching history, logs handover audit
   */
  static async transferPlanTeacher({ schoolId, planId, newTeacherId, reason, transferredBy }) {
    const numericSchoolId = Number(schoolId);
    const plan = await this.getPlanById({ schoolId: numericSchoolId, planId, includeItems: false });
    if (!plan) throw new Error('Academic Plan not found');

    const previousTeacherId = plan.teacher_id;

    return sql.begin(async (tx) => {
      // 1. Update plan teacher
      const [updated] = await tx`
        UPDATE academic_plans
        SET teacher_id = ${newTeacherId}, updated_at = now()
        WHERE id = ${planId} AND school_id = ${numericSchoolId}
        RETURNING *
      `;

      // 2. Insert handover record
      await tx`
        INSERT INTO academic_teacher_handovers (
          school_id, academic_plan_id, previous_teacher_id, new_teacher_id,
          transfer_date, reason, transferred_by
        ) VALUES (
          ${numericSchoolId}, ${planId}, ${previousTeacherId}, ${newTeacherId},
          CURRENT_DATE, ${reason || null}, ${transferredBy || null}
        )
      `;

      return updated;
    });
  }
}

export default AcademicPlanService;
