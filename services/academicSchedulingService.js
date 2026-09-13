import sql from '../db.js';
import { resolveSchoolDay, formatYMD, getWeekdayName } from './workingDayResolver.js';
import { allocateTopicsToSlots } from './academicPlannerMath.js';

/**
 * Academic Scheduling Service
 * Calculates timetable capacity, working days, and allocates curriculum topics
 * sequentially across instructional calendar slots.
 */
class AcademicSchedulingService {
  /**
   * Calculate timetable capacity for a given class, section, and subject
   * Returns: { weeklyPeriods, timetableDays: Set<string>, periodDetails }
   */
  static async getTimetableCapacity({ schoolId, academicYearId, classSectionId, subjectId }) {
    const numericSchoolId = Number(schoolId);

    const slots = await sql`
      SELECT 
        id, day_of_week, period_number, start_time, end_time, room_no
      FROM timetable_slots
      WHERE school_id = ${numericSchoolId}
        AND academic_year_id = ${academicYearId}
        AND class_section_id = ${classSectionId}
        AND subject_id = ${subjectId}
        AND deleted_at IS NULL
      ORDER BY 
        CASE day_of_week
          WHEN 'monday' THEN 1
          WHEN 'tuesday' THEN 2
          WHEN 'wednesday' THEN 3
          WHEN 'thursday' THEN 4
          WHEN 'friday' THEN 5
          WHEN 'saturday' THEN 6
          WHEN 'sunday' THEN 7
          ELSE 8
        END,
        period_number ASC
    `;

    const dayCounts = {};
    slots.forEach(s => {
      const day = s.day_of_week.toLowerCase();
      dayCounts[day] = (dayCounts[day] || 0) + 1;
    });

    return {
      weeklyPeriods: slots.length,
      slotsByDay: dayCounts,
      slots
    };
  }

  /**
   * Resolve class_section_id given classId and sectionId
   */
  static async resolveClassSectionId(schoolId, academicYearId, classId, sectionId) {
    const numericSchoolId = Number(schoolId);
    const [cs] = await sql`
      SELECT id FROM class_sections
      WHERE school_id = ${numericSchoolId}
        AND academic_year_id = ${academicYearId}
        AND class_id = ${classId}
        AND section_id = ${sectionId}
        AND deleted_at IS NULL
    `;
    return cs?.id || null;
  }

