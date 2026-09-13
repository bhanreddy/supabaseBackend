import sql from '../db.js';
import { formatYMD, getWeekdayName } from './workingDayResolver.js';
import AcademicAnalyticsService from './academicAnalyticsService.js';

/**
 * Service for Teacher Daily Execution ("Academic Today")
 * Handles 1-tap progress recording, event logging, substitute teacher mode,
 * and automatic timetable/diary linking.
 */
class AcademicProgressService {
  /**
   * Get teacher's current class & academic topic for today
   *
   * @param {Object} params
   * @param {number|string} params.schoolId
   * @param {string} params.teacherId - Staff ID of the teacher
   * @param {string} [params.date] - YYYY-MM-DD (defaults to today)
   * @param {string} [params.time] - HH:MM (defaults to now)
   */
  static async getTodayExecution({ schoolId, teacherId, date, time }) {
    const numericSchoolId = Number(schoolId);
    const targetDate = date ? formatYMD(date) : formatYMD(new Date());
    const dayOfWeek = getWeekdayName(targetDate);

    // 1. Check if teacher is assigned to any timetable slots today (as regular teacher or substitute)
    // First, check for substitute assignments today
    const substitutionSlots = await sql`
      SELECT 
        ts.*,
        cl.id AS class_id,
        cl.name AS class_name,
        sec.id AS section_id,
        sec.name AS section_name,
        s.id AS subject_id,
        s.name AS subject_name,
        sub.reason AS substitution_reason,
        true AS is_substitute
      FROM timetable_substitutions sub
      JOIN timetable_slots ts ON sub.timetable_slot_id = ts.id
      JOIN class_sections cs ON ts.class_section_id = cs.id
      JOIN classes cl ON cs.class_id = cl.id
      JOIN sections sec ON cs.section_id = sec.id
      JOIN subjects s ON ts.subject_id = s.id
      WHERE sub.school_id = ${numericSchoolId}
        AND sub.substitution_date = ${targetDate}
        AND sub.substitute_teacher_id = ${teacherId}
        AND sub.cancelled_at IS NULL
    `;

    // Second, regular timetable slots for this teacher today (excluding any where they are marked absent)
    const regularSlots = await sql`
      SELECT 
        ts.*,
        cl.id AS class_id,
        cl.name AS class_name,
        sec.id AS section_id,
        sec.name AS section_name,
        s.id AS subject_id,
        s.name AS subject_name,
        null AS substitution_reason,
        false AS is_substitute
      FROM timetable_slots ts
      JOIN class_sections cs ON ts.class_section_id = cs.id
      JOIN classes cl ON cs.class_id = cl.id
      JOIN sections sec ON cs.section_id = sec.id
      JOIN subjects s ON ts.subject_id = s.id
      WHERE ts.school_id = ${numericSchoolId}
        AND ts.teacher_id = ${teacherId}
        AND ts.day_of_week = ${dayOfWeek}
        AND ts.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM timetable_substitutions sub
          WHERE sub.timetable_slot_id = ts.id
            AND sub.substitution_date = ${targetDate}
            AND sub.cancelled_at IS NULL
        )
      ORDER BY ts.period_number ASC
    `;

    const allTodaySlots = [...substitutionSlots, ...regularSlots].sort((a, b) => a.period_number - b.period_number);

    // If no slots today, teacher has no classes scheduled
    if (allTodaySlots.length === 0) {
      // Return list of all teacher's active academic plans for manual selection
      const activePlans = await sql`
        SELECT 
          p.id AS academic_plan_id,
          p.class_id, p.section_id, p.subject_id,
          cl.name AS class_name,
          sec.name AS section_name,
          s.name AS subject_name,
          m.actual_progress,
          m.health_status
        FROM academic_plans p
        JOIN classes cl ON p.class_id = cl.id
        JOIN sections sec ON p.section_id = sec.id
        JOIN subjects s ON p.subject_id = s.id
        LEFT JOIN academic_plan_metrics m ON m.academic_plan_id = p.id
        WHERE p.school_id = ${numericSchoolId}
          AND p.teacher_id = ${teacherId}
          AND p.status IN ('ACTIVE', 'APPROVED')
          AND p.deleted_at IS NULL
      `;

      return {
        has_classes_today: false,
        date: targetDate,
        day_of_week: dayOfWeek,
        current_period: null,
        scheduled_slots: [],
        assigned_plans: activePlans
      };
    }

    // Determine current/next slot based on time
    const nowTime = time || new Date().toTimeString().slice(0, 5); // "HH:MM"
    let activeSlot = allTodaySlots.find(s => nowTime >= s.start_time.slice(0, 5) && nowTime <= s.end_time.slice(0, 5));
    if (!activeSlot) {
      // Find the upcoming slot today, or default to the first slot
      activeSlot = allTodaySlots.find(s => nowTime < s.start_time.slice(0, 5)) || allTodaySlots[0];
    }

    // Fetch plan details for activeSlot
    const activeSlotExecution = await this.getSlotExecutionDetails({
      schoolId: numericSchoolId,
      classId: activeSlot.class_id,
      sectionId: activeSlot.section_id,
      subjectId: activeSlot.subject_id,
      teacherId
    });

    // Also enrich all slots with their topic title
    const enrichedSlots = await Promise.all(
      allTodaySlots.map(async (slot) => {
        const details = await this.getSlotExecutionDetails({
          schoolId: numericSchoolId,
          classId: slot.class_id,
          sectionId: slot.section_id,
          subjectId: slot.subject_id,
          teacherId
        });
        return {
          ...slot,
          current_topic: details.current_topic,
          plan_id: details.plan_id
        };
      })
    );

    return {
      has_classes_today: true,
      date: targetDate,
      day_of_week: dayOfWeek,
      current_slot: {
        ...activeSlot,
        ...activeSlotExecution
      },
      scheduled_slots: enrichedSlots
    };
  }

