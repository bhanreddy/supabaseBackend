import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { nextApprovalStage } from './eventModuleUtils.js';

export const EventApprovalService = {
  /**
   * Submit event for approval
   */
  async submitForApproval({ schoolId, eventId, userId, comments = 'Submitted for administrative approval' }) {
    const [event] = await sql`
      SELECT id, status, approval_status, title
      FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    return await sql.begin(async (tx) => {
      const [updated] = await tx`
        UPDATE events
        SET 
          status = 'AWAITING_APPROVAL',
          approval_status = 'PENDING',
          updated_at = now()
        WHERE id = ${eventId} AND school_id = ${schoolId}
        RETURNING *
      `;

      await tx`
        INSERT INTO event_approvals (
          school_id, event_id, stage, approver_user_id, decision, comments,
          previous_state, changed_state
        ) VALUES (
          ${schoolId}, ${eventId}, 'COORDINATOR', ${userId}, 'SUBMITTED', ${comments},
          ${event.status}, 'AWAITING_APPROVAL'
        )
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: 'APPROVAL_SUBMITTED',
        entityType: 'EVENT_APPROVAL',
        entityId: eventId,
        previousState: { status: event.status, approval_status: event.approval_status },
        newState: { status: 'AWAITING_APPROVAL', approval_status: 'PENDING' },
        details: comments,
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return updated;
    });
  },

  /**
   * Decide on approval request (APPROVE, REJECT, CHANGES_REQUESTED)
   */
  async decideApproval({ schoolId, eventId, userId, decision, comments = '', stage = 'PRINCIPAL' }) {
    if (!['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'].includes(decision)) {
      const err = new Error('Invalid decision. Must be APPROVED, REJECTED, or CHANGES_REQUESTED');
      err.statusCode = 400;
      throw err;
    }

    const [event] = await sql`
      SELECT id, status, approval_status, title, configuration
      FROM events
      WHERE id = ${eventId} AND school_id = ${schoolId} AND deleted_at IS NULL
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    return await sql.begin(async (tx) => {
      let newEventStatus = event.status;
      let newApprovalStatus = decision;

      if (decision === 'APPROVED') {
        const flow = event.configuration?.approval_flow || ['PRINCIPAL'];
        const next = nextApprovalStage(flow, stage);
        newEventStatus = next ? 'AWAITING_APPROVAL' : 'APPROVED';
        newApprovalStatus = next ? 'PENDING' : 'APPROVED';
      } else if (decision === 'REJECTED') {
        newEventStatus = 'CANCELLED';
      } else if (decision === 'CHANGES_REQUESTED') {
        newEventStatus = 'DRAFT';
      }

      const [updated] = await tx`
        UPDATE events
        SET
          status = ${newEventStatus},
          approval_status = ${newApprovalStatus},
          updated_at = now()
        WHERE id = ${eventId} AND school_id = ${schoolId}
        RETURNING *
      `;

      await tx`
        INSERT INTO event_approvals (
          school_id, event_id, stage, approver_user_id, decision, comments,
          previous_state, changed_state
        ) VALUES (
          ${schoolId}, ${eventId}, ${stage}, ${userId}, ${decision}, ${comments},
          ${event.status}, ${newEventStatus}
        )
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: userId,
        action: `APPROVAL_${decision}`,
        entityType: 'EVENT_APPROVAL',
        entityId: eventId,
        previousState: { status: event.status, approval_status: event.approval_status },
        newState: { status: newEventStatus, approval_status: newApprovalStatus },
        details: comments,
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return updated;
    });
  },

  /**
   * Get complete approval history and revision trail
   */
  async getApprovalHistory({ schoolId, eventId }) {
    return await sql`
      SELECT 
        a.*,
        p.display_name as approver_name,
        u.email as approver_email
      FROM event_approvals a
      LEFT JOIN users u ON a.approver_user_id = u.id
      LEFT JOIN persons p ON u.person_id = p.id
      WHERE a.event_id = ${eventId} AND a.school_id = ${schoolId}
      ORDER BY a.created_at ASC
    `;
  }
};

export default EventApprovalService;
