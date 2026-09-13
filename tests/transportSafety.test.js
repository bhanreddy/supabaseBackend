import test from 'node:test';
import assert from 'node:assert/strict';
import { isSustainedOverspeed } from '../services/transportSafetyService.js';

test('isSustainedOverspeed rejects single spikes or insufficient data points', () => {
  const speedLimit = 50;
  const now = new Date('2026-09-05T10:00:00.000Z').getTime();

  // Case 1: Single spike
  const singleSpike = [
    { speed: 45, recorded_at: new Date(now).toISOString() },
    { speed: 72, recorded_at: new Date(now + 5000).toISOString() }, // 1 spike
    { speed: 48, recorded_at: new Date(now + 10000).toISOString() },
  ];
  assert.equal(isSustainedOverspeed(singleSpike, speedLimit, 15, 3).isOverspeed, false);

  // Case 2: 2 points only (minPoints = 3)
  const twoPoints = [
    { speed: 65, recorded_at: new Date(now).toISOString() },
    { speed: 68, recorded_at: new Date(now + 16000).toISOString() },
  ];
  assert.equal(isSustainedOverspeed(twoPoints, speedLimit, 15, 3).isOverspeed, false);
});

test('isSustainedOverspeed rejects consecutive overspeed that does not satisfy duration', () => {
  const speedLimit = 50;
  const now = new Date('2026-09-05T10:00:00.000Z').getTime();

  // 3 consecutive overspeed points, but only spanning 8 seconds (< 15s)
  const shortBurst = [
    { speed: 58, recorded_at: new Date(now).toISOString() },
    { speed: 62, recorded_at: new Date(now + 4000).toISOString() },
    { speed: 60, recorded_at: new Date(now + 8000).toISOString() },
    { speed: 45, recorded_at: new Date(now + 12000).toISOString() },
  ];

  const result = isSustainedOverspeed(shortBurst, speedLimit, 15, 3);
  assert.equal(result.isOverspeed, false);
  assert.equal(result.durationSeconds, 8);
});

test('isSustainedOverspeed detects sustained overspeed >= minPoints and >= sustainedSeconds', () => {
  const speedLimit = 50;
  const now = new Date('2026-09-05T10:00:00.000Z').getTime();

  // 4 consecutive overspeed points spanning 25 seconds
  const sustained = [
    { speed: 40, recorded_at: new Date(now).toISOString() },
    { speed: 55, recorded_at: new Date(now + 5000).toISOString() },
    { speed: 64, recorded_at: new Date(now + 15000).toISOString() },
    { speed: 70, recorded_at: new Date(now + 25000).toISOString() },
    { speed: 62, recorded_at: new Date(now + 30000).toISOString() },
  ];

  const result = isSustainedOverspeed(sustained, speedLimit, 15, 3);
  assert.equal(result.isOverspeed, true);
  assert.equal(result.pointsCount, 4);
  assert.equal(result.durationSeconds, 25);
  assert.equal(result.peakSpeed, 70);
  assert.equal(result.avgSpeed, 63); // (55 + 64 + 70 + 62) / 4 = 62.75 -> 63
});

test('evaluateOverspeed fast-path returns immediately when speed is zero or null', async () => {
  const { evaluateOverspeed } = await import('../services/transportSafetyService.js');

  // Passing dummy DB that throws if any query is executed
  const failingDb = () => { throw new Error('DB should not be queried on zero speed'); };

  const res1 = await evaluateOverspeed(1, 'bus-1', { speed: 0, recorded_at: new Date() }, failingDb);
  assert.equal(res1.checked, false);
  assert.equal(res1.reason, 'SPEED_ZERO_OR_NULL');

  const res2 = await evaluateOverspeed(1, 'bus-1', { speed: null, recorded_at: new Date() }, failingDb);
  assert.equal(res2.checked, false);
  assert.equal(res2.reason, 'SPEED_ZERO_OR_NULL');
});

test('triggerDriverSOS debounces rapid double-tap emergency triggers within 60s', async () => {
  const { triggerDriverSOS } = await import('../services/transportSafetyService.js');

  // Mock DB returning a recent active SOS incident
  let recentSosChecked = false;
  const mockDb = async (queryParts, ...params) => {
    const queryStr = String(queryParts);
    if (!recentSosChecked) {
      recentSosChecked = true;
      return [{ id: 'existing-sos-uuid', created_at: new Date() }];
    }
    return [{ name: 'Test School', contact_phone: '112', emergency_phone: '108' }];
  };

  const result = await triggerDriverSOS({
    schoolId: 1,
    busId: 'bus-1',
    driverId: 'drv-1',
    reason: 'PUNCTURE',
    db: mockDb,
  });

  assert.equal(result.success, true);
  assert.equal(result.debounced, true);
  assert.equal(result.incidentId, 'existing-sos-uuid');
  assert.ok(result.emergencyContacts.length >= 3);
});