  /**
   * Helper to retrieve active chapter, current topic, and last completed topic for a plan
   */
  static async getSlotExecutionDetails({ schoolId, classId, sectionId, subjectId, teacherId }) {
    const numericSchoolId = Number(schoolId);

    // Find active academic plan
    const [plan] = await sql`
      SELECT p.id, p.curriculum_id, p.status, m.actual_progress, m.expected_progress, m.health_status
      FROM academic_plans p
      LEFT JOIN academic_plan_metrics m ON m.academic_plan_id = p.id
      WHERE p.school_id = ${numericSchoolId}
        AND p.class_id = ${classId}
        AND p.section_id = ${sectionId}
        AND p.subject_id = ${subjectId}
        AND p.deleted_at IS NULL
      LIMIT 1
    `;

    if (!plan) {
      return {
        plan_id: null,
        current_topic: null,
        last_completed_topic: null,
        lesson_plan: null,
        actual_progress: 0,
        health_status: 'ON_TRACK'
      };
    }

    // Current topic: First item that is IN_PROGRESS or NOT_STARTED
    const [currentTopic] = await sql`
      SELECT 
        i.id AS plan_item_id,
        i.sequence AS item_sequence,
        i.planned_periods,
        i.actual_periods_consumed,
        i.status AS item_status,
        tp.id AS topic_id,
        tp.title AS topic_title,
        tp.sequence AS topic_sequence,
        ch.id AS chapter_id,
        ch.title AS chapter_title,
        ch.sequence AS chapter_sequence,
        u.title AS unit_title
      FROM academic_plan_items i
      JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
      JOIN curriculum_chapters ch ON tp.chapter_id = ch.id
      LEFT JOIN curriculum_units u ON ch.unit_id = u.id
      WHERE i.academic_plan_id = ${plan.id}
        AND i.school_id = ${numericSchoolId}
        AND i.status IN ('IN_PROGRESS', 'PARTIALLY_COMPLETED', 'NOT_STARTED')
        AND i.deleted_at IS NULL
      ORDER BY 
        CASE i.status
          WHEN 'IN_PROGRESS' THEN 1
          WHEN 'PARTIALLY_COMPLETED' THEN 2
          WHEN 'NOT_STARTED' THEN 3
          ELSE 4
        END,
        i.sequence ASC
      LIMIT 1
    `;

    // Last completed topic
    const [lastCompleted] = await sql`
      SELECT 
        i.id AS plan_item_id,
        i.completed_at,
        tp.title AS topic_title,
        ch.title AS chapter_title
      FROM academic_plan_items i
      JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
      JOIN curriculum_chapters ch ON tp.chapter_id = ch.id
      WHERE i.academic_plan_id = ${plan.id}
        AND i.school_id = ${numericSchoolId}
        AND i.status = 'COMPLETED'
        AND i.deleted_at IS NULL
      ORDER BY i.completed_at DESC NULLS LAST, i.sequence DESC
      LIMIT 1
    `;

    // Optional lesson plan for current topic
    let lessonPlan = null;
    if (currentTopic) {
      const [lp] = await sql`
        SELECT *
        FROM lesson_plans
        WHERE academic_plan_item_id = ${currentTopic.plan_item_id}
          AND school_id = ${numericSchoolId}
        LIMIT 1
      `;
      lessonPlan = lp || null;
    }

    return {
      plan_id: plan.id,
      current_topic: currentTopic || null,
      last_completed_topic: lastCompleted || null,
      lesson_plan: lessonPlan,
      actual_progress: plan.actual_progress || 0,
      health_status: plan.health_status || 'ON_TRACK'
    };
  }

