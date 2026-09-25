import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  HallTicketBatchError,
  assertNoClientRoster,
  buildEligibility,
  clearanceFromFeeRows,
  historyFlags,
  inClearanceRange,
  nextBatchStatus,
  parseBatchOptions,
  parseClearanceFilters,
  relevantHistory,
} from '../services/hallTicketBatchService.js';

const YEAR = 'year-1';
const OTHER_YEAR = 'year-0';
const SECTION_A = 'section-a';
const SECTION_B = 'section-b';

function fee(overrides = {}) {
  return {
    academic_year_id: YEAR,
    section_id: null,
    amount_due: 100,
    amount_paid: 0,
    discount: 0,
    fee_code: 'TUITION',
    fee_name: 'Tuition',
    deleted_at: null,
    student_fee_deleted_at: null,
    mode_deactivated: false,
    is_transport: false,
    ...overrides,
  };
}

const perClass = { academicYearId: YEAR, feeMode: 'per_class', sectionId: SECTION_A };
const perSection = { academicYearId: YEAR, feeMode: 'per_section', sectionId: SECTION_A };

function student(overrides = {}) {
  return {
    id: 's1',
    clearance_percent: 100,
    previously_downloaded: false,
    temporarily_reserved: false,
    ...overrides,
  };
}

test('clearance range is inclusive to two decimal places', () => {
  assert.equal(inClearanceRange(10, 10, 20), true);
  assert.equal(inClearanceRange(10, 10, 20), true);
  assert.equal(inClearanceRange(20, 10, 20), true);
  assert.equal(inClearanceRange(20.01, 10, 20), false);
  assert.equal(inClearanceRange(9.99, 10, 20), false);
  assert.equal(inClearanceRange(21, 21, 22), true);
  assert.equal(inClearanceRange(22, 21, 22), true);
  assert.equal(inClearanceRange(20.99, 21, 22), false);
  assert.equal(inClearanceRange(22.01, 21, 22), false);

  const roster = [10, 20, 20.01, 21, 22, 22.01].map((clearance, index) =>
    student({ id: `s${index}`, clearance_percent: clearance }),
  );
  const narrow = buildEligibility(roster, {
    minClearancePercent: 10,
    maxClearancePercent: 20,
    excludePreviouslyDownloaded: false,
  });
  assert.deepEqual(narrow.ready_students.map((row) => row.clearance_percent), [10, 20]);

  const band = buildEligibility(roster, {
    minClearancePercent: 21,
    maxClearancePercent: 22,
    excludePreviouslyDownloaded: false,
  });
  assert.deepEqual(band.ready_students.map((row) => row.clearance_percent), [21, 22]);
});

test('discounts reduce the payable denominator and transport or other years are ignored', () => {
  const discounted = clearanceFromFeeRows(
    [fee({ amount_due: 1000, discount: 200, amount_paid: 400 })],
    perClass,
  );
  assert.equal(discounted.payable_amount, 800);
  assert.equal(discounted.paid_amount, 400);
  assert.equal(discounted.clearance_percent, 50);
  assert.equal(discounted.no_fee_record, false);

  const withTransport = clearanceFromFeeRows(
    [
      fee({ amount_due: 100, amount_paid: 100 }),
      fee({ amount_due: 1000, amount_paid: 0, fee_code: 'TRANSPORT', fee_name: 'Transport Fee', is_transport: true }),
    ],
    perClass,
  );
  assert.equal(withTransport.payable_amount, 100);
  assert.equal(withTransport.clearance_percent, 100);

  const otherYear = clearanceFromFeeRows(
    [
      fee({ amount_due: 100, amount_paid: 50 }),
      fee({ amount_due: 100, amount_paid: 0, academic_year_id: OTHER_YEAR }),
    ],
    perClass,
  );
  assert.equal(otherYear.payable_amount, 100);
  assert.equal(otherYear.paid_amount, 50);
  assert.equal(otherYear.clearance_percent, 50);
});

test('fee mode ignores inactive structures and does not double-count the other mode', () => {
  const perClassClearance = clearanceFromFeeRows(
    [
      fee({ amount_due: 200, amount_paid: 100 }),
      fee({ amount_due: 200, amount_paid: 0, mode_deactivated: true }),
      fee({ amount_due: 200, amount_paid: 0, deleted_at: new Date() }),
      fee({ amount_due: 500, amount_paid: 0, section_id: SECTION_A }),
    ],
    perClass,
  );
  assert.equal(perClassClearance.payable_amount, 200);
  assert.equal(perClassClearance.clearance_percent, 50);

  const perSectionClearance = clearanceFromFeeRows(
    [
      fee({ amount_due: 100, amount_paid: 0, section_id: null }),
      fee({ amount_due: 100, amount_paid: 80, section_id: SECTION_A }),
      fee({ amount_due: 100, amount_paid: 0, section_id: SECTION_B }),
      fee({ amount_due: 500, amount_paid: 0, section_id: SECTION_A, mode_deactivated: true }),
    ],
    perSection,
  );
  assert.equal(perSectionClearance.payable_amount, 100);
  assert.equal(perSectionClearance.paid_amount, 80);
  assert.equal(perSectionClearance.clearance_percent, 80);
});

