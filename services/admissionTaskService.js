import sql from '../db.js';

/**
 * Create an operational task for staff.
 */
export async function createAdmissionTask(schoolId, {
  applicationId,
  title,
  description = '',
  taskType,
  assignedRole = 'staff',
  assignedTo = null,
  dueHours = 24,
}) {
  const dueAt = new Date(Date.now() + dueHours * 60 * 60 * 1000);

  const [task] = await sql`
    INSERT INTO admission_tasks (
      school_id, application_id, title, description, task_type,
      assigned_role, assigned_to, status, due_at
    )
    VALUES (
      ${schoolId}, ${applicationId}, ${title}, ${description}, ${taskType},
      ${assignedRole}, ${assignedTo}, 'PENDING', ${dueAt}
    )
    RETURNING *
  `;

  return task;
}

/**
 * List operational tasks for school staff.
 */
export async function getAdmissionTasks(schoolId, {
  status = null,
  assignedTo = null,
  applicationId = null,
  isSlaBreached = null,
  limit = 50,
} = {}) {
  return await sql`
    SELECT t.*, a.application_no, a.student_first_name, a.student_last_name,
           p.display_name as assigned_user_name
    FROM admission_tasks t
    JOIN admission_applications a ON t.application_id = a.id
    LEFT JOIN users u ON t.assigned_to = u.id
    LEFT JOIN persons p ON u.person_id = p.id
    WHERE t.school_id = ${schoolId}
      ${status ? sql`AND t.status = ${status}` : sql``}
      ${assignedTo ? sql`AND t.assigned_to = ${assignedTo}` : sql``}
      ${applicationId ? sql`AND t.application_id = ${applicationId}` : sql``}
      ${isSlaBreached !== null ? sql`AND t.is_sla_breached = ${isSlaBreached}` : sql``}
    ORDER BY t.is_sla_breached DESC, t.due_at ASC
    LIMIT ${limit}
  `;
}

/**
 * Mark a task as completed.
 */
export async function completeAdmissionTask(schoolId, taskId, completedByUserId) {
  const [task] = await sql`
    UPDATE admission_tasks
    SET status = 'COMPLETED',
        completed_at = now(),
        completed_by = ${completedByUserId},
        updated_at = now()
    WHERE id = ${taskId} AND school_id = ${schoolId}
    RETURNING *
  `;

  return task;
}

/**
 * Check and flag SLA breaches across pending tasks and applications.
 */
export async function scanAndFlagSlaBreaches(schoolId) {
  // Flag tasks overdue
  const breachedTasks = await sql`
    UPDATE admission_tasks
    SET is_sla_breached = true,
        updated_at = now()
    WHERE school_id = ${schoolId}
      AND status IN ('PENDING', 'IN_PROGRESS')
      AND due_at < now()
      AND is_sla_breached = false
    RETURNING id, application_id, title, due_at
  `;

  // Flag applications overdue
  const breachedApps = await sql`
    UPDATE admission_applications
    SET is_sla_breached = true,
        updated_at = now()
    WHERE school_id = ${schoolId}
      AND status NOT IN ('CONVERTED_TO_STUDENT', 'REJECTED', 'WITHDRAWN')
      AND sla_due_at < now()
      AND is_sla_breached = false
    RETURNING id, application_no, sla_due_at
  `;

  return {
    breachedTasksCount: breachedTasks.length,
    breachedAppsCount: breachedApps.length,
    breachedTasks,
    breachedApps,
  };
}
