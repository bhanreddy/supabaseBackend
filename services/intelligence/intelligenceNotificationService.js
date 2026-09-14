import sql from '../../db.js';
import logger from '../../utils/logger.js';
import { sendNotificationToUsers } from '../notificationService.js';

async function classTeacherUserIds({ schoolId, studentId }) {
  return sql`
    SELECT DISTINCT u.id
    FROM public.student_enrollments se
    JOIN public.class_sections cs ON cs.id = se.class_section_id
    JOIN public.staff st ON st.id = cs.class_teacher_id
    JOIN public.users u ON u.person_id = st.person_id AND u.school_id = ${schoolId}
    WHERE se.school_id = ${schoolId}
      AND se.student_id = ${studentId}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND u.deleted_at IS NULL
  `;
}

export async function notifyAttentionInsight({ schoolId, studentId, insight }) {
  try {
    const teachers = await classTeacherUserIds({ schoolId, studentId });
    const userIds = teachers.map((row) => row.id).filter(Boolean);
    if (userIds.length === 0) return;

    await sendNotificationToUsers(
      userIds,
      'INTELLIGENCE_PATTERN_DETECTED',
      { message: insight?.title || 'A student pattern is ready for staff review.' },
      { schoolId, deepLink: '/staff/student-intelligence' }
    );
  } catch (err) {
    logger.warn({ err: err.message, schoolId, studentId }, 'Failed to notify staff of intelligence pattern');
  }
}

export async function notifyFollowUpAssigned({ schoolId, assignedUserId, dueDate }) {
  if (!assignedUserId) return;
  try {
    await sendNotificationToUsers(
      [assignedUserId],
      'ANECDOTE_FOLLOWUP_DUE',
      { message: dueDate ? `A follow-up is scheduled for ${dueDate}.` : 'A follow-up has been scheduled.' },
      { schoolId, deepLink: '/staff/anecdotes' }
    );
  } catch (err) {
    logger.warn({ err: err.message, schoolId, assignedUserId }, 'Failed to notify follow-up assignee');
  }
}

export async function notifyInterventionAssigned({ schoolId, assignedUserId, title }) {
  if (!assignedUserId) return;
  try {
    await sendNotificationToUsers(
      [assignedUserId],
      'INTERVENTION_REVIEW_DUE',
      { message: title ? `An intervention was recorded: ${title}.` : 'An intervention is ready for review.' },
      { schoolId, deepLink: '/staff/student-intelligence' }
    );
  } catch (err) {
    logger.warn({ err: err.message, schoolId, assignedUserId }, 'Failed to notify intervention assignee');
  }
}
