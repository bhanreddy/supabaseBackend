import logger from '../utils/logger.js';
import { processAutomationEvent } from './automationProcessor.js';

export const AUTOMATION_EVENTS = {
  FEE_DUE_APPROACHING: 'fee.due.approaching',
  FEE_DUE_REACHED: 'fee.due.reached',
  FEE_OVERDUE_STAGE: 'fee.overdue.stage',
  FEE_PAYMENT_COMPLETED: 'fee.payment.completed',
  STUDENT_ATTENDANCE_RISK_CHANGED: 'student.attendance.risk_changed',
  STAFF_LEAVE_APPROVED: 'staff.leave.approved',
  STAFF_LEAVE_CANCELLED: 'staff.leave.cancelled',
  TRANSPORT_OVERSPEED_DETECTED: 'transport.overspeed.detected',
  TRANSPORT_OVERSPEED: 'transport.overspeed.detected',
  TRANSPORT_SOS_TRIGGERED: 'transport.sos.triggered',
  DRIVER_EMERGENCY_SOS: 'transport.sos.triggered',
  TRANSPORT_SAFEGUARDING_ANOMALY: 'transport.safeguarding.anomaly',
  SUPPORT_TICKET_CREATED: 'support.ticket.created',
  SUPPORT_TICKET_REPLIED: 'support.ticket.replied',
  SUPPORT_TICKET_RESOLVED: 'support.ticket.resolved',
};

/**
 * Emit an internal school domain event for the automation engine.
 * Dispatches asynchronously to avoid blocking user-facing request threads.
 *
 * @param {string} eventName - One of AUTOMATION_EVENTS
 * @param {object} payload - Identifiers only (e.g. schoolId, studentId, studentFeeId)
 */
export function emitSchoolEvent(eventName, payload = {}) {
  if (!eventName || !payload.schoolId) {
    logger.warn({ eventName, schoolId: payload?.schoolId }, 'emitSchoolEvent missing required eventName or schoolId');
    return;
  }

  // Fire-and-forget: execute asynchronously
  setImmediate(async () => {
    try {
      await processAutomationEvent(eventName, payload);
    } catch (error) {
      logger.error(
        { err: error.message, eventName, schoolId: payload.schoolId },
        'Error processing automation event'
      );
    }
  });
}

export const publishAutomationEvent = emitSchoolEvent;

