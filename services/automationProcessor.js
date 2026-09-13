import logger from '../utils/logger.js';
import { AUTOMATION_EVENTS } from './automationEventService.js';
import { isAutomationRuleEnabled, RULE_KEYS } from './automationRuleService.js';
import { dispatchFeeReminder } from './automationActionService.js';
import { evaluateAndDispatchAttendanceAlert } from './attendanceRiskService.js';
import { handleStaffLeaveApproved, handleStaffLeaveCancelled } from './leaveSubstitutionService.js';

/**
 * Main event processor for platform automation rules.
 */
export async function processAutomationEvent(eventName, payload) {
  const { schoolId } = payload;
  if (!schoolId) return;

  logger.info({ eventName, schoolId }, 'Processing automation event');

  switch (eventName) {
    case AUTOMATION_EVENTS.FEE_PAYMENT_COMPLETED: {
      const { studentFeeId, studentId } = payload;
      logger.info({ schoolId, studentFeeId, studentId }, 'Fee payment completed event received');
      // No outbound notification needed on this event; payment triggers FEE_COLLECTED separately
      break;
    }

    case AUTOMATION_EVENTS.FEE_OVERDUE_STAGE:
    case AUTOMATION_EVENTS.FEE_DUE_APPROACHING:
    case AUTOMATION_EVENTS.FEE_DUE_REACHED: {
      const isEnabled = await isAutomationRuleEnabled(schoolId, RULE_KEYS.FEE_DUE_REMINDER);
      if (!isEnabled) {
        logger.debug({ schoolId, eventName }, 'Fee reminder rule disabled for school; skipping event');
        return;
      }

      const { studentId, studentFeeId, stage } = payload;
      if (!studentId || !studentFeeId) return;

      await dispatchFeeReminder({
        schoolId,
        studentId,
        studentFeeId,
        stage: stage || 'overdue',
      });
      break;
    }

    case AUTOMATION_EVENTS.STUDENT_ATTENDANCE_RISK_CHANGED: {
      const { studentId } = payload;
      if (!studentId) return;
      await evaluateAndDispatchAttendanceAlert({ schoolId, studentId });
      break;
    }

    case AUTOMATION_EVENTS.STAFF_LEAVE_APPROVED: {
      await handleStaffLeaveApproved(payload);
      break;
    }

    case AUTOMATION_EVENTS.STAFF_LEAVE_CANCELLED: {
      await handleStaffLeaveCancelled(payload);
      break;
    }

    case AUTOMATION_EVENTS.TRANSPORT_OVERSPEED_DETECTED:
    case AUTOMATION_EVENTS.TRANSPORT_OVERSPEED: {
      logger.info({ schoolId, busId: payload.busId, speed: payload.speed }, 'Transport overspeed automation event processed');
      break;
    }

    case AUTOMATION_EVENTS.TRANSPORT_SOS_TRIGGERED:
    case AUTOMATION_EVENTS.DRIVER_EMERGENCY_SOS: {
      logger.info({ schoolId, busId: payload.busId, driverId: payload.driverId }, 'Driver emergency SOS automation event processed');
      break;
    }

    case AUTOMATION_EVENTS.TRANSPORT_SAFEGUARDING_ANOMALY: {
      logger.info({ schoolId, studentId: payload.studentId, incidentId: payload.incidentId }, 'Transport safeguarding anomaly automation event processed');
      break;
    }

    case AUTOMATION_EVENTS.SUPPORT_TICKET_CREATED:
    case AUTOMATION_EVENTS.SUPPORT_TICKET_REPLIED:
    case AUTOMATION_EVENTS.SUPPORT_TICKET_RESOLVED: {
      logger.info({ schoolId, ticketId: payload.ticketId, eventName }, 'Support ticket automation event processed');
      break;
    }

    default:
      logger.warn({ eventName }, 'Unhandled automation event');
      break;
  }
}
