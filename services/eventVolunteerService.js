import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { pickField } from './eventModuleUtils.js';

export const EventVolunteerService = {
  async apply({ schoolId, eventId, data, userId }) {
    const volunteerType = String(pickField(data, 'volunteer_type', 'volunteerType') || 'STUDENT').toUpperCase();
    const area = pickField(data, 'area') || 'General';
    const [row] = await sql`
      INSERT INTO event_volunteers (
        school_id, event_id, volunteer_type, student_id, user_id, area, shift_notes
      ) VALUES (
        ${schoolId}, ${eventId}, ${volunteerType},
        ${pickField(data, 'student_id', 'studentId') || null},
        ${pickField(data, 'user_id', 'userId') || userId || null},
        ${area},
        ${pickField(data, 'shift_notes', 'shiftNotes') || null}
      )
      RETURNING *
    `;
    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'VOLUNTEER_APPLIED',
      entityType: 'EVENT_VOLUNTEER',
      entityId: row.id,
      details: area,
    });
    return row;
  },

  async list({ schoolId, eventId, status = null }) {
    return await sql`
      SELECT
        v.*,
        COALESCE(stud_p.display_name, staff_p.display_name) as volunteer_name
      FROM event_volunteers v
      LEFT JOIN students s ON v.student_id = s.id
      LEFT JOIN persons stud_p ON s.person_id = stud_p.id
      LEFT JOIN users u ON v.user_id = u.id
      LEFT JOIN persons staff_p ON u.person_id = staff_p.id
      WHERE v.event_id = ${eventId} AND v.school_id = ${schoolId}
        ${status ? sql`AND v.status = ${status}` : sql``}
      ORDER BY v.created_at DESC
    `;
  },

  async decide({ schoolId, volunteerId, status, shiftNotes = null, userId }) {
    if (!['APPROVED', 'REJECTED', 'ASSIGNED'].includes(status)) {
      const err = new Error('Invalid volunteer decision');
      err.statusCode = 400;
      throw err;
    }
    const [row] = await sql`
      UPDATE event_volunteers
      SET status = ${status},
          shift_notes = COALESCE(${shiftNotes}, shift_notes),
          updated_at = now()
      WHERE id = ${volunteerId} AND school_id = ${schoolId}
      RETURNING *
    `;
    if (!row) {
      const err = new Error('Volunteer record not found');
      err.statusCode = 404;
      throw err;
    }
    await EventEngineService.logAudit({
      schoolId,
      eventId: row.event_id,
      actorUserId: userId,
      action: `VOLUNTEER_${status}`,
      entityType: 'EVENT_VOLUNTEER',
      entityId: volunteerId,
    });
    return row;
  },
};

export default EventVolunteerService;