  /**
   * Auto-generate an Academic Execution Schedule
   *
   * @param {Object} params
   * @param {number|string} params.schoolId
   * @param {string} params.academicYearId
   * @param {string} [params.termId]
   * @param {string} params.classId
   * @param {string} params.sectionId
   * @param {string} params.subjectId
   * @param {string} params.curriculumId
   * @param {string} [params.plannedStartDate]
   * @param {string} [params.targetCompletionDate]
   * @param {number} [params.revisionDays=15]
   */
  static async generateSchedule({
    schoolId,
    academicYearId,
    termId,
    classId,
    sectionId,
    subjectId,
    curriculumId,
    plannedStartDate,
    targetCompletionDate,
    revisionDays = 15
  }) {
    const numericSchoolId = Number(schoolId);

    // 1. Fetch Academic Year and Term boundaries if not provided
    const [ay] = await sql`
      SELECT start_date, end_date FROM academic_years
      WHERE id = ${academicYearId} AND school_id = ${numericSchoolId}
    `;
    if (!ay) throw new Error('Academic Year not found');

    let startDate = plannedStartDate ? formatYMD(plannedStartDate) : formatYMD(ay.start_date);
    let targetDate = targetCompletionDate ? formatYMD(targetCompletionDate) : null;

    if (!targetDate && termId) {
      const [term] = await sql`
        SELECT start_date, end_date FROM academic_terms
        WHERE id = ${termId} AND school_id = ${numericSchoolId}
      `;
      if (term) {
        if (!plannedStartDate) startDate = formatYMD(term.start_date);
        targetDate = formatYMD(term.end_date);
      }
    }

    if (!targetDate) {
      // Default to 3 weeks before academic year end to preserve revision window
      const ayEnd = new Date(ay.end_date);
      ayEnd.setDate(ayEnd.getDate() - (revisionDays || 15));
      targetDate = formatYMD(ayEnd);
    }

    // 2. Resolve class_section_id
    const classSectionId = await this.resolveClassSectionId(numericSchoolId, academicYearId, classId, sectionId);
    if (!classSectionId) {
      throw new Error('Class section mapping not found for this academic year');
    }

    // 3. Get timetable capacity
    const capacity = await this.getTimetableCapacity({
      schoolId: numericSchoolId,
      academicYearId,
      classSectionId,
      subjectId
    });

    const weeklyPeriods = capacity.weeklyPeriods || 0;
    // Fallback: If no timetable configured yet, default to standard 5 periods/week (Mon-Fri)
    const fallbackDayCounts = { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1 };
    const effectiveDayCounts = weeklyPeriods > 0 ? capacity.slotsByDay : fallbackDayCounts;
    const effectiveWeeklyPeriods = weeklyPeriods > 0 ? weeklyPeriods : 5;

    // 4. Fetch curriculum chapters and topics in order
    const chapters = await sql`
      SELECT id, title, sequence, estimated_periods, weight
      FROM curriculum_chapters
      WHERE curriculum_id = ${curriculumId} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
      ORDER BY sequence ASC, created_at ASC
    `;

    const chapterIds = chapters.map(c => c.id);
    let topics = [];
    if (chapterIds.length > 0) {
      topics = await sql`
        SELECT 
          id, chapter_id, title, sequence, estimated_periods, weight, is_optional
        FROM curriculum_topics
        WHERE chapter_id IN ${sql(chapterIds)} AND school_id = ${numericSchoolId} AND deleted_at IS NULL
        ORDER BY sequence ASC, created_at ASC
      `;
    }

    // Sort topics according to chapter sequence then topic sequence
    const chapterSeqMap = new Map(chapters.map(c => [c.id, c.sequence]));
    topics.sort((a, b) => {
      const chDiff = (chapterSeqMap.get(a.chapter_id) || 0) - (chapterSeqMap.get(b.chapter_id) || 0);
      if (chDiff !== 0) return chDiff;
      return a.sequence - b.sequence;
    });

    if (topics.length === 0) {
      throw new Error('Curriculum contains no topics to schedule');
    }

    // 5. Expand calendar slots from startDate onward
    // Collect available teaching period slots date by date
    const availableSlots = [];
    const currDate = new Date(startDate);
    const maxDate = new Date(ay.end_date); // Hard stop at end of academic year
    // Safety buffer: maximum 365 iterations
    let iterations = 0;

    while (currDate <= maxDate && iterations < 365) {
      iterations++;
      const dateStr = formatYMD(currDate);
      const dayResolution = await resolveSchoolDay(numericSchoolId, dateStr);

      if (dayResolution.isWorkingDay) {
        const timetableDay = (dayResolution.timetableDay || getWeekdayName(dateStr)).toLowerCase();
        const periodsOnDay = effectiveDayCounts[timetableDay] || 0;

        for (let p = 0; p < periodsOnDay; p++) {
          availableSlots.push({
            date: dateStr,
            dayOfWeek: dayResolution.dayOfWeek,
            timetableDay
          });
        }
      }

      // Increment by 1 day
      currDate.setDate(currDate.getDate() + 1);
    }

    const { scheduledItems, totalEstimatedPeriods } = allocateTopicsToSlots(
      topics,
      availableSlots,
      startDate
    );

    const finalTopicEndDate = scheduledItems[scheduledItems.length - 1]?.planned_end_date || targetDate;
    const isOverTarget = new Date(finalTopicEndDate) > new Date(targetDate);
    const delayDays = isOverTarget
      ? Math.round((new Date(finalTopicEndDate) - new Date(targetDate)) / (1000 * 60 * 60 * 24))
      : 0;

    return {
      planned_start_date: startDate,
      planned_end_date: finalTopicEndDate,
      target_completion_date: targetDate,
      revision_days: revisionDays,
      weekly_periods: effectiveWeeklyPeriods,
      total_topics: topics.length,
      total_estimated_periods: totalEstimatedPeriods,
      available_slots_count: availableSlots.length,
      projected_delay_days: delayDays,
      is_on_track: delayDays <= 0,
      items: scheduledItems
    };
  }

  static allocateTopicsToSlots(topics, availableSlots, fallbackStartDate) {
    return allocateTopicsToSlots(topics, availableSlots, fallbackStartDate);
  }
}

export default AcademicSchedulingService;