test('zero payable and missing fee records are fully cleared', () => {
  const waived = clearanceFromFeeRows(
    [fee({ amount_due: 100, discount: 100, amount_paid: 0 })],
    perClass,
  );
  assert.equal(waived.payable_amount, 0);
  assert.equal(waived.clearance_percent, 100);
  assert.equal(waived.no_fee_record, false);

  const none = clearanceFromFeeRows([], perClass);
  assert.equal(none.clearance_percent, 100);
  assert.equal(none.no_fee_record, true);

  const overpaid = clearanceFromFeeRows(
    [fee({ amount_due: 100, amount_paid: 150 })],
    perClass,
  );
  assert.equal(overpaid.clearance_percent, 100);
});

test('rounding uses two decimal places', () => {
  const twoThirds = clearanceFromFeeRows(
    [fee({ amount_due: 3, amount_paid: 2 })],
    perClass,
  );
  assert.equal(twoThirds.clearance_percent, 66.67);
});

test('completed students are excluded only while exclusion is enabled', () => {
  const roster = [
    student({ id: 'issued', clearance_percent: 80, previously_downloaded: true }),
    student({ id: 'open', clearance_percent: 80 }),
  ];
  const hidden = buildEligibility(roster, {
    minClearancePercent: 0,
    maxClearancePercent: 100,
    excludePreviouslyDownloaded: true,
  });
  assert.deepEqual(hidden.ready_students.map((row) => row.id), ['open']);
  assert.equal(hidden.previously_downloaded, 1);

  const reprint = buildEligibility(roster, {
    minClearancePercent: 0,
    maxClearancePercent: 100,
    excludePreviouslyDownloaded: false,
  });
  assert.deepEqual(reprint.ready_students.map((row) => row.id), ['issued', 'open']);
});

test('failed and expired batches do not create download history or a live reservation', () => {
  const now = new Date('2026-09-25T10:00:00.000Z');
  const flags = historyFlags(
    [
      { status: 'failed', expires_at: '2026-09-25T10:30:00.000Z' },
      { status: 'expired', expires_at: '2026-09-25T09:00:00.000Z' },
      { status: 'prepared', expires_at: '2026-09-25T09:59:00.000Z' },
    ],
    now,
  );
  assert.deepEqual(flags, { previously_downloaded: false, temporarily_reserved: false });

  const live = historyFlags(
    [{ status: 'prepared', expires_at: '2026-09-25T10:14:00.000Z' }],
    now,
  );
  assert.equal(live.temporarily_reserved, true);
  assert.equal(live.previously_downloaded, false);

  const downloaded = historyFlags(
    [{ status: 'completed', expires_at: '2026-09-25T09:00:00.000Z' }],
    now,
  );
  assert.equal(downloaded.previously_downloaded, true);
});

test('a live reservation blocks a second excluded batch and still allows a reprint', () => {
  const first = buildEligibility([student({ id: 's1', clearance_percent: 100 })], {
    minClearancePercent: 100,
    maxClearancePercent: 100,
    excludePreviouslyDownloaded: true,
  });
  assert.equal(first.ready_to_download, 1);

  const reserved = buildEligibility(
    [student({ id: 's1', clearance_percent: 100, temporarily_reserved: true })],
    {
      minClearancePercent: 100,
      maxClearancePercent: 100,
      excludePreviouslyDownloaded: true,
    },
  );
  assert.equal(reserved.ready_to_download, 0);
  assert.equal(reserved.temporarily_reserved, 1);

  const reprint = buildEligibility(
    [student({ id: 's1', clearance_percent: 100, temporarily_reserved: true, previously_downloaded: true })],
    {
      minClearancePercent: 100,
      maxClearancePercent: 100,
      excludePreviouslyDownloaded: false,
    },
  );
  assert.equal(reprint.ready_to_download, 1);
});

test('preparation uses the current clearance, not an earlier preview', () => {
  const filters = {
    minClearancePercent: 10,
    maxClearancePercent: 20,
    excludePreviouslyDownloaded: true,
  };
  const preview = buildEligibility([student({ id: 's1', clearance_percent: 15 })], filters);
  const afterPayment = buildEligibility([student({ id: 's1', clearance_percent: 25 })], filters);
  assert.deepEqual(preview.ready_students.map((row) => row.id), ['s1']);
  assert.deepEqual(afterPayment.ready_students.map((row) => row.id), []);
  assert.throws(
    () => assertNoClientRoster({ student_ids: ['s1'] }),
    (err) => err instanceof HallTicketBatchError && err.status === 400,
  );
});

