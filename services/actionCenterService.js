import sql from '../db.js';
import logger from '../utils/logger.js';
import { getSafetyDashboard } from './transportSafetyService.js';
import { getAcademicCoordinatorOverview } from './syllabusService.js';
import { getAttendanceRiskInsights } from './attendanceRiskService.js';
import { getUdiseReadinessOverview } from './udiseReadinessService.js';

/**
 * Principal Action Center Aggregator
 * Consolidates operational exceptions and attention items across all school modules
 */
export async function getActionCenterData(schoolId, user = {}) {
  const roles = user.roles || [];
  const isAdmin = roles.includes('admin') || roles.includes('principal') || roles.includes('superadmin');
  const isAcademic = isAdmin || roles.includes('academic_coordinator') || roles.includes('teacher');
  const isFinance = isAdmin || roles.includes('accountant') || roles.includes('accounts_manager');
  const isTransport = isAdmin || roles.includes('transport_manager') || roles.includes('transport');

  const criticalItems = [];
  const needsAttentionItems = [];
  const informationalItems = [];
  const degradedDomains = new Set();

  const systemHealth = {
    transport: 'HEALTHY',
    attendance: 'HEALTHY',
    academics: 'HEALTHY',
    finance: 'HEALTHY',
    governance: 'HEALTHY',
  };

  // 1. TRANSPORT SAFETY & SOS
  if (isTransport || isAdmin) {
    try {
      const [sosRow] = await sql`
        SELECT COUNT(*)::int AS count
        FROM transport_safety_incidents
        WHERE school_id = ${schoolId}
          AND status IN ('active', 'acknowledged')
          AND incident_type = 'sos'
      `;
      const sosCount = sosRow?.count || 0;
      if (sosCount > 0) {
        systemHealth.transport = 'CRITICAL';
        criticalItems.push({
          id: 'transport_sos',
          category: 'transport',
          severity: 'CRITICAL',
          title: 'Active Emergency SOS Alert',
          description: `${sosCount} vehicle${sosCount > 1 ? 's have' : ' has'} active driver emergency SOS triggered`,
          count: sosCount,
          action_url: '/admin/transport',
          action_label: 'View Live Incident',
        });
      }

      const [anomalyRow] = await sql`
        SELECT COUNT(*)::int AS count
        FROM transport_safety_incidents
        WHERE school_id = ${schoolId}
          AND status IN ('active', 'acknowledged')
          AND incident_type = 'safeguarding_anomaly'
      `;
      const anomalyCount = anomalyRow?.count || 0;
      if (anomalyCount > 0) {
        systemHealth.transport = 'CRITICAL';
        criticalItems.push({
          id: 'transport_safeguarding',
          category: 'transport',
          severity: 'CRITICAL',
          title: 'Bus ↔ Classroom Safeguarding Anomaly',
          description: `${anomalyCount} student safeguarding mismatch${anomalyCount > 1 ? 'es' : ''} detected today`,
          count: anomalyCount,
          action_url: '/admin/transport',
          action_label: 'Inspect Safeguarding',
        });
      }

      const [overspeedRow] = await sql`
        SELECT COUNT(*)::int AS count
        FROM transport_safety_incidents
        WHERE school_id = ${schoolId}
          AND status IN ('active', 'acknowledged')
          AND incident_type = 'overspeed'
      `;
      const overspeedCount = overspeedRow?.count || 0;
      if (overspeedCount > 0) {
        if (systemHealth.transport === 'HEALTHY') systemHealth.transport = 'ATTENTION';
        needsAttentionItems.push({
          id: 'transport_overspeed',
          category: 'transport',
          severity: 'NEEDS_ATTENTION',
          title: 'Sustained Bus Overspeeding',
          description: `${overspeedCount} bus${overspeedCount > 1 ? 'es have' : ''} sustained overspeeding violations`,
          count: overspeedCount,
          action_url: '/admin/transport',
          action_label: 'Review Overspeed',
        });
      }
    } catch (err) {
      degradedDomains.add('transport'); systemHealth.transport = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking transport metrics');
    }
  }

  // 2. PARENT SUPPORT & HELP DESK
  if (isAdmin || roles.includes('support')) {
    try {
      const [urgentTickets] = await sql`
        SELECT COUNT(*)::int AS count
        FROM support_tickets
        WHERE school_id = ${schoolId}
          AND status IN ('open', 'in_progress')
          AND priority = 'urgent'
      `;
      const urgentCount = urgentTickets?.count || 0;
      if (urgentCount > 0) {
        criticalItems.push({
          id: 'support_urgent',
          category: 'support',
          severity: 'CRITICAL',
          title: 'Urgent / Escalated Support Tickets',
          description: `${urgentCount} urgent or escalated parent support ticket${urgentCount > 1 ? 's require' : ' requires'} resolution`,
          count: urgentCount,
          action_url: '/admin/complaints',
          action_label: 'Open Help Desk',
        });
      }
    } catch (err) {
      degradedDomains.add('support'); systemHealth.governance = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking support tickets');
    }
  }

  // 3. STUDENT ATTENDANCE RISKS (< 75%)
  if (isAcademic || isAdmin) {
    try {
      const attendance = await getAttendanceRiskInsights(schoolId, { limit: 1 });
      const riskCount = attendance.summary.approachingRisk + attendance.summary.belowThreshold;
      if (riskCount > 0) {
        systemHealth.attendance = 'ATTENTION';
        needsAttentionItems.push({
          id: 'attendance_risk',
          category: 'attendance',
          severity: 'NEEDS_ATTENTION',
          title: 'Attendance Risk Requires Review',
          description: `${riskCount} student${riskCount > 1 ? 's are' : ' is'} below the school-configured attendance warning threshold`,
          count: riskCount,
          action_url: '/admin/attendance-risk',
          action_label: 'Review Attendance',
        });
      }
    } catch (err) {
      degradedDomains.add('attendance'); systemHealth.attendance = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking attendance risk');
    }
  }

  // 4. STAFF LEAVES & PENDING SUBSTITUTIONS
  if (isAcademic || isAdmin) {
    try {
      const [pendingLeaves] = await sql`
        SELECT COUNT(*)::int AS count
        FROM leave_applications
        WHERE school_id = ${schoolId}
          AND status = 'pending'
      `;
      const leaveCount = pendingLeaves?.count || 0;
      if (leaveCount > 0) {
        needsAttentionItems.push({
          id: 'staff_leaves_pending',
          category: 'staff',
          severity: 'NEEDS_ATTENTION',
          title: 'Pending Staff Leave Requests',
          description: `${leaveCount} staff leave request${leaveCount > 1 ? 's require' : ' requires'} review & substitution check`,
          count: leaveCount,
          action_url: '/admin/leaves',
          action_label: 'Manage Leaves',
        });
      }
    } catch (err) {
      degradedDomains.add('staff'); systemHealth.governance = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking leaves');
    }
  }

  // 5. FEE RECOVERY DEFAULTERS (> 30 days overdue)
  if (isFinance || isAdmin) {
    try {
      const [defaulterRow] = await sql`
        SELECT
          COUNT(DISTINCT sf.student_id)::int AS count,
          COALESCE(SUM(GREATEST(sf.amount_due - sf.discount - sf.amount_paid, 0)), 0)::numeric AS total_overdue
        FROM student_fees sf
        WHERE sf.school_id = ${schoolId}
          AND sf.deleted_at IS NULL
          AND sf.due_date < (CURRENT_DATE - INTERVAL '30 days')
          AND (sf.amount_due - sf.discount - sf.amount_paid) > 0
      `;
      const defCount = defaulterRow?.count || 0;
      const totalOverdue = Number(defaulterRow?.total_overdue || 0);

      if (defCount > 0) {
        systemHealth.finance = 'ATTENTION';
        needsAttentionItems.push({
          id: 'fee_defaulters_30d',
          category: 'finance',
          severity: 'NEEDS_ATTENTION',
          title: 'High-Age Fee Dues (> 30 Days Overdue)',
          description: `${defCount} student${defCount > 1 ? 's have' : ''} ₹${totalOverdue.toLocaleString('en-IN')} pending past 30 days`,
          count: defCount,
          amount: totalOverdue,
          action_url: '/admin/fee-reminders',
          action_label: 'Fee Recovery',
        });
      }
    } catch (err) {
      degradedDomains.add('finance'); systemHealth.finance = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking fee defaulters');
    }
  }

  // 6. SYLLABUS DELAYS
  if (isAcademic || isAdmin) {
    try {
      const overview = await getAcademicCoordinatorOverview(schoolId);
      const delayedSubjects = overview.filter((s) => s.status === 'DELAYED');
      if (delayedSubjects.length > 0) {
        systemHealth.academics = 'ATTENTION';
        needsAttentionItems.push({
          id: 'syllabus_delayed',
          category: 'academics',
          severity: 'NEEDS_ATTENTION',
          title: 'Syllabus Delays Behind Schedule',
          description: `${delayedSubjects.length} subject curriculum${delayedSubjects.length > 1 ? 's are' : ' is'} lagging behind target completion timeline`,
          count: delayedSubjects.length,
          action_url: '/admin/syllabus',
          action_label: 'Syllabus Tracker',
        });
      } else if (overview.length > 0) {
        informationalItems.push({
          id: 'syllabus_on_track',
          category: 'academics',
          title: 'Syllabus On-Track',
          description: 'All tracked curriculum subjects are progressing on schedule',
          count: overview.length,
        });
      }
    } catch (err) {
      degradedDomains.add('academics'); systemHealth.academics = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking syllabus progress');
    }
  }

  // 8. PENDING APPROVAL REQUESTS
  if (isAdmin || isFinance) {
    try {
      const [pendingApprovals] = await sql`
        SELECT COUNT(*)::int AS count
        FROM approval_requests
        WHERE school_id = ${schoolId}
          AND status = 'PENDING'
      `;
      const appCount = pendingApprovals?.count || 0;
      if (appCount > 0) {
        systemHealth.governance = 'ATTENTION';
        needsAttentionItems.push({
          id: 'pending_approvals',
          category: 'governance',
          severity: 'NEEDS_ATTENTION',
          title: 'Pending Administrative Approvals',
          description: `${appCount} request${appCount > 1 ? 's require' : ' requires'} administrator sign-off`,
          count: appCount,
          action_url: '/admin/approvals',
          action_label: 'Open Approval Inbox',
        });
      }
    } catch (err) {
      degradedDomains.add('approvals'); systemHealth.governance = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking pending approvals');
    }
  }

  // 9. UDISE READINESS CHECK
  if (isAdmin) {
    try {
      const udise = await getUdiseReadinessOverview(schoolId);
      const missingUdise = udise.summary.criticalCount + udise.summary.duplicateCount;
      if (missingUdise > 0) {
        informationalItems.push({
          id: 'udise_readiness_gap',
          category: 'compliance',
          title: 'UDISE Readiness Requires Correction',
          description: `${missingUdise} student profile${missingUdise > 1 ? 's have' : ' has'} critical or duplicate readiness data`,
          count: missingUdise,
          action_url: '/admin/udise-readiness',
          action_label: 'Complete UDISE Profiles',
        });
      }
    } catch (err) {
      degradedDomains.add('udise'); systemHealth.governance = 'UNKNOWN';
      logger.warn({ err: err.message }, '[ActionCenter] Failed checking UDISE readiness');
    }
  }

  const allClear = criticalItems.length === 0 && needsAttentionItems.length === 0 && degradedDomains.size === 0;

  return {
    summary: {
      critical_count: criticalItems.length,
      needs_attention_count: needsAttentionItems.length,
      informational_count: informationalItems.length,
      all_clear: allClear,
      degraded: degradedDomains.size > 0,
      unavailable_domains: [...degradedDomains],
      empty_state_message: allClear ? 'All systems operational — No urgent actions required' : null,
    },
    sections: {
      critical: criticalItems,
      needs_attention: needsAttentionItems,
      informational: informationalItems,
    },
    system_health: systemHealth,
    generated_at: new Date().toISOString(),
  };
}
