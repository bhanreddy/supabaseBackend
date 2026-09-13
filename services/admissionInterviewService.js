import sql from '../db.js';
import { WORKFLOW_STATUSES, transitionApplicationStage } from './admissionWorkflowService.js';

/**
 * Schedule an interaction, interview, or entrance test for an admission applicant.
 */
export async function scheduleInterview(schoolId, applicationId, {
  interviewType = 'INTERVIEW', // INTERVIEW, ENTRANCE_TEST, INTERACTION
  title = 'Applicant Interaction',
  scheduledDate,
  startTime,
  endTime,
  location = 'Principal Office',
  mode = 'OFFLINE',
  onlineMeetingUrl = null,
  interviewerId = null,
}) {
  const [interview] = await sql`
    INSERT INTO admission_interviews (
      school_id, application_id, interview_type, title,
      scheduled_date, start_time, end_time, location, mode,
      online_meeting_url, interviewer_id, status
    )
    VALUES (
      ${schoolId}, ${applicationId}, ${interviewType}, ${title},
      ${scheduledDate}, ${startTime}, ${endTime}, ${location}, ${mode},
      ${onlineMeetingUrl}, ${interviewerId}, 'SCHEDULED'
    )
    RETURNING *
  `;

  const nextStatus = interviewType === 'ENTRANCE_TEST'
    ? WORKFLOW_STATUSES.TEST_SCHEDULED
    : WORKFLOW_STATUSES.INTERVIEW_SCHEDULED;

  try {
    await transitionApplicationStage(schoolId, applicationId, nextStatus, {
      actorId: interviewerId,
      actorRole: 'staff',
      remarks: `${title} scheduled for ${scheduledDate} ${startTime}`,
    });
  } catch (err) {
    if (!/Invalid stage transition/i.test(err.message || '')) {
      throw err;
    }
    await sql`
      UPDATE admission_applications
      SET status = ${nextStatus}, updated_at = now()
      WHERE id = ${applicationId} AND school_id = ${schoolId}
        AND status IN (${nextStatus}, 'DOCUMENT_VERIFICATION', 'VERIFICATION_COMPLETED', 'APPLICATION_UNDER_REVIEW', 'TEST_COMPLETED', 'INTERVIEW_COMPLETED')
    `;
  }

  return interview;
}

/**
 * Record structured rubric evaluation and recommendation for an interview.
 */
export async function evaluateInterview(schoolId, interviewId, {
  rubricScores = {},
  recommendation = 'REVIEW_FURTHER', // APPROVE, WAITLIST, REJECT, REVIEW_FURTHER
  feedback = '',
  evaluatedByUserId = null,
}) {
  // Compute total score from rubric components (1-5 each)
  const scores = [
    Number(rubricScores.communication || 0),
    Number(rubricScores.confidence || 0),
    Number(rubricScores.academic_readiness || 0),
    Number(rubricScores.behaviour || 0),
  ];
  const validScores = scores.filter((s) => s > 0);
  const totalScore = validScores.length > 0
    ? (validScores.reduce((a, b) => a + b, 0) / (validScores.length * 5)) * 100
    : 0;

  const [interview] = await sql`
    UPDATE admission_interviews
    SET rubric_scores = ${sql.json(rubricScores)},
        total_score = ${totalScore},
        recommendation = ${recommendation},
        feedback = ${feedback},
        status = 'COMPLETED',
        updated_at = now()
    WHERE id = ${interviewId} AND school_id = ${schoolId}
    RETURNING *
  `;

  if (!interview) {
    throw new Error('Interview not found');
  }

  const nextStatus = interview.interview_type === 'ENTRANCE_TEST'
    ? WORKFLOW_STATUSES.TEST_COMPLETED
    : WORKFLOW_STATUSES.INTERVIEW_COMPLETED;

  try {
    await transitionApplicationStage(schoolId, interview.application_id, nextStatus, {
      actorId: evaluatedByUserId,
      actorRole: 'interviewer',
      remarks: `Evaluation completed with recommendation: ${recommendation}`,
    });
  } catch (err) {
    if (!/Invalid stage transition/i.test(err.message || '')) {
      throw err;
    }
  }

  await sql`
    UPDATE admission_applications
    SET total_score = ${totalScore},
        updated_at = now()
    WHERE id = ${interview.application_id} AND school_id = ${schoolId}
  `;

  // Record audit entry
  await sql`
    INSERT INTO admission_audit_logs (
      school_id, application_id, actor_id, actor_role, action,
      reason, details
    )
    VALUES (
      ${schoolId}, ${interview.application_id}, ${evaluatedByUserId}, 'interviewer',
      'INTERVIEW_EVALUATED',
      ${'Evaluation completed with recommendation: ' + recommendation},
      ${sql.json({ interview_id: interviewId, total_score: totalScore, rubricScores })}
    )
  `;

  return interview;
}

/**
 * Get scheduled interviews for an application or across the school.
 */
export async function getInterviews(schoolId, {
  applicationId = null,
  scheduledDate = null,
  status = null,
} = {}) {
  return await sql`
    SELECT i.*, a.application_no, a.student_first_name, a.student_last_name,
           p.display_name as interviewer_name
    FROM admission_interviews i
    JOIN admission_applications a ON i.application_id = a.id
    LEFT JOIN users u ON i.interviewer_id = u.id
    LEFT JOIN persons p ON u.person_id = p.id
    WHERE i.school_id = ${schoolId}
      ${applicationId ? sql`AND i.application_id = ${applicationId}` : sql``}
      ${scheduledDate ? sql`AND i.scheduled_date = ${scheduledDate}` : sql``}
      ${status ? sql`AND i.status = ${status}` : sql``}
    ORDER BY i.scheduled_date ASC, i.start_time ASC
  `;
}
