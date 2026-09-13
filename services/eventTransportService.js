import sql from '../db.js';
import { EventEngineService } from './eventEngineService.js';
import { pickField, mapBoardingStatus } from './eventModuleUtils.js';

export const EventTransportService = {
  /**
   * Assign an existing school bus to the event
   */
  async assignBusToEvent(payload) {
    const schoolId = payload.schoolId;
    const eventId = payload.eventId;
    const busId = pickField(payload, 'busId', 'bus_id');
    const teacherInChargeId = pickField(payload, 'teacherInChargeId', 'teacher_in_charge_id') || null;
    const driverId = pickField(payload, 'driverId', 'driver_id') || null;
    const vehicleCapacity = pickField(payload, 'vehicleCapacity', 'vehicle_capacity') || 40;
    const pickupPoint = pickField(payload, 'pickupPoint', 'pickup_point') || null;
    const departureTime = pickField(payload, 'departureTime', 'departure_time') || null;
    const returnTime = pickField(payload, 'returnTime', 'return_time') || null;
    const routeDescription = pickField(payload, 'routeDescription', 'route_description') || null;
    const notes = payload.notes || null;
    const userId = payload.userId || null;
    if (!busId) {
      const err = new Error('bus_id is required');
      err.statusCode = 400;
      throw err;
    }
    const [assignment] = await sql`
      INSERT INTO event_transport_assignments (
        school_id, event_id, bus_id, teacher_in_charge_id, driver_id,
        vehicle_capacity, pickup_point, departure_time, return_time,
        route_description, notes
      ) VALUES (
        ${schoolId}, ${eventId}, ${busId}, ${teacherInChargeId}, ${driverId},
        ${vehicleCapacity}, ${pickupPoint}, ${departureTime}, ${returnTime},
        ${routeDescription}, ${notes}
      )
      RETURNING *
    `;

    await EventEngineService.logAudit({
      schoolId,
      eventId,
      actorUserId: userId,
      action: 'TRANSPORT_BUS_ASSIGNED',
      entityType: 'EVENT_TRANSPORT',
      entityId: assignment.id,
      details: `Assigned bus ID ${busId} to event`,
    });

    await EventEngineService.calculateReadinessScore(schoolId, eventId);
    return assignment;
  },

  /**
   * List all transport assignments for an event with driver & teacher details
   */
  async listTransportAssignments({ schoolId, eventId }) {
    return await sql`
      SELECT 
        eta.*,
        b.bus_no as bus_number,
        b.registration_no as registration_number,
        teacher_p.display_name as teacher_in_charge_name,
        teacher_contact.contact_value as teacher_mobile,
        driver_p.display_name as driver_name,
        driver_contact.contact_value as driver_mobile,
        count(ebm.id)::int as assigned_students_count,
        count(ebm.id) FILTER (WHERE ebm.boarding_status IN ('ON_BUS', 'ARRIVED', 'RETURNED'))::int as boarded_count
      FROM event_transport_assignments eta
      JOIN buses b ON eta.bus_id = b.id
      LEFT JOIN staff teacher ON eta.teacher_in_charge_id = teacher.id
      LEFT JOIN persons teacher_p ON teacher.person_id = teacher_p.id
      LEFT JOIN person_contacts teacher_contact ON teacher_contact.person_id = teacher_p.id AND teacher_contact.contact_type = 'phone'
      LEFT JOIN staff driver ON eta.driver_id = driver.id
      LEFT JOIN persons driver_p ON driver.person_id = driver_p.id
      LEFT JOIN person_contacts driver_contact ON driver_contact.person_id = driver_p.id AND driver_contact.contact_type = 'phone'
      LEFT JOIN event_bus_manifests ebm ON ebm.assignment_id = eta.id
      WHERE eta.event_id = ${eventId} AND eta.school_id = ${schoolId}
      GROUP BY 
        eta.id, b.bus_no, b.registration_no,
        teacher_p.display_name, teacher_contact.contact_value,
        driver_p.display_name, driver_contact.contact_value
      ORDER BY b.bus_no ASC
    `;
  },

  /**
   * Assign a student to a bus manifest
   */
  async addStudentToBusManifest({
    schoolId,
    assignmentId,
    eventId,
    studentId,
    pickupStop = null,
    emergencyContactOverride = null,
    userId = null,
  }) {
    // Check capacity limit
    const [assignment] = await sql`
      SELECT vehicle_capacity,
        (SELECT count(*)::int FROM event_bus_manifests WHERE assignment_id = ${assignmentId}) as current_count
      FROM event_transport_assignments
      WHERE id = ${assignmentId} AND school_id = ${schoolId}
    `;
    if (!assignment) {
      const err = new Error('Bus assignment not found');
      err.statusCode = 404;
      throw err;
    }

    if (assignment.current_count >= assignment.vehicle_capacity) {
      const err = new Error(`Bus capacity reached (${assignment.vehicle_capacity} seats)`);
      err.statusCode = 400;
      throw err;
    }

    const [manifest] = await sql`
      INSERT INTO event_bus_manifests (
        school_id, assignment_id, event_id, student_id, pickup_stop,
        boarding_status, emergency_contact_override
      ) VALUES (
        ${schoolId}, ${assignmentId}, ${eventId}, ${studentId}, ${pickupStop},
        'PENDING', ${emergencyContactOverride}
      )
      ON CONFLICT (event_id, student_id) DO UPDATE SET
        assignment_id = EXCLUDED.assignment_id,
        pickup_stop = EXCLUDED.pickup_stop,
        updated_at = now()
      RETURNING *
    `;

    return manifest;
  },

  /**
   * Get student manifest for a bus assignment
   */
  async getBusManifest({ schoolId, assignmentId }) {
    return await sql`
      SELECT 
        m.*,
        p.display_name as student_name,
        s.admission_no,
        cls.name as class_name,
        sec.name as section_name,
        parent_p.display_name as parent_name,
        COALESCE(m.emergency_contact_override, parent_phone.value) as contact_mobile,
        c.medical_declaration_ack,
        c.emergency_treatment_auth
      FROM event_bus_manifests m
      JOIN students s ON m.student_id = s.id
      JOIN persons p ON s.person_id = p.id
      LEFT JOIN student_enrollments se ON se.student_id = s.id AND se.school_id = ${schoolId} AND se.status = 'active' AND se.deleted_at IS NULL
      LEFT JOIN class_sections cs ON cs.id = se.class_section_id
      LEFT JOIN classes cls ON cls.id = cs.class_id
      LEFT JOIN sections sec ON sec.id = cs.section_id
      LEFT JOIN student_parents sp ON sp.student_id = s.id
      LEFT JOIN parents par ON sp.parent_id = par.id
      LEFT JOIN persons parent_p ON par.person_id = parent_p.id
      LEFT JOIN person_contacts parent_phone ON parent_phone.person_id = parent_p.id AND parent_phone.contact_type = 'phone'
      LEFT JOIN event_consents c ON c.event_id = m.event_id AND c.student_id = m.student_id
      WHERE m.assignment_id = ${assignmentId} AND m.school_id = ${schoolId}
      ORDER BY cls.name, sec.name, p.display_name
    `;
  },

  /**
   * Update student boarding status on bus
   */
  async updateBoardingStatus({ schoolId, manifestId, boardingStatus, markedBy }) {
    const status = mapBoardingStatus(boardingStatus);
    const [updated] = await sql`
      UPDATE event_bus_manifests
      SET 
        boarding_status = ${status},
        marked_by = ${markedBy},
        marked_at = now(),
        updated_at = now()
      WHERE id = ${manifestId} AND school_id = ${schoolId}
      RETURNING *
    `;

    if (!updated) {
      const err = new Error('Manifest record not found');
      err.statusCode = 404;
      throw err;
    }

    // Also reflect into event_attendance
    if (['ON_BUS', 'ARRIVED'].includes(boardingStatus)) {
      await sql`
        INSERT INTO event_attendance (
          school_id, event_id, participant_type, student_id, status,
          checkin_time, bus_assignment_id, marked_by
        ) VALUES (
          ${schoolId}, ${updated.event_id}, 'STUDENT', ${updated.student_id},
          ${boardingStatus}, now(), ${updated.assignment_id}, ${markedBy}
        )
        ON CONFLICT (event_id, student_id) DO UPDATE SET
          status = EXCLUDED.status,
          bus_assignment_id = EXCLUDED.bus_assignment_id,
          marked_by = EXCLUDED.marked_by,
          updated_at = now()
      `;
    }

    return updated;
  }
};

export default EventTransportService;
