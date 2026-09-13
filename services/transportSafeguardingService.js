import sql from '../db.js';
import logger from '../utils/logger.js';
import { getSchoolAutomationRule, RULE_KEYS } from './automationRuleService.js';
import { publishAutomationEvent, AUTOMATION_EVENTS } from './automationEventService.js';
import { sendNotificationToUsers } from './notificationService.js';
import { resolveTransportManagerUserIds, INCIDENT_TYPES, INCIDENT_STATUSES } from './transportSafetyService.js';

/**
 * Reconcile morning bus attendance with classroom attendance.
 * Identifies students who boarded the morning bus but were recorded absent in class.
 */
export async function reconcileSafeguardingAttendance({
  schoolId,
  date = new Date().toISOString().slice(0, 10),
  db = sql,
}) {
  if (!schoolId) {
    return { success: false, reason: 'MISSING_SCHOOL_ID' };
  }

  const rule = await getSchoolAutomationRule(schoolId, RULE_KEYS.TRANSPORT_SAFEGUARDING_RECONCILE, db);
  if (!rule.is_enabled) {
    return { success: false, reason: 'RULE_DISABLED' };
  }

  const verificationWindowMinutes = Number(rule.trigger_config?.verification_window_minutes) || 45;

  // Query students where:
  // 1) Marked present on bus stop attendance for morning trip today
  // 2) Marked absent in classroom daily_attendance today
  // 3) Classroom attendance was submitted at least verificationWindowMinutes ago
  // 4) Other students in the same class section were marked present (confirms class attendance was taken, not empty/unsubmitted)
  const anomalies = await db`
    SELECT
      s.id AS student_id,
      p.display_name AS student_name,
      s.admission_no,
      c.id AS class_id,
      c.name AS class_name,
      sec.id AS section_id,
      sec.name AS section_name,
      cs.id AS class_section_id,
      cs.class_teacher_id,
      ba.id AS bus_attendance_id,
      ba.trip_id,
      ba.marked_at AS bus_marked_at,
      da.id AS classroom_attendance_id,
      da.created_at AS classroom_marked_at,
      b.id AS bus_id,
      b.registration_no AS bus_no,
      r.id AS route_id,
      r.name AS route_name,
      ts.name AS stop_name
    FROM bus_stop_attendance ba
    JOIN trips t ON t.id = ba.trip_id AND t.school_id = ${schoolId}
    JOIN buses b ON b.id = t.bus_id
    JOIN transport_routes r ON r.id = ba.route_id
    LEFT JOIN transport_stops ts ON ts.id = ba.stop_id
    JOIN students s ON s.id = ba.student_id AND s.school_id = ${schoolId}
    JOIN persons p ON p.id = s.person_id
    JOIN student_enrollments se ON se.student_id = s.id AND se.status = 'active'
    JOIN class_sections cs ON cs.id = se.class_section_id
    JOIN classes c ON c.id = cs.class_id
    JOIN sections sec ON sec.id = cs.section_id
    JOIN daily_attendance da ON da.student_enrollment_id = se.id
      AND da.school_id = ${schoolId}
      AND da.attendance_date = ${date}::date
      AND da.status = 'absent'
      AND da.deleted_at IS NULL
    WHERE ba.school_id = ${schoolId}
      AND ba.attendance_date = ${date}::date
      AND ba.status = 'present'
      AND t.trip_direction = 'morning'
      -- Classroom attendance must have been taken at least verificationWindowMinutes ago
      AND da.created_at <= (NOW() - make_interval(mins => ${verificationWindowMinutes}))
      -- Verify classroom attendance was indeed submitted for this section (at least 1 present/late student)
      AND EXISTS (
        SELECT 1
        FROM daily_attendance other_da
        JOIN student_enrollments other_se ON other_se.id = other_da.student_enrollment_id
        WHERE other_se.class_section_id = cs.id
          AND other_da.school_id = ${schoolId}
          AND other_da.attendance_date = ${date}::date
          AND other_da.status IN ('present', 'late', 'half_day')
          AND other_da.deleted_at IS NULL
      )
  `;

  // Auto-recover any active safeguarding incidents where teacher subsequently marked student present/late
  try {
    await db`
      UPDATE transport_safety_incidents tsi
      SET
        status = 'recovered',
        resolved_at = NOW(),
        resolution_notes = 'Auto-recovered: Classroom attendance was updated to present/late',
        updated_at = NOW()
      FROM daily_attendance da
      JOIN student_enrollments se ON se.id = da.student_enrollment_id
      WHERE tsi.school_id = ${schoolId}
        AND tsi.incident_type = ${INCIDENT_TYPES.SAFEGUARDING_ANOMALY}
        AND tsi.status IN ('active', 'verification_pending')
        AND tsi.student_id = se.student_id
        AND da.school_id = ${schoolId}
        AND da.attendance_date = ${date}::date
        AND da.status IN ('present', 'late', 'half_day')
        AND da.deleted_at IS NULL
    `;
  } catch (recoverErr) {
    logger.error({ err: recoverErr.message, schoolId }, 'Failed to check safeguarding auto-recovery');
  }

  if (!anomalies.length) {
    return {
      success: true,
      reconciledDate: date,
      anomaliesCount: 0,
      anomalies: [],
    };
  }

  const createdIncidents = [];

  for (const item of anomalies) {
    // Check if incident already logged today for this student
    const [existing] = await db`
      SELECT id
      FROM transport_safety_incidents
      WHERE school_id = ${schoolId}
        AND incident_type = ${INCIDENT_TYPES.SAFEGUARDING_ANOMALY}
        AND (student_id = ${item.student_id} OR (metadata->>'student_id')::text = ${item.student_id}::text)
        AND created_at::date = ${date}::date
      LIMIT 1
    `;

    if (existing) {
      continue;
    }

    // Insert safeguarding incident conforming to transport_safety_incidents schema
    const [incident] = await db`
      INSERT INTO transport_safety_incidents (
        school_id, vehicle_id, route_id, trip_id, student_id, incident_type,
        started_at, status, metadata
      ) VALUES (
        ${schoolId}, ${item.bus_id}, ${item.route_id}, ${item.trip_id}, ${item.student_id},
        ${INCIDENT_TYPES.SAFEGUARDING_ANOMALY},
        NOW(),
        ${INCIDENT_STATUSES.VERIFICATION_PENDING},
        ${db.json({
          severity: 'critical',
          student_id: item.student_id,
          student_name: item.student_name,
          admission_no: item.admission_no,
          class_name: item.class_name,
          section_name: item.section_name,
          class_section_id: item.class_section_id,
          stop_name: item.stop_name,
          bus_no: item.bus_no,
          route_name: item.route_name,
          trip_id: item.trip_id,
          bus_marked_at: item.bus_marked_at,
          classroom_marked_at: item.classroom_marked_at,
          reconciled_date: date,
        })}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (!incident) continue;

    createdIncidents.push(incident);

    // Publish event (resilient)
    try {
      await publishAutomationEvent(AUTOMATION_EVENTS.TRANSPORT_SAFEGUARDING_ANOMALY, {
        schoolId,
        incidentId: incident.id,
        studentId: item.student_id,
        studentName: item.student_name,
        className: `${item.class_name}-${item.section_name}`,
        busNo: item.bus_no,
        routeName: item.route_name,
        date,
      });
    } catch (evtErr) {
      logger.error({ err: evtErr.message, incidentId: incident.id }, 'Failed to publish safeguarding event');
    }

    // Notify recipients:
    // 1) Class teacher (if assigned)
    // 2) Transport managers & admins
    try {
      const recipients = new Set();

      if (item.class_teacher_id) {
        const [teacherUser] = await db`
          SELECT u.id AS user_id
          FROM staff st
          JOIN users u ON u.person_id = st.person_id AND u.school_id = ${schoolId}
          WHERE st.id = ${item.class_teacher_id} AND u.account_status = 'active'
          LIMIT 1
        `;
        if (teacherUser?.user_id) recipients.add(teacherUser.user_id);
      }

      const managers = await resolveTransportManagerUserIds(schoolId, db);
      managers.forEach(id => recipients.add(id));

      if (recipients.size > 0) {
        await sendNotificationToUsers(
          Array.from(recipients),
          'TRANSPORT_SAFEGUARDING_ANOMALY',
          {
            studentName: item.student_name,
            className: `${item.class_name}-${item.section_name}`,
          },
          {
            schoolId,
            deepLink: '/admin/transport',
          }
        );
      }
    } catch (notifyErr) {
      logger.error({ err: notifyErr.message, incidentId: incident.id }, 'Failed to send safeguarding notification');
    }
  }

  return {
    success: true,
    reconciledDate: date,
    anomaliesCount: createdIncidents.length,
    anomalies: createdIncidents,
  };
}
