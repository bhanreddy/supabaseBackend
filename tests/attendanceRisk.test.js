import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAttendancePercentage,
  classifyAttendanceRisk,
  shouldSendRiskAlert
} from '../services/attendanceRiskService.js';

test('calculateAttendancePercentage computes strictly using authoritative formula', () => {
  // 10 present, 2 late, 2 half_day, 6 absent out of 20 total
  // (10 + 2 + 0.5 * 2) / 20 * 100 = (13 / 20) * 100 = 65.0%
  const pct = calculateAttendancePercentage({
    present: 10,
    late: 2,
    half_day: 2,
    absent: 6,
    total: 20
  });
  assert.equal(pct, 65.0);

  // 0 total sessions
  assert.equal(calculateAttendancePercentage({ total: 0 }), 0);

  // 100% present
  assert.equal(calculateAttendancePercentage({ present: 50, late: 0, half_day: 0, total: 50 }), 100.0);

  // Half day only: 1 session
  assert.equal(calculateAttendancePercentage({ present: 0, late: 0, half_day: 1, total: 1 }), 50.0);
});

test('classifyAttendanceRisk assigns correct tier based on warning and critical thresholds', () => {
  const config = {
    warning_threshold_pct: 80,
    critical_threshold_pct: 75
  };

  assert.equal(classifyAttendanceRisk(85.0, config), 'HEALTHY');
  assert.equal(classifyAttendanceRisk(80.0, config), 'HEALTHY');
  assert.equal(classifyAttendanceRisk(78.5, config), 'APPROACHING_RISK');
  assert.equal(classifyAttendanceRisk(75.0, config), 'APPROACHING_RISK');
  assert.equal(classifyAttendanceRisk(74.9, config), 'BELOW_THRESHOLD');
  assert.equal(classifyAttendanceRisk(60.0, config), 'BELOW_THRESHOLD');
});

test('shouldSendRiskAlert enforces hysteresis and cooldown periods', () => {
  const config = {
    cooldown_days: 7,
    recovery_buffer_pct: 3,
    critical_threshold_pct: 75,
    warning_threshold_pct: 80
  };

  const now = new Date('2026-09-05T12:00:00Z');

  // Case 1: First time below threshold, no previous alert
  const alert1 = shouldSendRiskAlert({
    currentTier: 'BELOW_THRESHOLD',
    previousTier: 'HEALTHY',
    attendancePct: 70,
    lastAlertAt: null,
    now,
    config
  });
  assert.equal(alert1.shouldAlert, true);
  assert.equal(alert1.alertType, 'CRITICAL');

  // Case 2: In cooldown window (e.g. alerted 3 days ago for same tier)
  const threeDaysAgo = new Date('2026-09-02T12:00:00Z');
  const alert2 = shouldSendRiskAlert({
    currentTier: 'BELOW_THRESHOLD',
    previousTier: 'BELOW_THRESHOLD',
    attendancePct: 69,
    lastAlertAt: threeDaysAgo,
    now,
    config
  });
  assert.equal(alert2.shouldAlert, false);
  assert.equal(alert2.reason, 'COOLDOWN_ACTIVE');

  // Case 3: Cooldown elapsed (8 days ago), still BELOW_THRESHOLD -> can remind
  const eightDaysAgo = new Date('2026-08-28T12:00:00Z');
  const alert3 = shouldSendRiskAlert({
    currentTier: 'BELOW_THRESHOLD',
    previousTier: 'BELOW_THRESHOLD',
    attendancePct: 68,
    lastAlertAt: eightDaysAgo,
    now,
    config
  });
  assert.equal(alert3.shouldAlert, true);

  // Case 4: Hysteresis recovery - critical threshold is 75, buffer is 3 -> recovery target is 78%
  // If student reaches 76%, they should not be cleared to HEALTHY if previous was BELOW_THRESHOLD
  const alert4 = shouldSendRiskAlert({
    currentTier: 'HEALTHY',
    previousTier: 'BELOW_THRESHOLD',
    attendancePct: 76, // Above 75, but below 75 + 3 = 78
    lastAlertAt: eightDaysAgo,
    now,
    config
  });
  assert.equal(alert4.effectiveTier, 'APPROACHING_RISK');

  // Case 5: Full recovery above critical + buffer (79% > 75 + 3) -> effectively HEALTHY, no alert
  const alert5 = shouldSendRiskAlert({
    currentTier: 'HEALTHY',
    previousTier: 'BELOW_THRESHOLD',
    attendancePct: 79,
    lastAlertAt: eightDaysAgo,
    now,
    config
  });
  assert.equal(alert5.shouldAlert, false);
  assert.equal(alert5.effectiveTier, 'HEALTHY');
});

test('classifyAttendanceRisk protects new students with fewer than min_total_days', () => {
  const config = {
    warning_threshold_pct: 78,
    critical_threshold_pct: 75,
    min_total_days: 5,
  };

  // Student attended 1 out of 3 days (33.3%), but totalSessions < 5
  assert.equal(classifyAttendanceRisk(33.3, 3, config), 'HEALTHY');
  // Student attended 0 out of 2 days (0%), but totalSessions < 5
  assert.equal(classifyAttendanceRisk(0, 2, config), 'HEALTHY');
  // Student with null percentage
  assert.equal(classifyAttendanceRisk(null, 10, config), 'HEALTHY');
  // Student with 10 sessions and 70% -> BELOW_THRESHOLD
  assert.equal(classifyAttendanceRisk(70.0, 10, config), 'BELOW_THRESHOLD');
});

test('updateStudentIntervention validates status enum strictly', async () => {
  const { updateStudentIntervention } = await import('../services/attendanceRiskService.js');

  await assert.rejects(
    async () => {
      await updateStudentIntervention(1, 'student-uuid', { status: 'invalid_status_xyz' });
    },
    { message: 'Invalid intervention status: invalid_status_xyz' }
  );
});
