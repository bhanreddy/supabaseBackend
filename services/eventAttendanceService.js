import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';

export const EventAttendanceService = {
  /**
   * Get live operational attendance dashboard metrics and roster
   */
  async getAttendanceDashboard({ schoolId, eventId, classId = null, sectionId = null }) {
    const counts = await sql`
      SELECT 
        count(r.id)::int as total_registered,
        count(a.id) FILTER (WHERE a.status IN ('PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED'))::int as present_count,
        count(a.id) FILTER (WHERE a.status = 'ABSENT')::int as absent_count,
        count(r.id) FILTER (WHERE a.status IS NULL OR a.status NOT IN ('PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED'))::int as missing_count
      FROM event_registrations r
      LEFT JOIN event_attendance a ON a.event_id = r.event_id AND a.student_id = r.student_id
      WHERE r.event_id = ${eventId}
        AND r.school_id = ${schoolId}
        AND r.participant_type = 'STUDENT'
        AND r.registration_status = 'REGISTERED'
        AND r.deleted_at IS NULL
    `;

    const summary = counts[0] || { total_registered: 0, present_count: 0, absent_count: 0, missing_count: 0 };
    const attendancePercentage = summary.total_registered > 0
      ? Number(((summary.present_count / summary.total_registered) * 100).toFixed(1))
      : 0;

    // Bus attendance breakdown
    const busStats = await sql`
      SELECT 
        b.bus_no as bus_number,
        eta.vehicle_capacity,
        count(ebm.id)::int as assigned_count,
        count(ebm.id) FILTER (WHERE ebm.boarding_status IN ('ON_BUS', 'ARRIVED', 'RETURNED'))::int as boarded_count
      FROM event_transport_assignments eta
      JOIN buses b ON eta.bus_id = b.id
      LEFT JOIN event_bus_manifests ebm ON ebm.assignment_id = eta.id
      WHERE eta.event_id = ${eventId} AND eta.school_id = ${schoolId}
      GROUP BY b.bus_no, eta.vehicle_capacity
    `;

    // Attendance roster list
    const roster = await sql`
      SELECT 
        r.id as registration_id,
        r.student_id,
        p.display_name as student_name,
        s.admission_no,
        cls.name as class_name,
        sec.name as section_name,
        COALESCE(a.status, 'UNMARKED') as attendance_status,
        a.checkin_time,
        a.notes as attendance_notes,
        ebm.boarding_status,
        b.bus_no as bus_number
      FROM event_registrations r
      JOIN students s ON r.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN event_attendance a ON a.event_id = r.event_id AND a.student_id = r.student_id
      LEFT JOIN event_bus_manifests ebm ON ebm.event_id = r.event_id AND ebm.student_id = r.student_id
      LEFT JOIN event_transport_assignments eta ON ebm.assignment_id = eta.id
      LEFT JOIN buses b ON eta.bus_id = b.id
      WHERE r.event_id = ${eventId}
        AND r.school_id = ${schoolId}
        AND r.participant_type = 'STUDENT'
        AND r.registration_status = 'REGISTERED'
        AND r.deleted_at IS NULL
        ${classId ? sql`AND cls.id::text = ${classId}` : sql``}
        ${sectionId ? sql`AND sec.id::text = ${sectionId}` : sql``}
      ORDER BY cls.name, sec.name, p.display_name
    `;

    return {
      summary: {
        ...summary,
        attendance_percentage: attendancePercentage,
      },
      bus_stats: busStats,
      roster,
    };
  },

  /**
   * Mark attendance for a single attendee
   */
  async markAttendance({ schoolId, eventId, studentId, status, markedBy, notes = null, busId = null }) {
    return await sql.begin(async (tx) => {
      const [att] = await tx`
        INSERT INTO event_attendance (
          school_id, event_id, participant_type, student_id, status,
          checkin_time, marked_by, notes, bus_assignment_id
        ) VALUES (
          ${schoolId}, ${eventId}, 'STUDENT', ${studentId}, ${status},
          ${['PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED'].includes(status) ? sql`now()` : null},
          ${markedBy}, ${notes}, ${busId}
        )
        ON CONFLICT (event_id, student_id) DO UPDATE SET
          status = EXCLUDED.status,
          checkin_time = CASE 
            WHEN EXCLUDED.status IN ('PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED') AND event_attendance.checkin_time IS NULL 
            THEN now() 
            ELSE event_attendance.checkin_time 
          END,
          checkout_time = CASE WHEN EXCLUDED.status IN ('CHECKED_OUT', 'LEFT_EVENT') THEN now() ELSE event_attendance.checkout_time END,
          notes = COALESCE(EXCLUDED.notes, event_attendance.notes),
          marked_by = EXCLUDED.marked_by,
          updated_at = now()
        RETURNING *
      `;

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: markedBy,
        action: 'ATTENDANCE_MARKED',
        entityType: 'EVENT_ATTENDANCE',
        entityId: att.id,
        newState: { studentId, status },
        details: `Attendance marked ${status}`,
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return att;
    });
  },

  /**
   * Bulk mark attendance (e.g. Teacher marks whole class present)
   */
  async bulkMarkAttendance({ schoolId, eventId, records, markedBy }) {
    if (!Array.isArray(records) || records.length === 0) {
      return { success: true, count: 0 };
    }

    return await sql.begin(async (tx) => {
      let markedCount = 0;
      for (const rec of records) {
        if (rec.student_id && rec.status) {
          await tx`
            INSERT INTO event_attendance (
              school_id, event_id, participant_type, student_id, status,
              checkin_time, marked_by, notes
            ) VALUES (
              ${schoolId}, ${eventId}, 'STUDENT', ${rec.student_id}, ${rec.status},
              ${['PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED'].includes(rec.status) ? sql`now()` : null},
              ${markedBy}, ${rec.notes || null}
            )
            ON CONFLICT (event_id, student_id) DO UPDATE SET
              status = EXCLUDED.status,
              marked_by = EXCLUDED.marked_by,
              updated_at = now()
          `;
          markedCount++;
        }
      }

      await EventEngineService.logAudit({
        schoolId,
        eventId,
        actorUserId: markedBy,
        action: 'BULK_ATTENDANCE_MARKED',
        entityType: 'EVENT_ATTENDANCE',
        entityId: eventId,
        details: `Bulk marked attendance for ${markedCount} students`,
      }, tx);

      await EventEngineService.calculateReadinessScore(schoolId, eventId, tx);

      return { success: true, count: markedCount };
    });
  },

  /**
   * Identify all missing students with their parent contacts for immediate follow-up
   */
  async getMissingAttendees({ schoolId, eventId }) {
    return await sql`
      SELECT 
        r.student_id,
        p.display_name as student_name,
        s.admission_no,
        cls.name as class_name,
        sec.name as section_name,
        parent_p.display_name as parent_name,
        parent_phone.contact_value as parent_mobile
      FROM event_registrations r
      JOIN students s ON r.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN student_parents sp ON sp.student_id = s.id
      LEFT JOIN parents par ON sp.parent_id = par.id
      LEFT JOIN persons parent_p ON par.person_id = parent_p.id
      LEFT JOIN person_contacts parent_phone ON parent_phone.person_id = parent_p.id AND parent_phone.contact_type = 'phone'
      LEFT JOIN event_attendance a ON a.event_id = r.event_id AND a.student_id = r.student_id
      WHERE r.event_id = ${eventId}
        AND r.school_id = ${schoolId}
        AND r.participant_type = 'STUDENT'
        AND r.registration_status = 'REGISTERED'
        AND r.deleted_at IS NULL
        AND (a.status IS NULL OR a.status NOT IN ('PRESENT', 'CHECKED_IN', 'ON_BUS', 'ARRIVED'))
      ORDER BY cls.name, sec.name, p.display_name
    `;
  }
};

export default EventAttendanceService;