test('updateIncidentStatus rejects invalid status values', async () => {
  const { updateIncidentStatus } = await import('../services/transportSafetyService.js');

  await assert.rejects(
    async () => {
      await updateIncidentStatus(1, 'inc-1', { status: 'invalid_status_xyz' });
    },
    { message: 'Invalid incident status: invalid_status_xyz' }
  );
});

test('reconcileSafeguardingAttendance handles missing school_id and disabled automation rule cleanly', async () => {
  const { reconcileSafeguardingAttendance } = await import('../services/transportSafeguardingService.js');

  // Case 1: missing schoolId
  const res1 = await reconcileSafeguardingAttendance({});
  assert.equal(res1.success, false);
  assert.equal(res1.reason, 'MISSING_SCHOOL_ID');

  // Case 2: mock DB where rule is disabled
  const mockDb = async (queryParts) => {
    const q = String(queryParts);
    if (q.includes('school_automation_rules')) {
      return [{ is_enabled: false, trigger_config: {} }];
    }
    return [];
  };

  const res2 = await reconcileSafeguardingAttendance({ schoolId: 999, db: mockDb });
  assert.equal(res2.success, false);
  assert.equal(res2.reason, 'RULE_DISABLED');
});

test('reconcileSafeguardingAttendance prevents false alarms when no students boarded morning bus', async () => {
  const { reconcileSafeguardingAttendance } = await import('../services/transportSafeguardingService.js');

  // Mock DB returning enabled rule, but zero anomalies
  const mockDb = async (queryParts) => {
    const q = String(queryParts);
    if (q.includes('school_automation_rules')) {
      return [{ is_enabled: true, trigger_config: { verification_window_minutes: 30 } }];
    }
    // Anomalies query returns empty array
    return [];
  };

  const res = await reconcileSafeguardingAttendance({ schoolId: 1, db: mockDb });
  assert.equal(res.success, true);
  assert.equal(res.anomaliesCount, 0);
});

test('reconcileSafeguardingAttendance detects anomaly when student boarded morning bus but marked absent in class', async () => {
  const { reconcileSafeguardingAttendance } = await import('../services/transportSafeguardingService.js');

  const mockDb = async (queryParts, ...params) => {
    const q = String(queryParts);
    if (q.includes('school_automation_rules')) {
      return [{ is_enabled: true, trigger_config: { verification_window_minutes: 30 } }];
    }
    if (q.includes('bus_stop_attendance ba')) {
      return [{
        student_id: '00000000-0000-0000-0000-000000000010',
        student_name: 'Ananya Sharma',
        admission_no: '2026-042',
        class_id: 1,
        class_name: 'Class 5',
        section_id: 1,
        section_name: 'A',
        class_section_id: 1,
        class_teacher_id: null,
        bus_attendance_id: 'ba-1',
        trip_id: 'trip-1',
        bus_marked_at: new Date().toISOString(),
        classroom_attendance_id: 'ca-1',
        classroom_marked_at: new Date().toISOString(),
        bus_id: 'bus-1',
        bus_no: 'TS09UB1234',
        route_id: 'route-1',
        route_name: 'Route 1 North',
        stop_name: 'Kukatpally Stop',
      }];
    }
    if (q.includes('UPDATE transport_safety_incidents')) {
      return [];
    }
    if (q.includes('FROM transport_safety_incidents') && q.includes('SELECT id')) {
      // Check for existing incident returns none
      return [];
    }
    if (q.includes('INSERT INTO transport_safety_incidents')) {
      return [{
        id: 'inc-anomaly-1',
        incident_type: 'safeguarding_anomaly',
        status: 'verification_pending',
        school_id: 1,
      }];
    }
    return [];
  };

  mockDb.json = (val) => val;

  const res = await reconcileSafeguardingAttendance({ schoolId: 1, db: mockDb });
  assert.equal(res.success, true);
  assert.equal(res.anomaliesCount, 1);
  assert.equal(res.anomalies[0].status, 'verification_pending');
});


