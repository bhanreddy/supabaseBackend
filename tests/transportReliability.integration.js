import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import express from 'express';
import { initializeReleaseDatabase } from '../scripts/migrate_release.js';
const url = process.env.TRANSPORT_TEST_DATABASE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('An explicit local TRANSPORT_TEST_DATABASE_URL is required');
const admin = postgres(url, {
    ssl: false,
    max: 1,
    onnotice: () => {}
  }),
  name = `schoolims_transport_test_${process.pid}`;
await admin.unsafe(`CREATE DATABASE ${name}`);
const local = new URL(url);
local.pathname = '/' + name;
const db = postgres(local.toString(), {
  ssl: false,
  max: 12,
  onnotice: () => {}
});
mock.module('../db.js', {
  defaultExport: db,
  namedExports: {
    supabase: {},
    supabaseAdmin: {}
  }
});
mock.module('../config/env.js', {
  defaultExport: {
    nodeEnv: 'test',
    logLevel: 'silent',
    transportJobs: {
      enabled: false
    }
  }
});
mock.module('../config/firebase.js', {
  defaultExport: {
    messaging: () => ({
      sendEachForMulticast: async () => {
        throw new Error('Unexpected provider call in local test');
      }
    })
  }
});
mock.module('../middleware/auth.js', {
  namedExports: {
    requireAuth: (req, res, next) => next(),
    requirePermission: permission => (req, res, next) => req.user.permissions.includes(permission) ? next() : res.status(403).json({
      error: 'Forbidden'
    })
  }
});
mock.module('../services/geminiTranslator.js', {
  namedExports: {
    translateFields: async value => value
  }
});
const tripService = await import('../services/transportTripService.js');
const {
  ingestLocationBatch,
  normalizeLocationBatch
} = await import('../services/transportLocationIngestService.js');
const {
  drainTransportOutbox,
  enqueueTransportUsers
} = await import('../services/transportOutboxService.js');
const {
  shouldAutoArrive
} = await import('../services/transportGeofenceService.js');
const {
  computeLearnedEta
} = await import('../services/transportEtaService.js');
const {
  isUsableFix
} = await import('../services/transportCalibrationService.js');
const {
  default: router
} = await import('../routes/transportRoutes.js');
const {
  triggerDriverSOS
} = await import('../services/transportSafetyService.js');
const {
  sendNotificationToUsersWithReport
} = await import('../services/notificationService.js');
let server,
  fixture,
  trip,
  requestOverride = null;
