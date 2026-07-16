/**
 * Read-only performance evidence for staging. Run with the same DATABASE_URL
 * used by the deployment, never by hand against production during peak hours.
 *
 * node scripts/explainTransportHotQueries.js
 */
import sql from '../db.js';

const printPlan = (name, rows) => {
  console.log(`\n## ${name}`);
  rows.forEach((row) => console.log(row['QUERY PLAN']));
};

try {
  const [bus] = await sql`
    SELECT id, school_id FROM buses
    WHERE is_active = true AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!bus) throw new Error('No active bus fixture available');

  printPlan('POST /buses/:id/location live-row upsert lookup', await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT recorded_at FROM bus_locations
    WHERE school_id = ${bus.school_id} AND bus_id = ${bus.id}
  `);
  printPlan('POST /buses/:id/location geofence next stop', await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT tss.id, tss.stop_id
    FROM trips t
    JOIN trip_stop_status tss ON tss.trip_id = t.id AND tss.school_id = ${bus.school_id}
    WHERE t.school_id = ${bus.school_id} AND t.bus_id = ${bus.id}
      AND t.status IN ('active', 'in_progress') AND tss.status = 'pending'
    ORDER BY t.created_at DESC, tss.stop_order ASC LIMIT 1
  `);
  printPlan('GET /my-bus/live current point', await sql`
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT latitude, longitude, speed, heading, recorded_at
    FROM bus_locations
    WHERE school_id = ${bus.school_id} AND bus_id = ${bus.id}
    ORDER BY recorded_at DESC LIMIT 1
  `);
} finally {
  await sql.end();
}
