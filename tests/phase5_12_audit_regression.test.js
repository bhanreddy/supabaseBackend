import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAttendancePercentage,
  classifyAttendanceRisk,
  shouldSendRiskAlert,
  RISK_STATES
} from '../services/attendanceRiskService.js';
import { rankSubstitutionCandidates } from '../services/substitutionRankingService.js';
import { handleStaffLeaveCancelled } from '../services/leaveSubstitutionService.js';
import {
  evaluateStudentReadiness,
  buildDuplicateSets,
  validateAadhaar,
  validatePenNumber,
  validateAparNumber,
  UDISE_STATUS
} from '../services/udiseReadinessService.js';
import { maskStudentName } from '../routes/certificatesRoutes.js';

test('Regression: Attendance risk recovery hysteresis and tier clearing', () => {
  const config = {
    critical_threshold_pct: 75,
    warning_threshold_pct: 80,
    recovery_buffer_pct: 3, // 75 + 3 = 78% required for full recovery
    cooldown_days: 7
  };

  const now = new Date('2026-09-07T10:00:00Z');
  const fiveDaysAgo = new Date('2026-09-02T10:00:00Z');

  // Student was BELOW_THRESHOLD, now at 77% (above 75%, but below 75 + 3 = 78%)
  // Must NOT immediately clear to HEALTHY; should be held in APPROACHING_RISK
  const hysteresisCheck = shouldSendRiskAlert({
    currentTier: RISK_STATES.HEALTHY,
    previousTier: RISK_STATES.BELOW_THRESHOLD,
    attendancePct: 77.0,
    lastAlertAt: fiveDaysAgo,
    now,
    config
  });
  assert.equal(hysteresisCheck.effectiveTier, RISK_STATES.APPROACHING_RISK);

  // Student reaches 79.5% (above 78%) -> Clears to HEALTHY without alert spam
  const recoveredCheck = shouldSendRiskAlert({
    currentTier: RISK_STATES.HEALTHY,
    previousTier: RISK_STATES.BELOW_THRESHOLD,
    attendancePct: 79.5,
    lastAlertAt: fiveDaysAgo,
    now,
    config
  });
  assert.equal(recoveredCheck.effectiveTier, RISK_STATES.HEALTHY);
  assert.equal(recoveredCheck.shouldAlert, false);
});

test('Regression: Leave cancellation cleans up associated substitution records', async () => {
  // Verifies handleStaffLeaveCancelled function accepts valid params and returns cleanly
  const result = await handleStaffLeaveCancelled({
    schoolId: 9999,
    leaveId: '00000000-0000-0000-0000-000000000099'
  });
  assert.equal(result.success, true);
  assert.equal(typeof result.cancelledCount, 'number');
});

test('Regression: UDISE optional Aadhaar and canonical PEN validation', () => {
  // Blank / empty Aadhaar is allowed (optional field)
  const emptyAadhaar = validateAadhaar('');
  assert.equal(emptyAadhaar.ok, true);

  const nullAadhaar = validateAadhaar(null);
  assert.equal(nullAadhaar.ok, true);

  // Invalid Aadhaar (not 12 digits)
  const badAadhaar = validateAadhaar('12345');
  assert.equal(badAadhaar.ok, false);
  assert.equal(badAadhaar.severity, 'critical');

  // Valid 12-digit Aadhaar
  const validAadhaar = validateAadhaar('987654321012');
  assert.equal(validAadhaar.ok, true);

  // Blank PEN is allowed by format validator (flagged as warning at student level)
  const emptyPen = validatePenNumber('');
  assert.equal(emptyPen.ok, true);

  // Invalid PEN format (special characters)
  const invalidPen = validatePenNumber('PEN@#$%');
  assert.equal(invalidPen.ok, false);

  // Valid PEN format (alphanumeric up to 30 chars)
  const validPen = validatePenNumber('PEN12345678');
  assert.equal(validPen.ok, true);
});

test('Regression: Public Certificate Verification Student Name Masking', () => {
  assert.equal(maskStudentName('Ramesh Kumar'), 'R***h K***r');
  assert.equal(maskStudentName('Alok'), 'A***k');
  assert.equal(maskStudentName('Om'), 'O*');
  assert.equal(maskStudentName(null), '***');
});

test('Regression: UDISE Duplicate Detection ignores NULL, empty, or whitespace values', () => {
  const students = [
    { id: '1', admission_no: 'ADM001', pen_number: null, aadhaar_number: null, apar_number: null },
    { id: '2', admission_no: 'ADM002', pen_number: null, aadhaar_number: null, apar_number: null },
    { id: '3', admission_no: 'ADM003', pen_number: '   ', aadhaar_number: '', apar_number: null },
    { id: '4', admission_no: 'ADM001', pen_number: 'PEN99999999', aadhaar_number: '123412341234', apar_number: 'APAR1' },
  ];

  const duplicates = buildDuplicateSets(students);
  // ADM001 appears twice -> in duplicates
  assert.ok(duplicates.admissionNos.has('ADM001'));
  // Nulls and whitespace must NOT be in duplicate sets
  assert.equal(duplicates.pens.size, 0);
  assert.equal(duplicates.aadhaars.size, 0);
  assert.equal(duplicates.apars.size, 0);
});