const request = () => ({
  schoolId: fixture.school,
  user: {
    internal_id: fixture.user,
    roles: ['driver'],
    permissions: []
  }
});
async function seed() {
  const [school] = await db`INSERT INTO schools(name,code) VALUES('Transport Test',${randomUUID()}) RETURNING id`;
  const [p] = await db`INSERT INTO persons(school_id,first_name,gender_id) VALUES(${school.id},'Driver',1) RETURNING id`;
  const [staff] = await db`INSERT INTO staff(school_id,person_id,staff_code,joining_date) VALUES(${school.id},${p.id},'D1','2026-01-01') RETURNING id`;
  const [user] = await db`INSERT INTO users(school_id,person_id) VALUES(${school.id},${p.id}) RETURNING id`;
  const [bus] = await db`INSERT INTO buses(school_id,bus_no,driver_id) VALUES(${school.id},'TEST',${staff.id}) RETURNING id`;
  const [route] = await db`INSERT INTO transport_routes(school_id,name,bus_id,direction) VALUES(${school.id},'Test route',${bus.id},'both') RETURNING id`;
  const stops = [];
  for (let n = 1; n <= 3; n++) {
    const [s] = await db`INSERT INTO transport_stops(school_id,route_id,name,stop_order,latitude,longitude) VALUES(${school.id},${route.id},${'Stop ' + n},${n},${17 + n / 100},78) RETURNING id`;
    stops.push(s.id);
  }
  const [year] = await db`INSERT INTO academic_years(school_id,code,start_date,end_date) VALUES(${school.id},'2026','2026-04-01','2027-03-31') RETURNING id`;
  const [childPerson] = await db`INSERT INTO persons(school_id,first_name,gender_id) VALUES(${school.id},'Child',1) RETURNING id`;
  const [student] = await db`INSERT INTO students(school_id,person_id,admission_no,admission_date,status_id) VALUES(${school.id},${childPerson.id},'S1','2026-04-01',1) RETURNING id`;
  const [parentPerson] = await db`INSERT INTO persons(school_id,first_name,gender_id) VALUES(${school.id},'Parent',1) RETURNING id`;
  const [parent] = await db`INSERT INTO parents(school_id,person_id) VALUES(${school.id},${parentPerson.id}) RETURNING id`;
  const [parentUser] = await db`INSERT INTO users(school_id,person_id) VALUES(${school.id},${parentPerson.id}) RETURNING id`;
  await db`INSERT INTO student_parents(school_id,student_id,parent_id) VALUES(${school.id},${student.id},${parent.id})`;
  await db`INSERT INTO student_transport(school_id,student_id,route_id,stop_id,bus_id,academic_year_id) VALUES(${school.id},${student.id},${route.id},${stops[0]},${bus.id},${year.id})`;
  return {
    school: school.id,
    user: user.id,
    driver: staff.id,
    bus: bus.id,
    route: route.id,
    stops,
    student: student.id,
    parentUser: parentUser.id
  };
}
try {
  await test('fresh release migration and repeated upgrade SQL succeed', async () => {
    await db.unsafe(fs.readFileSync(new URL('./support/supabasePlatform.sql', import.meta.url), 'utf8'));
    await db`ALTER TABLE auth.users ADD COLUMN encrypted_password text,ADD COLUMN email text,ADD COLUMN banned_until timestamptz`;
    await initializeReleaseDatabase(db);
    await db.unsafe(fs.readFileSync(new URL('../migrations/20260921_transport_reliability.sql', import.meta.url), 'utf8'));
    fixture = await seed();
  });
  await test('driver GET does not create trips and concurrent starts return one trip', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      Object.assign(req, requestOverride || request());
      next();
    });
    app.use(router);
    app.use((err, req, res, next) => res.status(err.status || 500).json({
      error: err.message
    }));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/driver/my-trip');
    assert.equal(response.status, 200);
    const [{
      count
    }] = await db`SELECT count(*)::int FROM trips WHERE school_id=${fixture.school}`;
    assert.equal(count, 0);
    const results = await Promise.all(Array.from({
      length: 6
    }, () => tripService.startTransportTrip(request(), {
      route_id: fixture.route,
      trip_direction: 'morning'
    }, db)));
    assert.equal(new Set(results.map(r => r.id)).size, 1);
    trip = results[0];
    const lease = await fetch(base + `/trips/${trip.id}/tracking-session`, {
      method: 'POST',
      headers: {
        'X-Device-Id': 'test-device',
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(lease.status, 200, await lease.text());
    const conflict = await fetch(base + `/trips/${trip.id}/tracking-session`, {
      method: 'POST',
      headers: {
        'X-Device-Id': 'other-device',
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(conflict.status, 409);
  });
  const fix = (offset = 0, extra = {}) => ({
    fix_id: randomUUID(),
    latitude: 17.01,
    longitude: 78,
    accuracy: 5,
    speed: 0,
    heading: null,
    recorded_at: new Date(Date.now() + offset).toISOString(),
    ...extra
  });
  const ingest = fixes => ingestLocationBatch({
    schoolId: fixture.school,
    busId: fixture.bus,
    tripId: trip.id,
    sessionId: trip.tracking_session_id,
    deviceId: 'test-device',
    driverId: fixture.driver,
    fixes
  }, db);
  await test('strict validation isolates poison points and acknowledges valid points', async () => {
    const data = await ingest([fix(0, {
      latitude: null
    }), fix(0, {
      heading: -1
    }), fix(0, {
      accuracy: -5
    }), fix()]);
    assert.equal(data.insertedCount, 1);
    assert.deepEqual(data.acknowledgements.map(a => a.status), ['rejected', 'rejected', 'rejected', 'accepted']);
    assert.equal(normalizeLocationBatch([fix(0, {
      latitude: '17'
    })]).invalidCount, 1);
  });
  await test('history and live update roll back together, then retry heals', async () => {
    await db.unsafe(`CREATE FUNCTION test_live_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected live failure'; END $$; CREATE TRIGGER test_live_failure BEFORE INSERT OR UPDATE ON bus_locations FOR EACH ROW EXECUTE FUNCTION test_live_failure()`);
    const point = fix(1000);
    await assert.rejects(() => ingest([point]), /injected live failure/);
    const [{
      count
    }] = await db`SELECT count(*)::int FROM bus_trip_history WHERE fix_id=${point.fix_id}`;
    assert.equal(count, 0);
    await db.unsafe('DROP TRIGGER test_live_failure ON bus_locations');
    const retried = await ingest([point]);
    assert.equal(retried.insertedCount, 1);
    assert.equal(retried.realtimeUpdated, true);
    assert.equal((await ingest([point])).insertedCount, 0);
  });
  await test('historical, mocked, future, wrong-session points cannot advance live state', async () => {
    await db`UPDATE trips SET started_at=now()-interval '1 hour' WHERE id=${trip.id}`;
    const [before] = await db`SELECT recorded_at FROM bus_locations WHERE bus_id=${fixture.bus}`;
    await ingest([fix(-120000), fix(2000, {
      is_mocked: true
    }), fix(60000)]);
    const [after] = await db`SELECT recorded_at FROM bus_locations WHERE bus_id=${fixture.bus}`;
    assert.equal(+before.recorded_at, +after.recorded_at);
    await assert.rejects(() => ingestLocationBatch({
      schoolId: fixture.school,
      busId: fixture.bus,
      tripId: trip.id,
      sessionId: randomUUID(),
      deviceId: 'test-device',
      driverId: fixture.driver,
      fixes: [fix()]
    }, db), e => e.transportCode === 'TRACKING_SESSION_CHANGED');
  });
  await test('stop transitions enforce sequence and concurrent retry changes once', async () => {
    await assert.rejects(() => tripService.transitionTransportStop(request(), trip.id, fixture.stops[1], 'arrive', {}, db), e => e.transportCode === 'STOP_ORDER');
    await Promise.all(Array.from({
      length: 4
    }, () => tripService.transitionTransportStop(request(), trip.id, fixture.stops[0], 'arrive', {}, db)));
    const [{
      count
    }] = await db`SELECT count(*)::int FROM transport_audit_events WHERE trip_id=${trip.id}`;
    assert.equal(count, 1);
    await tripService.transitionTransportStop(request(), trip.id, fixture.stops[0], 'complete', {}, db);
  });
  await test('outbox retries provider failure and records inbox-only without claiming push', async () => {
    await enqueueTransportUsers({
      schoolId: fixture.school,
      tripId: trip.id,
      key: 'test',
      type: 'TRANSPORT_OVERSPEED_ALERT',
      userIds: [fixture.user]
    }, db);
    await drainTransportOutbox(db, async () => {
      throw new Error('offline');
    });
    let [row] = await db`SELECT * FROM transport_outbox WHERE event_key=${'test:' + fixture.user}`;
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    await db`UPDATE transport_outbox SET available_at=now() WHERE id=${row.id}`;
    await drainTransportOutbox(db, async () => ({
      successCount: 0,
      failureCount: 0,
      noTokenCount: 1
    }));
    [row] = await db`SELECT * FROM transport_outbox WHERE id=${row.id}`;
    assert.equal(row.status, 'inbox_only');
  });
  await test('real parent/admin read queries and attendance authorization use current assignment', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    requestOverride = {
      schoolId: fixture.school,
      user: {
        internal_id: fixture.parentUser,
        roles: ['parent'],
        permissions: []
      }
    };
    for (const path of ['/my-bus', '/my-bus/live', `/buses/${fixture.bus}/location`, `/parent/bus-status/${fixture.bus}`]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, `${path}: ${await response.text()}`);
    }
    const denied = await fetch(base + `/driver/bus-attendance/summary?trip_id=${trip.id}`);
    assert.equal(denied.status, 403);
    await db`UPDATE student_transport SET is_active=false WHERE student_id=${fixture.student}`;
    assert.equal((await fetch(base + `/buses/${fixture.bus}/location`)).status, 403);
    await db`UPDATE student_transport SET is_active=true WHERE student_id=${fixture.student}`;
    requestOverride = {
      ...request(),
      user: {
        ...request().user,
        permissions: ['transport.view']
      }
    };
    for (const path of [`/routes/${fixture.route}/live`, '/live-today']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, await response.text());
    }
    requestOverride = null;
    const mark = body => fetch(base + '/driver/bus-attendance/mark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const body = {
      trip_id: trip.id,
      route_id: fixture.route,
      stop_id: fixture.stops[0],
      attendance: [{
        student_id: fixture.student,
        status: 'present'
      }]
    };
    const response = await mark(body);
    assert.equal(response.status, 200, await response.text());
    assert.equal((await mark({
      ...body,
      stop_id: fixture.stops[1]
    })).status, 403);
    assert.equal((await mark({
      ...body,
      date: '2026-01-01'
    })).status, 409);
    assert.equal((await fetch(base + `/driver/bus-attendance/summary?trip_id=${trip.id}`)).status, 200);
  });
  await test('real inbox creation is idempotent when there are no device tokens', async () => {
    const context = {
      schoolId: fixture.school,
      idempotencyKey: 'test-inbox',
      requireInbox: true
    };
    const first = await sendNotificationToUsersWithReport([fixture.parentUser], 'BUS_STOP_REACHED', {
      stopName: 'Stop 1'
    }, context);
    const second = await sendNotificationToUsersWithReport([fixture.parentUser], 'BUS_STOP_REACHED', {
      stopName: 'Stop 1'
    }, context);
    assert.equal(first.noTokenCount, 1);
    assert.equal(second.noTokenCount, 1);
    const [{
      count
    }] = await db`SELECT count(*)::int FROM notifications n JOIN notification_events e ON e.id=n.event_id AND e.school_id=n.school_id
     WHERE e.school_id=${fixture.school} AND e.idempotency_key=${'test-inbox:' + fixture.parentUser}`;
    assert.equal(count, 1);
  });
  await test('SOS uses canonical schema and retries return the recorded incident', async () => {
    const input = {
      schoolId: fixture.school,
      busId: fixture.bus,
      driverId: fixture.driver,
      tripId: trip.id,
      lat: 0,
      lng: 0,
      db
    };
    const [one, two] = await Promise.all([triggerDriverSOS(input), triggerDriverSOS(input)]);
    assert.ok(one.incidentId);
    assert.equal(one.incidentId, two.incidentId);
    const [record] = await db`SELECT start_latitude,start_longitude FROM transport_safety_incidents WHERE id=${one.incidentId}`;
    assert.equal(Number(record.start_latitude), 0);
    assert.equal(Number(record.start_longitude), 0);
  });
  await test('route changes preserve trip snapshots and invalidate calibration', async () => {
    const before = await tripService.tripStops(trip, db);
    await db`UPDATE transport_stops SET latitude=20 WHERE id=${fixture.stops[0]}`;
    const after = await tripService.tripStops(trip, db);
    assert.equal(before[0].latitude, after[0].latitude);
    const [route] = await db`SELECT revision FROM transport_routes WHERE id=${fixture.route}`;
    assert.ok(route.revision > trip.route_revision);
  });
  await test('ending trips is idempotent; historical retry after end cannot publish live', async () => {
    const results = await Promise.all([tripService.finishTransportTrip(request(), trip.id, 'test', db), tripService.finishTransportTrip(request(), trip.id, 'test', db)]);
    assert.ok(results.every(r => r.status === 'completed'));
    const stops = await tripService.tripStops(trip, db);
    assert.deepEqual(stops.map(s => s.status), ['completed', 'skipped', 'skipped']);
    assert.equal((await ingest([fix(-10000)])).realtimeUpdated, false);
  });
  await test('fresh replay requires reliable slow fixes and advances exactly one ordered stop', async () => {
    trip = await tripService.startTransportTrip(request(), {
      route_id: fixture.route,
      trip_direction: 'morning'
    }, db);
    await db`UPDATE trips SET tracking_device_id='test-device',auto_stops_enabled=true,started_at=now()-interval '1 minute' WHERE id=${trip.id}`;
    const now = Date.now();
    await ingest([fix(-25000, {
      latitude: 20,
      speed: 60
    }), fix(-15000, {
      latitude: 20,
      speed: 60
    })]);
    let stops = await tripService.tripStops(trip, db);
    assert.equal(stops[0].status, 'pending');
    await ingest([fix(-10000, {
      latitude: 20,
      speed: 0,
      accuracy: 100
    })]);
    stops = await tripService.tripStops(trip, db);
    assert.equal(stops[0].status, 'pending');
    await ingest([fix(-5000, {
      latitude: 20,
      speed: 0
    }), fix(-1000, {
      latitude: 20,
      speed: 0
    })]);
    stops = await tripService.tripStops(trip, db);
    assert.equal(stops[0].status, 'arrived');
    await ingest([fix(0, {
      latitude: 20.003,
      speed: 10
    })]);
    stops = await tripService.tripStops(trip, db);
    assert.equal(stops[0].status, 'completed');
    assert.equal(stops[1].status, 'pending');
    await tripService.finishTransportTrip(request(), trip.id, 'test', db);
  });
  await test('calibration finalization increments once for each complete trip', async () => {
    trip = await tripService.startTransportTrip(request(), {
      route_id: fixture.route,
      trip_direction: 'morning'
    }, db);
    for (const stopId of fixture.stops) {
      await tripService.transitionTransportStop(request(), trip.id, stopId, 'arrive', {
        latitude: 17,
        longitude: 78,
        accuracy: 5,
        recorded_at: new Date().toISOString()
      }, db);
      await tripService.transitionTransportStop(request(), trip.id, stopId, 'complete', {}, db);
      await db`UPDATE trip_stop_status SET departure_time=now()-interval '10 seconds' WHERE trip_id=${trip.id} AND stop_id=${stopId}`;
    }
    await Promise.all(Array.from({
      length: 5
    }, () => tripService.finishTransportTrip(request(), trip.id, 'test', db)));
    const [cal] = await db`SELECT clean_trip_count FROM route_leg_calibration WHERE school_id=${fixture.school} AND route_id=${fixture.route} AND trip_direction='morning'`;
    assert.equal(cal.clean_trip_count, 1);
  });
  await test('cross-tenant access and direct client access to internal tables are denied', async () => {
    const stranger = {
      ...request(),
      schoolId: fixture.school + 9999
    };
    await assert.rejects(() => tripService.finishTransportTrip(stranger, trip.id, 'test', db), e => e.transportCode === 'TRIP_NOT_FOUND');
    await assert.rejects(() => db.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE authenticated');
      await tx`SELECT * FROM transport_outbox`;
    }), e => e.code === '42501');
  });
  await test('admin reorder rejects duplicates and calibration reset validates query safely', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    requestOverride = {
      ...request(),
      user: {
        ...request().user,
        permissions: ['transport.manage', 'transport.view']
      }
    };
    const reorder = ids => fetch(base + `/routes/${fixture.route}/stops/reorder`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderedStopIds: ids
      })
    });
    assert.equal((await reorder([fixture.stops[0], fixture.stops[0], fixture.stops[1]])).status, 400);
    const valid = await reorder([...fixture.stops].reverse());
    assert.equal(valid.status, 200, await valid.text());
    const reset = await fetch(base + `/routes/${fixture.route}/calibration/reset?trip_direction=morning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(reset.status, 200, await reset.text());
    requestOverride = null;
  });
  await test('outbox recovers an abandoned lease and remembers successful device deliveries', async () => {
    await enqueueTransportUsers({
      schoolId: fixture.school,
      key: 'partial',
      type: 'TRANSPORT_OVERSPEED_ALERT',
      userIds: [fixture.user]
    }, db);
    await db`UPDATE transport_outbox SET status='processing',available_at=now()-interval '1 minute',lease_id=gen_random_uuid() WHERE event_key=${'partial:' + fixture.user}`;
    await drainTransportOutbox(db, async () => ({
      successCount: 1,
      failureCount: 1,
      tokenResults: [{
        token: 'synthetic-token',
        success: true
      }]
    }));
    let [row] = await db`SELECT * FROM transport_outbox WHERE event_key=${'partial:' + fixture.user}`;
    assert.equal(row.status, 'pending');
    assert.equal(row.payload.delivered_token_hashes.length, 1);
    assert.notEqual(row.payload.delivered_token_hashes[0], 'synthetic-token');
    await db`UPDATE transport_outbox SET available_at=now() WHERE id=${row.id}`;
    let exclusionSeen = false;
    await drainTransportOutbox(db, async (_users, _type, _vars, context) => {
      if (context.idempotencyKey === `transport:${row.id}`) exclusionSeen = context.deliveredTokenHashes.length === 1;
      return {
        successCount: 1,
        failureCount: 0
      };
    });
    [row] = await db`SELECT * FROM transport_outbox WHERE id=${row.id}`;
    assert.equal(row.status, 'sent');
    assert.equal(exclusionSeen, true);
  });
  await test('ten concurrent bus backlogs persist one thousand fixes without partial loss', async () => {
    const samples = [];
    for (let n = 0; n < 10; n++) {
      const f = await seed();
      const req = {
        schoolId: f.school,
        user: {
          internal_id: f.user,
          roles: ['driver'],
          permissions: []
        }
      };
      const t = await tripService.startTransportTrip(req, {
        route_id: f.route,
        trip_direction: 'morning'
      }, db);
      await db`UPDATE trips SET started_at=now()-interval '1 hour',tracking_device_id='load-device' WHERE id=${t.id}`;
      samples.push({
        f,
        t
      });
    }
    const durations = await Promise.all(samples.map(async ({
      f,
      t
    }) => {
      const begin = performance.now();
      const now = Date.now();
      const result = await ingestLocationBatch({
        schoolId: f.school,
        busId: f.bus,
        tripId: t.id,
        sessionId: t.tracking_session_id,
        deviceId: 'load-device',
        driverId: f.driver,
        fixes: Array.from({
          length: 100
        }, (_, i) => ({
          fix_id: randomUUID(),
          latitude: 17.01,
          longitude: 78,
          accuracy: 5,
          speed: 0,
          heading: null,
          recorded_at: new Date(now - 1000000 + i * 5000).toISOString()
        }))
      }, db);
      assert.equal(result.insertedCount, 100);
      return performance.now() - begin;
    }));
    durations.sort((a, b) => a - b);
    console.log(`Local replay: 10 concurrent buses, 1000 historical fixes, slowest batch ${Math.round(durations.at(-1))} ms`);
    assert.ok(durations.at(-1) < 5000, 'Local backlog ingest unexpectedly exceeded five seconds');
  });
  await test('ETA and calibration decline missing/stale/invalid evidence; high-speed dwell is not arrival', () => {
    const stops = [{
      id: 's',
      status: 'pending',
      latitude: 17,
      longitude: 78
    }];
    assert.equal(computeLearnedEta({
      location: {
        latitude: 17,
        longitude: 78,
        recorded_at: new Date(Date.now() - 180000).toISOString()
      },
      stops,
      boardingStopId: 's'
    }).eta_minutes, null);
    assert.equal(computeLearnedEta({
      location: fix(),
      stops: [{
        id: 's',
        status: 'skipped'
      }],
      boardingStopId: 's'
    }).eta_minutes, null);
    assert.equal(isUsableFix({
      latitude: 91,
      longitude: 0,
      accuracy: 5,
      recorded_at: new Date().toISOString()
    }), false);
    assert.equal(shouldAutoArrive({
      hits: 5,
      firstSeenMs: 0,
      nowMs: 20000,
      speedKmh: 50,
      distM: 10,
      radiusM: 100
    }), false);
  });
} finally {
  if (server) await new Promise(r => server.close(r));
  await db.end();
  await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
