import sql from '../db.js';
import { resolveStudentId } from '../utils/studentPortal.js';
export function transportError(status, code, message) {
  return Object.assign(new Error(message), {
    status,
    transportCode: code
  });
}
export const isTransportManager = (user, write = false) => user?.roles?.some(r => ['admin', 'superadmin'].includes(r)) || user?.permissions?.includes(write ? 'transport.manage' : 'transport.view') || user?.permissions?.includes('transport.manage');
export const isLiveTrip = status => ['active', 'in_progress'].includes(status);
export const withTransportTransaction = (db, run) => typeof db.begin === 'function' ? db.begin(run) : run(db);
export async function transportStaffId(schoolId, user, db = sql) {
  const [staff] = await db`SELECT s.id FROM staff s JOIN users u ON u.person_id=s.person_id
    AND u.school_id=s.school_id WHERE u.id=${user?.internal_id ?? user?.id ?? null}
    AND s.school_id=${schoolId} AND s.deleted_at IS NULL AND u.deleted_at IS NULL LIMIT 1`;
  return staff?.id || null;
}
export async function requireDriver(schoolId, user, db = sql) {
  if (!user?.roles?.includes('driver')) throw transportError(403, 'DRIVER_REQUIRED', 'Driver role required');
  const id = await transportStaffId(schoolId, user, db);
  if (!id) throw transportError(403, 'DRIVER_REQUIRED', 'Driver profile unavailable');
  return id;
}
export async function authorizeBusRead(req, busId, db = sql) {
  const [bus] = await db`SELECT id, driver_id FROM buses WHERE id=${busId} AND school_id=${req.schoolId}
    AND deleted_at IS NULL AND is_active=true`;
  if (!bus) throw transportError(404, 'BUS_NOT_FOUND', 'Bus not found');
  if (isTransportManager(req.user)) return bus;
  if (req.user?.roles?.includes('driver') && bus.driver_id === (await transportStaffId(req.schoolId, req.user, db))) return bus;
  const studentId = await resolveTransportStudent(req, db);
  if (studentId) {
    const [assignment] = await db`SELECT st.id FROM student_transport st
      JOIN academic_years ay ON ay.id=st.academic_year_id AND ay.school_id=st.school_id
      JOIN transport_routes r ON r.id=st.route_id AND r.school_id=st.school_id
      JOIN transport_stops stop ON stop.id=st.stop_id AND stop.route_id=r.id AND stop.school_id=st.school_id
      JOIN students student ON student.id=st.student_id AND student.school_id=st.school_id
      WHERE st.school_id=${req.schoolId} AND st.student_id=${studentId} AND st.is_active=true
      AND student.deleted_at IS NULL AND stop.deleted_at IS NULL
      AND r.bus_id=${busId} AND r.deleted_at IS NULL AND r.is_active=true
      AND (now() AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ay.start_date AND ay.end_date LIMIT 1`;
    if (assignment) return bus;
  }
  throw transportError(403, 'BUS_FORBIDDEN', 'This bus is not assigned to your active profile');
}
export async function authorizeTrip(req, tripId, db = sql, {
  write = false,
  lock = false
} = {}) {
  const [trip] = await db`SELECT * FROM trips WHERE id=${tripId} AND school_id=${req.schoolId}
    ${lock ? db`FOR UPDATE` : db``}`;
  if (!trip) throw transportError(404, 'TRIP_NOT_FOUND', 'Trip not found');
  if (isTransportManager(req.user, write)) return trip;
  const driverId = await requireDriver(req.schoolId, req.user, db);
  const [bus] = await db`SELECT id FROM buses WHERE id=${trip.bus_id} AND school_id=${req.schoolId}
    AND driver_id=${driverId} AND is_active=true AND deleted_at IS NULL`;
  if (trip.driver_id !== driverId || !bus) throw transportError(403, 'TRIP_FORBIDDEN', 'Trip is not assigned to you');
  return trip;
}

/** Recheck the current guardian relationship, including expiration, even with a cached portal context. */
export async function resolveTransportStudent(req, db = sql) {
  const studentId = await resolveStudentId(req);
  if (!studentId) return null;
  const [student] = await db`SELECT s.id FROM students s JOIN users u ON u.id=${req.user?.internal_id || req.user?.id || null}
    AND u.school_id=s.school_id AND u.deleted_at IS NULL AND u.account_status='active'
    WHERE s.id=${studentId} AND s.school_id=${req.schoolId} AND s.deleted_at IS NULL
    AND (s.person_id=u.person_id OR EXISTS(
      SELECT 1 FROM student_parents sp JOIN parents p ON p.id=sp.parent_id AND p.school_id=sp.school_id
      WHERE sp.student_id=s.id AND sp.school_id=s.school_id AND p.person_id=u.person_id AND p.deleted_at IS NULL
        AND sp.deleted_at IS NULL AND (sp.valid_from IS NULL OR sp.valid_from<=(now() AT TIME ZONE 'Asia/Kolkata')::date)
        AND (sp.valid_to IS NULL OR sp.valid_to>=(now() AT TIME ZONE 'Asia/Kolkata')::date)))`;
  return student?.id || null;
}
