import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { sendNotificationToUsers } from './notificationService.js';
import logger from '../utils/logger.js';
import { pickField } from './eventModuleUtils.js';

export const EventIncidentService = {
  async reportIncident(payload) {
    const schoolId = payload.schoolId;
    const eventId = payload.eventId;
    const incidentType = pickField(payload, 'incidentType', 'incident_type') || 'OTHER';
    const severity = pickField(payload, 'severity') || 'LOW';
    const personInvolvedType = pickField(payload, 'personInvolvedType', 'person_involved_type') || 'STUDENT';
    const studentId = pickField(payload, 'studentId', 'student_id') || null;
    const personName = pickField(payload, 'personName', 'person_name') || null;
    const location = pickField(payload, 'location') || null;
    const description = pickField(payload, 'description', 'title');
    const actionTaken = pickField(payload, 'actionTaken', 'action_taken') || null;
    const staffPresent = pickField(payload, 'staffPresent', 'staff_present') || pickField(payload, 'staffId', 'staff_id') || null;
    const attachments = payload.attachments || [];
    const userId = payload.userId || payload.reportedBy || null;

    if (!description || !incidentType) {
      const err = new Error('incidentType and description are required');
      err.statusCode = 400;
      throw err;
    }

    const reporter = userId || null;

    const [event] = await sql`
      SELECT id, title FROM events WHERE id = ${eventId} AND school_id = ${schoolId}
    `;
    if (!event) {
      const err = new Error('Event not found');
      err.statusCode = 404;
      throw err;
    }

    const [incident] = await sql`
      INSERT INTO event_incidents (
        school_id, event_id, incident_type, severity, person_involved_type,
        student_id, person_name, location, description, action_taken,
        staff_present, attachments, reported_by
      ) VALUES (
        ${schoolId}, ${eventId}, ${incidentType}, ${severity}, ${personInvolvedType},
        ${studentId}, ${personName}, ${location}, ${description}, ${actionTaken},
        ${staffPresent}, ${sql.json(attachments || [])}, ${reporter}
      )
      RETURNING *
    `;

    // Critical incidents immediately alert school administration
    if (severity === 'CRITICAL' || severity === 'HIGH') {
      try {
        const admins = await sql`
          SELECT u.id FROM users u
          JOIN user_roles ur ON ur.user_id = u.id
          JOIN roles r ON ur.role_id = r.id
          WHERE u.school_id = ${schoolId} AND r.code IN ('admin', 'principal') AND u.deleted_at IS NULL
        `;
        const adminIds = admins.map((a) => a.id);
        if (adminIds.length > 0) {
          await sendNotificationToUsers(adminIds, 'CRITICAL_INCIDENT', {
            title: `⚠️ Critical Incident Reported: ${event.title}`,
            message: `${incidentType} (${severity}): ${description}`,
            eventId,
          }, { schoolId });
        }
      } catch (notifErr) {
        logger.warn({ err: notifErr.message, eventId }, 'Failed to dispatch critical incident notification');
      }
    }

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'INCIDENT_REPORTED',
      entityType: 'EVENT_INCIDENT',
      entityId: incident.id,
      newState: { incidentType, severity, location },
      details: `Incident reported: ${incidentType} (${severity})`,
    });

    return incident;
  },

  async listIncidents({ schoolId, eventId, isResolved = null }) {
    return await sql`
      SELECT 
        i.*,
        p.display_name as student_name,
        reporter_p.display_name as reporter_name
      FROM event_incidents i
      LEFT JOIN students s ON i.student_id = s.id
      LEFT JOIN persons p ON s.person_id = p.id
      LEFT JOIN users rep ON i.reported_by = rep.id
      LEFT JOIN persons reporter_p ON rep.person_id = reporter_p.id
      WHERE i.event_id = ${eventId} AND i.school_id = ${schoolId}
        ${isResolved !== null ? sql`AND i.is_resolved = ${isResolved}` : sql``}
      ORDER BY 
        CASE i.severity 
          WHEN 'CRITICAL' THEN 1 
          WHEN 'HIGH' THEN 2 
          WHEN 'MEDIUM' THEN 3 
          ELSE 4 
        END,
        i.incident_time DESC
    `;
  },

  async resolveIncident({ schoolId, incidentId, resolutionNotes, userId }) {
    const [updated] = await sql`
      UPDATE event_incidents
      SET 
        is_resolved = true,
        resolution_notes = ${resolutionNotes},
        resolved_at = now(),
        updated_at = now()
      WHERE id = ${incidentId} AND school_id = ${schoolId}
      RETURNING *
    `;

    if (!updated) {
      const err = new Error('Incident not found');
      err.statusCode = 404;
      throw err;
    }

    await EventEngineService.logAudit({
      schoolId,
      eventId: updated.event_id,
      actorUserId: userId,
      action: 'INCIDENT_RESOLVED',
      entityType: 'EVENT_INCIDENT',
      entityId: incidentId,
      details: `Incident marked resolved: ${resolutionNotes}`,
    });

    return updated;
  }
};

export default EventIncidentService;