  /**
   * One-Tap Teacher Progress Update
   *
   * @param {Object} params
   * @param {number|string} params.schoolId
   * @param {string} params.planId
   * @param {string} params.planItemId
   * @param {string} params.teacherId
   * @param {string} [params.date] - YYYY-MM-DD
   * @param {'COMPLETED'|'PARTIALLY_COMPLETED'|'CONTINUE_NEXT_PERIOD'|'SKIPPED'} params.status
   * @param {number} [params.completionPercentage]
   * @param {number} [params.periodsConsumed=1]
   * @param {string} [params.notes]
   * @param {string} [params.source='ACADEMIC_APP']
   */
  static async recordProgress({
    schoolId,
    planId,
    planItemId,
    teacherId,
    date,
    status,
    completionPercentage,
    periodsConsumed = 1.0,
    notes,
    source = 'ACADEMIC_APP'
  }) {
    const numericSchoolId = Number(schoolId);
    const eventDate = date ? formatYMD(date) : formatYMD(new Date());

    const [plan] = await sql`
      SELECT class_id, section_id, subject_id
      FROM academic_plans
      WHERE id = ${planId} AND school_id = ${numericSchoolId}
    `;
    if (!plan) throw new Error('Academic Plan not found');

    const [item] = await sql`
      SELECT id, planned_periods, actual_periods_consumed, sequence
      FROM academic_plan_items
      WHERE id = ${planItemId} AND academic_plan_id = ${planId} AND school_id = ${numericSchoolId}
    `;
    if (!item) throw new Error('Academic Plan Item not found');

    const effectivePct = status === 'COMPLETED' ? 100.0 : (completionPercentage || (status === 'PARTIALLY_COMPLETED' ? 50.0 : 0.0));

    return sql.begin(async (tx) => {
      // 1. Insert immutable execution event
      const [event] = await tx`
        INSERT INTO academic_progress_events (
          school_id, academic_plan_id, academic_plan_item_id, teacher_id,
          class_id, section_id, subject_id, date, status,
          completion_percentage, periods_consumed, notes, source
        ) VALUES (
          ${numericSchoolId}, ${planId}, ${planItemId}, ${teacherId || null},
          ${plan.class_id}, ${plan.section_id}, ${plan.subject_id},
          ${eventDate}, ${status}, ${effectivePct}, ${periodsConsumed},
          ${notes || null}, ${source}
        )
        RETURNING *
      `;

      // 2. Update item status according to action
      const newPeriodsConsumed = Number(item.actual_periods_consumed || 0) + Number(periodsConsumed);

      if (status === 'COMPLETED') {
        await tx`
          UPDATE academic_plan_items
          SET 
            status = 'COMPLETED',
            actual_periods_consumed = ${newPeriodsConsumed},
            completed_at = ${eventDate},
            updated_at = now()
          WHERE id = ${planItemId} AND school_id = ${numericSchoolId}
        `;
      } else if (status === 'PARTIALLY_COMPLETED') {
        await tx`
          UPDATE academic_plan_items
          SET 
            status = 'PARTIALLY_COMPLETED',
            actual_periods_consumed = ${newPeriodsConsumed},
            updated_at = now()
          WHERE id = ${planItemId} AND school_id = ${numericSchoolId}
        `;
      } else if (status === 'CONTINUE_NEXT_PERIOD') {
        // Keeps topic active and applies soft forward shift on future unstarted items
        await tx`
          UPDATE academic_plan_items
          SET 
            status = 'IN_PROGRESS',
            actual_periods_consumed = ${newPeriodsConsumed},
            updated_at = now()
          WHERE id = ${planItemId} AND school_id = ${numericSchoolId}
        `;

        // Soft shift subsequent items by 1 day if they were scheduled on or before today
        await tx`
          UPDATE academic_plan_items
          SET
            planned_start_date = planned_start_date + INTERVAL '1 day',
            planned_end_date = planned_end_date + INTERVAL '1 day',
            updated_at = now()
          WHERE academic_plan_id = ${planId}
            AND school_id = ${numericSchoolId}
            AND sequence > ${item.sequence}
            AND status = 'NOT_STARTED'
            AND planned_start_date <= ${eventDate}::date
        `;
      } else if (status === 'SKIPPED') {
        await tx`
          UPDATE academic_plan_items
          SET 
            status = 'SKIPPED',
            updated_at = now()
          WHERE id = ${planItemId} AND school_id = ${numericSchoolId}
        `;
      }

      // 3. Trigger recalculation of cached metrics
      // Run recalculation inside or immediately after transaction
      await AcademicAnalyticsService.recalculatePlanMetrics({
        schoolId: numericSchoolId,
        planId,
        dbClient: tx
      });

      return event;
    });
  }

  /**
   * Fetch topic details for linking to diary/homework entry
   */
  static async getDiaryTopicDetails({ schoolId, planItemId }) {
    const numericSchoolId = Number(schoolId);
    const [row] = await sql`
      SELECT 
        i.id AS plan_item_id,
        tp.id AS topic_id,
        tp.title AS topic_title,
        ch.id AS chapter_id,
        ch.title AS chapter_title,
        cl.name AS class_name,
        s.name AS subject_name
      FROM academic_plan_items i
      JOIN academic_plans p ON i.academic_plan_id = p.id
      JOIN classes cl ON p.class_id = cl.id
      JOIN subjects s ON p.subject_id = s.id
      JOIN curriculum_topics tp ON i.curriculum_topic_id = tp.id
      JOIN curriculum_chapters ch ON tp.chapter_id = ch.id
      WHERE i.id = ${planItemId} AND i.school_id = ${numericSchoolId}
    `;
    return row || null;
  }
}

export default AcademicProgressService;
