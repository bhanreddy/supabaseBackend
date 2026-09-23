import sql from '../db.js';
export async function transportTripHealth(schoolId, trip, db = sql) {
  if (!trip) return null;
  const [row] = await db`SELECT
    (SELECT EXTRACT(EPOCH FROM now()-recorded_at)::int FROM bus_locations WHERE school_id=${schoolId} AND trip_id=${trip.id}) AS gps_age_seconds,
    (SELECT EXTRACT(EPOCH FROM now()-last_ping)::int FROM driver_heartbeat WHERE school_id=${schoolId} AND driver_id=${trip.driver_id}) AS heartbeat_age_seconds,
    count(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending_notifications,
    count(*) FILTER(WHERE status='failed')::int AS failed_notifications,
    EXTRACT(EPOCH FROM now()-min(created_at) FILTER(WHERE status IN ('pending','processing')))::int AS oldest_pending_seconds
    FROM transport_outbox WHERE school_id=${schoolId} AND trip_id=${trip.id}`;
  return {
    ...row,
    automatic_stops_enabled: trip.auto_stops_enabled === true
  };
}
