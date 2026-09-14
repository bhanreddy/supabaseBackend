import sql from '../../db.js';
import { emitSchoolEvent, AUTOMATION_EVENTS } from '../automationEventService.js';
import { notifyInterventionAssigned } from './intelligenceNotificationService.js';

/**
 * Creates an intervention from a recommended action or custom teacher initiative.
 */
export async function createIntervention({ schoolId, userId, payload }) {
  const {
    student_id,
    insight_id = null,
    signal_id = null,
    action_type = 'TEACHER_REVIEW',
    title,
    description,
    start_date = new Date().toISOString().split('T')[0],
    target_date = null,
    follow_up_date = null,
    assigned_to = null,
    baseline_metric = {},
  } = payload;

  if (!student_id || !title?.trim()) {
    throw new Error('Student ID and title are required for an intervention');
  }

  const [intervention] = await sql`
    INSERT INTO public.student_interventions (
      school_id,
      student_id,
      insight_id,
      signal_id,
      action_type,
      title,
      description,
      start_date,
      target_date,
      follow_up_date,
      assigned_to,
      created_by,
      baseline_metric,
      status
    ) VALUES (
      ${schoolId},
      ${student_id},
      ${insight_id},
      ${signal_id},
      ${action_type},
      ${title.trim()},
      ${description || ''},
      ${start_date},
      ${target_date},
      ${follow_up_date},
      ${assigned_to || userId},
      ${userId},
      ${sql.json(baseline_metric)},
      'IN_PROGRESS'
    )
    RETURNING *
  `;

  // Update insight status if linked
  if (insight_id) {
    await sql`
      UPDATE public.intelligence_insights
      SET status = 'INTERVENTION_IN_PROGRESS', updated_at = now()
      WHERE id = ${insight_id}
    `;
  }

  // Update student intelligence profile active count
  await sql`
    UPDATE public.student_intelligence_profiles
    SET active_interventions_count = active_interventions_count + 1, updated_at = now()
    WHERE school_id = ${schoolId} AND student_id = ${student_id}
  `;

  await notifyInterventionAssigned({
    schoolId,
    assignedUserId: assigned_to || userId,
    title: intervention.title,
  });

  emitSchoolEvent(AUTOMATION_EVENTS.INTERVENTION_CREATED, {
    schoolId,
    studentId: student_id,
    interventionId: intervention.id,
  });

  return intervention;
}

/**
 * Record before vs after outcome measurement for an intervention.
 */
export async function recordInterventionOutcome({
  schoolId,
  interventionId,
  userId,
  outcomeStatus,
  outcomeNotes = '',
  afterMetric = {},
}) {
  const [intervention] = await sql`
    SELECT *
    FROM public.student_interventions
    WHERE school_id = ${schoolId}
      AND id = ${interventionId}
    LIMIT 1
  `;

  if (!intervention) throw new Error('Intervention not found');

  const [updated] = await sql`
    UPDATE public.student_interventions
    SET
      status = 'OUTCOME_RECORDED',
      outcome_status = ${outcomeStatus},
      outcome_notes = ${outcomeNotes},
      outcome_metric = ${sql.json(afterMetric)},
      completed_at = now(),
      updated_at = now()
    WHERE id = ${interventionId}
    RETURNING *
  `;

  // Log in anecdote_outcomes
  await sql`
    INSERT INTO public.anecdote_outcomes (
      school_id,
      intervention_id,
      before_metric,
      after_metric,
      outcome_status,
      notes,
      recorded_by
    ) VALUES (
      ${schoolId},
      ${interventionId},
      ${intervention.baseline_metric},
      ${sql.json(afterMetric)},
      ${outcomeStatus},
      ${outcomeNotes},
      ${userId}
    )
  `;

  // Update linked insight to RESOLVED if effective
  if (intervention.insight_id && outcomeStatus === 'EFFECTIVE') {
    await sql`
      UPDATE public.intelligence_insights
      SET status = 'RESOLVED', updated_at = now()
      WHERE id = ${intervention.insight_id}
    `;
  }

  emitSchoolEvent(AUTOMATION_EVENTS.INTERVENTION_COMPLETED, {
    schoolId,
    studentId: intervention.student_id,
    interventionId: interventionId,
  });

  return updated;
}

export async function updateInterventionStatus({ schoolId, interventionId, userId, status }) {
  const allowed = ['RECOMMENDED', 'ACCEPTED', 'IN_PROGRESS', 'FOLLOW_UP', 'COMPLETED', 'OUTCOME_RECORDED', 'CANCELLED'];
  if (!allowed.includes(status)) {
    throw new Error('Invalid intervention status');
  }

  const [updated] = await sql`
    UPDATE public.student_interventions
    SET
      status = ${status},
      updated_at = now(),
      completed_at = CASE WHEN ${status} IN ('COMPLETED', 'OUTCOME_RECORDED') THEN now() ELSE completed_at END
    WHERE school_id = ${schoolId}
      AND id = ${interventionId}
    RETURNING *
  `;

  if (!updated) throw new Error('Intervention not found');
  return updated;
}

/**
 * List interventions for authorized staff/admin.
 */
export async function getInterventions({
  schoolId,
  studentId = null,
  classSectionId = null,
  status = null,
  page = 1,
  limit = 20,
}) {
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (safePage - 1) * safeLimit;

  const conditions = [sql`i.school_id = ${schoolId}`];
  if (studentId) conditions.push(sql`i.student_id = ${studentId}`);
  if (status) conditions.push(sql`i.status = ${status}`);

  if (classSectionId) {
    conditions.push(sql`
      EXISTS (
        SELECT 1 FROM public.student_enrollments se
        WHERE se.student_id = i.student_id
          AND se.class_section_id = ${classSectionId}
          AND se.status = 'active'
          AND se.deleted_at IS NULL
      )
    `);
  }

  const whereClause = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  const [countResult] = await sql`
    SELECT count(*)::int AS total
    FROM public.student_interventions i
    WHERE ${whereClause}
  `;

  const rows = await sql`
    SELECT
      i.*,
      p_student.display_name AS student_name,
      p_student.photo_url AS student_photo_url,
      s.admission_no,
      p_creator.display_name AS creator_name,
      p_assigned.display_name AS assigned_to_name
    FROM public.student_interventions i
    JOIN public.students s ON s.id = i.student_id
    JOIN public.persons p_student ON p_student.id = s.person_id
    JOIN public.users u_creator ON u_creator.id = i.created_by
    LEFT JOIN public.persons p_creator ON p_creator.id = u_creator.person_id
    LEFT JOIN public.users u_assigned ON u_assigned.id = i.assigned_to
    LEFT JOIN public.persons p_assigned ON p_assigned.id = u_assigned.person_id
    WHERE ${whereClause}
    ORDER BY i.created_at DESC
    LIMIT ${safeLimit} OFFSET ${offset}
  `;

  return {
    items: rows,
    total: countResult?.total || 0,
    page: safePage,
    limit: safeLimit,
  };
}