test('clearance filters default to the full range and reject invalid values', () => {
  assert.deepEqual(parseClearanceFilters({}), {
    minClearancePercent: 0,
    maxClearancePercent: 100,
    excludePreviouslyDownloaded: false,
  });
  assert.deepEqual(
    parseClearanceFilters({
      min_clearance_percent: '10.00',
      max_clearance_percent: '20',
      exclude_previously_downloaded: 'true',
    }),
    {
      minClearancePercent: 10,
      maxClearancePercent: 20,
      excludePreviouslyDownloaded: true,
    },
  );

  for (const value of ['-1', '100.01', '10.001', 'abc', '100.5.1']) {
    assert.throws(() => parseClearanceFilters({ min_clearance_percent: value }), HallTicketBatchError);
  }
  assert.throws(
    () => parseClearanceFilters({ min_clearance_percent: '21', max_clearance_percent: '20' }),
    /Minimum clearance cannot be greater than maximum clearance/,
  );
  assert.throws(
    () => parseClearanceFilters({ exclude_previously_downloaded: 'maybe' }),
    HallTicketBatchError,
  );
});

test('print options are normalized and validated', () => {
  assert.deepEqual(parseBatchOptions({}), { ticketsPerPage: 4, showRollNumbers: false });
  assert.deepEqual(parseBatchOptions({ tickets_per_page: '2', show_roll_numbers: 'true' }), {
    ticketsPerPage: 2,
    showRollNumbers: true,
  });
  assert.throws(() => parseBatchOptions({ tickets_per_page: 1 }), /must be 2, 3, or 4/);
  assert.throws(() => parseBatchOptions({ show_roll_numbers: 'sometimes' }), HallTicketBatchError);
});

test('history from another school or exam is ignored and empty rosters stay empty', () => {
  const rows = relevantHistory(
    [
      { school_id: 2, exam_id: 'exam-1', status: 'completed' },
      { school_id: 1, exam_id: 'exam-2', status: 'completed' },
      { school_id: 1, exam_id: 'exam-1', status: 'completed' },
    ],
    { schoolId: 1, examId: 'exam-1' },
  );
  assert.equal(rows.length, 1);
  assert.equal(historyFlags(rows).previously_downloaded, true);

  const empty = buildEligibility([], {
    minClearancePercent: 0,
    maxClearancePercent: 100,
    excludePreviouslyDownloaded: false,
  });
  assert.equal(empty.total_active_students, 0);
  assert.equal(empty.ready_to_download, 0);
});

test('batch lifecycle is idempotent and rejects invalid transitions', () => {
  assert.deepEqual(nextBatchStatus({ status: 'prepared' }, 'complete'), {
    status: 'completed',
    idempotent: false,
  });
  assert.deepEqual(nextBatchStatus({ status: 'completed' }, 'complete'), {
    status: 'completed',
    idempotent: true,
  });
  assert.deepEqual(nextBatchStatus({ status: 'prepared' }, 'fail'), {
    status: 'failed',
    idempotent: false,
  });
  assert.deepEqual(nextBatchStatus({ status: 'failed' }, 'fail'), {
    status: 'failed',
    idempotent: true,
  });
  assert.throws(() => nextBatchStatus({ status: 'failed' }, 'complete'), (err) => err.status === 409);
  assert.throws(() => nextBatchStatus({ status: 'completed' }, 'fail'), (err) => err.status === 409);
  assert.throws(() => nextBatchStatus({ status: 'expired' }, 'complete'), (err) => err.status === 409);
  assert.throws(() => nextBatchStatus(null, 'complete'), (err) => err.status === 404);
});

test('hall-ticket batch routes keep the exams.view permission', () => {
  const src = fs.readFileSync(new URL('../routes/hallTicketRoutes.js', import.meta.url), 'utf8');
  for (const route of [
    "'/exams/:examId/preview'",
    "'/exams/:examId/batches'",
    "'/exams/:examId/batches/:batchId/complete'",
    "'/exams/:examId/batches/:batchId/fail'",
  ]) {
    const at = src.indexOf(route);
    assert.ok(at >= 0, route);
    assert.match(src.slice(at, at + 240), /requirePermission\('exams\.view'\)/);
  }
});

test('the existing results router is not coupled to fee-filtered hall-ticket batches', () => {
  const src = fs.readFileSync(new URL('../routes/resultsRoutes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /hallTicketBatchService|hall-ticket-batches/);
});

test('hall-ticket routes derive school identity from the authenticated tenant', () => {
  const src = fs.readFileSync(new URL('../middleware/schoolId.js', import.meta.url), 'utf8');
  assert.match(src, /\\\/api\\\/v1\\\/hall-tickets/);
});
