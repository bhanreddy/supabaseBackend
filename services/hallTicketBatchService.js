// Fee-filtered hall-ticket eligibility and download-batch lifecycle.
//
// Clearance uses active school-fee structures for the exam academic year.
// Transport fees are ignored. A student is "previously downloaded" only when
// they appear in a completed batch for the same exam. Prepared batches reserve
// those students for 15 minutes so concurrent downloads cannot select them
// twice while exclusion is on. The server always recomputes the roster; client
// student ids are rejected.

import sql from '../db.js';
import { selectEffectiveSectionPapers } from './examTimetableService.js';
import { ACTIVE_STUDENT_STATUS_ID } from '../utils/activeStudentFilter.js';

export class HallTicketBatchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const HALL_TICKET_RESERVATION_MINUTES = 15;
export const HALL_TICKET_VIEW_PERMISSION = 'exams.view';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

function roundMoneyFromCents(cents) {
  return Math.round(cents) / 100;
}

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isoTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Accept 0–100 with at most two decimal places.
 * Missing values use the supplied fallback (GET compatibility: 0 and 100).
 */
export function parseClearancePercent(value, { fallback, label }) {
  if (value === undefined || value === null || value === '') return fallback;

  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new HallTicketBatchError(`${label} must be a number from 0 to 100`, 400);
    }
    const points = Math.round((value + Number.EPSILON) * 100);
    if (Math.abs(value * 100 - points) > 1e-4) {
      throw new HallTicketBatchError(`${label} supports at most two decimal places`, 400);
    }
    text = (points / 100).toFixed(2);
  } else {
    text = String(value).trim();
  }

  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) {
    throw new HallTicketBatchError(`${label} must be from 0 to 100 with at most two decimal places`, 400);
  }
  const points = Math.round(Number(text) * 100);
  if (points < 0 || points > 10000) {
    throw new HallTicketBatchError(`${label} must be between 0 and 100`, 400);
  }
  return points / 100;
}

export function parseExcludePreviouslyDownloaded(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  throw new HallTicketBatchError('exclude_previously_downloaded must be true or false', 400);
}

export function parseBatchOptions({ ticketsPerPage, tickets_per_page, showRollNumbers, show_roll_numbers } = {}) {
  const parsedTicketsPerPage = Number(ticketsPerPage ?? tickets_per_page ?? 4);
  if (![2, 3, 4].includes(parsedTicketsPerPage)) {
    throw new HallTicketBatchError('tickets_per_page must be 2, 3, or 4', 400);
  }
  const rawShowRollNumbers = showRollNumbers ?? show_roll_numbers;
  return {
    ticketsPerPage: parsedTicketsPerPage,
    showRollNumbers: parseExcludePreviouslyDownloaded(rawShowRollNumbers, false),
  };
}

export function parseClearanceFilters({
  minClearancePercent,
  maxClearancePercent,
  excludePreviouslyDownloaded,
  min_clearance_percent,
  max_clearance_percent,
  exclude_previously_downloaded,
} = {}) {
  const min = parseClearancePercent(
    minClearancePercent !== undefined ? minClearancePercent : min_clearance_percent,
    { fallback: 0, label: 'Minimum clearance' },
  );
  const max = parseClearancePercent(
    maxClearancePercent !== undefined ? maxClearancePercent : max_clearance_percent,
    { fallback: 100, label: 'Maximum clearance' },
  );
  if (Math.round(min * 100) > Math.round(max * 100)) {
    throw new HallTicketBatchError('Minimum clearance cannot be greater than maximum clearance', 400);
  }
  return {
    minClearancePercent: min,
    maxClearancePercent: max,
    excludePreviouslyDownloaded: parseExcludePreviouslyDownloaded(
      excludePreviouslyDownloaded !== undefined ? excludePreviouslyDownloaded : exclude_previously_downloaded,
      false,
    ),
  };
}

export function assertNoClientRoster(options = {}) {
  if (options.student_ids != null || options.studentIds != null) {
    throw new HallTicketBatchError(
      'Student selection is calculated on the server and cannot be supplied by the client',
      400,
    );
  }
}

export function isTransportFeeRow(row) {
  if (!row) return false;
  if (row.is_transport === true) return true;
  const code = String(row.fee_code ?? row.code ?? '').trim().toLowerCase();
  const name = String(row.fee_name ?? row.name ?? '').trim().toLowerCase();
  return code === 'transport' || name.includes('transport');
}

/** Active school-fee row for this academic year and the school's fee mode. */
export function isActiveSchoolFee(row, { academicYearId, feeMode, sectionId }) {
  if (!row) return false;
  if (row.deleted_at || row.student_fee_deleted_at || row.mode_deactivated) return false;
  if (String(row.academic_year_id) !== String(academicYearId)) return false;
  if (isTransportFeeRow(row)) return false;
  if (feeMode === 'per_section') {
    return row.section_id != null && String(row.section_id) === String(sectionId);
  }
  return row.section_id == null;
}

/**
 * payable = SUM(amount_due - discount)
 * cleared = ROUND(SUM(amount_paid) / payable * 100, 2), clamped to 0–100.
 * Zero payable, including no active school-fee rows, is 100%.
 */
export function clearanceFromFeeRows(rows, context) {
  const source = Array.isArray(rows) ? rows : [];
  const active = source.filter((row) => isActiveSchoolFee(row, context));
  if (active.length === 0) {
    return {
      payable_amount: 0,
      paid_amount: 0,
      clearance_percent: 100,
      no_fee_record: true,
    };
  }

  let payableCents = 0;
  let paidCents = 0;
  for (const row of active) {
    payableCents += toCents(row.amount_due) - toCents(row.discount);
    paidCents += toCents(row.amount_paid);
  }

  if (payableCents <= 0) {
    return {
      payable_amount: 0,
      paid_amount: roundMoneyFromCents(Math.max(0, paidCents)),
      clearance_percent: 100,
      no_fee_record: false,
    };
  }

  const ratio = (paidCents / payableCents) * 100;
  const clearance = Math.min(100, Math.max(0, Math.round((ratio + Number.EPSILON) * 100) / 100));
  return {
    payable_amount: roundMoneyFromCents(payableCents),
    paid_amount: roundMoneyFromCents(Math.max(0, paidCents)),
    clearance_percent: clearance,
    no_fee_record: false,
  };
}

/** Inclusive range compared at two decimal places. 20.01 is outside 10–20. */
export function inClearanceRange(percent, min, max) {
  const value = Math.round((Number(percent) + Number.EPSILON) * 100);
  const lower = Math.round((Number(min) + Number.EPSILON) * 100);
  const upper = Math.round((Number(max) + Number.EPSILON) * 100);
  return value >= lower && value <= upper;
}

export function relevantHistory(rows, { schoolId, examId }) {
  return (rows || []).filter((row) => {
    if (schoolId != null && row.school_id != null && String(row.school_id) !== String(schoolId)) return false;
    if (examId != null && row.exam_id != null && String(row.exam_id) !== String(examId)) return false;
    return true;
  });
}

/** Completed batches are download history. Only unexpired prepared batches reserve a student. */
export function historyFlags(rows, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  let previouslyDownloaded = false;
  let temporarilyReserved = false;
  for (const row of rows || []) {
    if (row.status === 'completed') previouslyDownloaded = true;
    if (row.status === 'prepared') {
      const expires = new Date(row.expires_at).getTime();
      if (Number.isFinite(expires) && expires > nowMs) temporarilyReserved = true;
    }
  }
  return {
    previously_downloaded: previouslyDownloaded,
    temporarily_reserved: temporarilyReserved,
  };
}

export function buildEligibility(students, filters) {
  const roster = Array.isArray(students) ? students : [];
  const within = roster.filter((student) =>
    inClearanceRange(student.clearance_percent, filters.minClearancePercent, filters.maxClearancePercent),
  );
  const previously = within.filter((student) => student.previously_downloaded);
  const reserved = within.filter((student) => student.temporarily_reserved);
  const ready = within.filter((student) => {
    if (!filters.excludePreviouslyDownloaded) return true;
    return !student.previously_downloaded && !student.temporarily_reserved;
  });
  return {
    total_active_students: roster.length,
    within_fee_range: within.length,
    previously_downloaded: previously.length,
    temporarily_reserved: reserved.length,
    ready_to_download: ready.length,
    ready_students: ready,
    within_range_students: within,
  };
}

export function nextBatchStatus(batch, action) {
  if (!batch) {
    throw new HallTicketBatchError('Hall-ticket batch not found', 404);
  }
  if (action === 'complete') {
    if (batch.status === 'completed') return { status: 'completed', idempotent: true };
    if (batch.status !== 'prepared') {
      throw new HallTicketBatchError('Only a prepared hall-ticket batch can be completed', 409);
    }
    return { status: 'completed', idempotent: false };
  }
  if (action === 'fail') {
    if (batch.status === 'failed') return { status: 'failed', idempotent: true };
    if (batch.status !== 'prepared') {
      throw new HallTicketBatchError('Only a prepared hall-ticket batch can be marked failed', 409);
    }
    return { status: 'failed', idempotent: false };
  }
  throw new HallTicketBatchError('Invalid hall-ticket batch action', 400);
}

function groupByStudent(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = String(row.student_id);
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function pdfStudent(student) {
  return {
    id: student.id,
    display_name: student.display_name,
    father_name: student.father_name ?? null,
    photo_url: student.photo_url ?? null,
    admission_no: student.admission_no,
    roll_number: student.roll_number ?? null,
  };
}

function snapshotStudent(student) {
  return {
    ...pdfStudent(student),
    payable_amount: student.payable_amount,
    paid_amount: student.paid_amount,
    clearance_percent: student.clearance_percent,
    no_fee_record: student.no_fee_record,
    previously_downloaded: !!student.previously_downloaded,
    temporarily_reserved: !!student.temporarily_reserved,
    within_range: !!student.within_range,
  };
}

function appliedFilters(filters) {
  return {
    min_clearance_percent: filters.minClearancePercent,
    max_clearance_percent: filters.maxClearancePercent,
    exclude_previously_downloaded: filters.excludePreviouslyDownloaded,
  };
}

function summaryPayload(summary) {
  return {
    total_active_students: summary.total_active_students,
    within_fee_range: summary.within_fee_range,
    previously_downloaded: summary.previously_downloaded,
    temporarily_reserved: summary.temporarily_reserved,
    ready_to_download: summary.ready_to_download,
  };
}

async function loadExamBundle(db, { schoolId, examId, classId, sectionId }) {
  const classKey = String(classId || '').trim();
  const sectionKey = String(sectionId || '').trim();
  if (!classKey || !sectionKey) {
    throw new HallTicketBatchError('class_id and section_id are required', 400);
  }
  if (!isUuid(examId) || !isUuid(classKey) || !isUuid(sectionKey)) {
    throw new HallTicketBatchError('Invalid exam, class, or section id', 400);
  }

  const [exam] = await db`
    SELECT e.id, e.name, e.name_te, e.exam_type,
           e.start_date::text AS start_date, e.end_date::text AS end_date,
           e.academic_year_id, ay.code AS academic_year
    FROM exams e
    JOIN academic_years ay ON e.academic_year_id = ay.id
    WHERE e.id = ${examId}
      AND e.school_id = ${schoolId}
      AND e.deleted_at IS NULL
  `;
  if (!exam) {
    throw new HallTicketBatchError('Exam not found', 404);
  }

  const [classSection] = await db`
    SELECT cs.id, cs.class_id, cs.section_id,
           c.name AS class_name, s.name AS section_name
    FROM class_sections cs
    JOIN classes c ON cs.class_id = c.id
    JOIN sections s ON cs.section_id = s.id
    WHERE cs.school_id = ${schoolId}
      AND cs.academic_year_id = ${exam.academic_year_id}
      AND cs.class_id = ${classKey}
      AND cs.section_id = ${sectionKey}
      AND cs.deleted_at IS NULL
    LIMIT 1
  `;
  if (!classSection) {
    throw new HallTicketBatchError('Class and section are not mapped for this exam academic year', 404);
  }

  const rawPapers = await db`
    SELECT
      es.id, es.class_id, es.class_section_id, es.subject_id, es.exam_date::text AS exam_date,
      es.start_time::text AS start_time, es.end_time::text AS end_time,
      es.max_marks, es.passing_marks, es.syllabus,
      c.name AS class_name,
      s.name AS subject_name, s.name_te AS subject_name_te,
      false AS has_marks, false AS has_teacher
    FROM exam_subjects es
    JOIN classes c ON es.class_id = c.id
    JOIN subjects s ON es.subject_id = s.id
    WHERE es.exam_id = ${examId}
      AND es.class_id = ${classKey}
      AND (es.class_section_id = ${classSection.id} OR es.class_section_id IS NULL)
      AND es.school_id = ${schoolId}
      AND es.deleted_at IS NULL
    ORDER BY es.exam_date NULLS LAST, es.start_time NULLS LAST, s.name
  `;
  const papers = selectEffectiveSectionPapers(rawPapers, classSection.id);
  if (papers.length === 0) {
    throw new HallTicketBatchError('No exam papers are scheduled for this class', 404);
  }

  const [school] = await db`
    SELECT COALESCE(fee_mode, 'per_class') AS fee_mode
    FROM schools
    WHERE id = ${schoolId}
  `;
  const feeMode = school?.fee_mode === 'per_section' ? 'per_section' : 'per_class';

  const students = await db`
    SELECT
      st.id,
      p.display_name,
      p.photo_url,
      st.admission_no,
      se.roll_number,
      father_info.father_name
    FROM student_enrollments se
    JOIN students st ON se.student_id = st.id
    JOIN persons p ON st.person_id = p.id
    LEFT JOIN LATERAL (
      SELECT pp.display_name AS father_name
      FROM student_parents sp
      JOIN parents par ON sp.parent_id = par.id AND par.deleted_at IS NULL
      JOIN persons pp ON par.person_id = pp.id
      JOIN relationship_types rt ON sp.relationship_id = rt.id AND rt.name = 'Father'
      WHERE sp.student_id = st.id
        AND sp.school_id = ${schoolId}
        AND sp.deleted_at IS NULL
      ORDER BY sp.is_primary_contact DESC NULLS LAST, sp.created_at
      LIMIT 1
    ) father_info ON true
    WHERE se.school_id = ${schoolId}
      AND se.class_section_id = ${classSection.id}
      AND se.academic_year_id = ${exam.academic_year_id}
      AND se.status = 'active'
      AND se.deleted_at IS NULL
      AND st.deleted_at IS NULL
      AND st.status_id = ${ACTIVE_STUDENT_STATUS_ID}
    ORDER BY se.roll_number NULLS LAST, p.display_name, st.admission_no
  `;

  return {
    schoolId,
    examId,
    exam,
    classSection,
    papers,
    students,
    feeMode,
  };
}

async function loadFeeAndHistory(db, bundle) {
  const studentIds = bundle.students.map((student) => student.id);
  if (studentIds.length === 0) return { feeRows: [], historyRows: [] };

  const feeRows = await db`
    SELECT
      sf.student_id,
      sf.amount_due,
      sf.amount_paid,
      sf.discount,
      sf.deleted_at AS student_fee_deleted_at,
      fs.academic_year_id,
      fs.section_id,
      fs.deleted_at,
      fs.mode_deactivated,
      ft.code AS fee_code,
      ft.name AS fee_name
    FROM student_fees sf
    JOIN fee_structures fs ON fs.id = sf.fee_structure_id
    JOIN fee_types ft ON ft.id = fs.fee_type_id
    WHERE sf.school_id = ${bundle.schoolId}
      AND sf.student_id = ANY(${db.array(studentIds)}::uuid[])
  `;

  const historyRows = await db`
    SELECT
      bs.student_id,
      b.school_id,
      b.exam_id,
      b.status,
      b.expires_at
    FROM exam_hall_ticket_batch_students bs
    JOIN exam_hall_ticket_batches b ON b.id = bs.batch_id AND b.school_id = bs.school_id
    WHERE b.school_id = ${bundle.schoolId}
      AND b.exam_id = ${bundle.examId}
      AND bs.student_id = ANY(${db.array(studentIds)}::uuid[])
  `;

  return { feeRows, historyRows };
}

function assessRoster(bundle, feeRows, historyRows, filters, now = new Date()) {
  const feesByStudent = groupByStudent(feeRows);
  const historyByStudent = groupByStudent(historyRows);
  const context = {
    academicYearId: bundle.exam.academic_year_id,
    feeMode: bundle.feeMode,
    sectionId: bundle.classSection.section_id,
  };

  return bundle.students.map((student) => {
    const clearance = clearanceFromFeeRows(feesByStudent.get(String(student.id)) || [], context);
    const flags = historyFlags(
      relevantHistory(historyByStudent.get(String(student.id)) || [], {
        schoolId: bundle.schoolId,
        examId: bundle.examId,
      }),
      now,
    );
    return {
      ...student,
      ...clearance,
      ...flags,
      within_range: inClearanceRange(
        clearance.clearance_percent,
        filters.minClearancePercent,
        filters.maxClearancePercent,
      ),
    };
  });
}

async function loadRecentBatches(db, bundle) {
  const rows = await db`
    SELECT
      b.id,
      b.min_clearance_percent,
      b.max_clearance_percent,
      b.exclude_previously_downloaded,
      b.tickets_per_page,
      b.show_roll_numbers,
      b.student_count,
      b.completed_at,
      p.display_name AS operator_name
    FROM exam_hall_ticket_batches b
    LEFT JOIN users u ON u.id = b.created_by AND u.school_id = b.school_id
    LEFT JOIN persons p ON p.id = u.person_id
    WHERE b.school_id = ${bundle.schoolId}
      AND b.exam_id = ${bundle.examId}
      AND b.class_section_id = ${bundle.classSection.id}
      AND b.status = 'completed'
    ORDER BY b.completed_at DESC NULLS LAST, b.created_at DESC
    LIMIT 5
  `;
  return rows.map((row) => ({
    id: row.id,
    min_clearance_percent: asNumber(row.min_clearance_percent),
    max_clearance_percent: asNumber(row.max_clearance_percent),
    exclude_previously_downloaded: !!row.exclude_previously_downloaded,
    tickets_per_page: asNumber(row.tickets_per_page, 4),
    show_roll_numbers: !!row.show_roll_numbers,
    student_count: asNumber(row.student_count),
    operator_name: row.operator_name || null,
    completed_at: isoTimestamp(row.completed_at),
  }));
}

function downloadPayload(bundle, assessed, filters, recentBatches) {
  const summary = buildEligibility(assessed, filters);
  return {
    exam: bundle.exam,
    class_section: bundle.classSection,
    papers: bundle.papers,
    students: summary.ready_students.map(pdfStudent),
    eligibility_summary: summaryPayload(summary),
    applied_filters: appliedFilters(filters),
    clearance_snapshots: assessed.map(snapshotStudent),
    recent_batches: recentBatches,
  };
}

export async function getHallTicketDownload(db, args) {
  const filters = parseClearanceFilters(args);
  const bundle = await loadExamBundle(db, args);
  const { feeRows, historyRows } = await loadFeeAndHistory(db, bundle);
  const assessed = assessRoster(bundle, feeRows, historyRows, filters);
  const recentBatches = await loadRecentBatches(db, bundle);
  return downloadPayload(bundle, assessed, filters, recentBatches);
}

async function resolveOperator(db, schoolId, userId) {
  if (!userId || !isUuid(userId)) return null;
  const [user] = await db`
    SELECT id
    FROM users
    WHERE id = ${userId}
      AND school_id = ${schoolId}
      AND deleted_at IS NULL
  `;
  return user?.id || null;
}

export async function prepareHallTicketBatch(db, args) {
  assertNoClientRoster(args);
  const filters = parseClearanceFilters(args);
  const batchOptions = parseBatchOptions(args);
  return db.begin(async (tx) => {
    const bundle = await loadExamBundle(tx, args);
    const lockKey = `hall-ticket:${bundle.schoolId}:${bundle.examId}:${bundle.classSection.id}`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    const { feeRows, historyRows } = await loadFeeAndHistory(tx, bundle);
    const assessed = assessRoster(bundle, feeRows, historyRows, filters);
    const summary = buildEligibility(assessed, filters);
    if (summary.ready_students.length === 0) {
      throw new HallTicketBatchError('No students are eligible for this hall-ticket batch', 409);
    }

    const createdBy = await resolveOperator(tx, bundle.schoolId, args.userId);
    const [batch] = await tx`
      INSERT INTO exam_hall_ticket_batches (
        school_id, exam_id, class_section_id,
        min_clearance_percent, max_clearance_percent,
        exclude_previously_downloaded, tickets_per_page, show_roll_numbers,
        created_by, status, student_count, expires_at
      ) VALUES (
        ${bundle.schoolId},
        ${bundle.examId},
        ${bundle.classSection.id},
        ${filters.minClearancePercent},
        ${filters.maxClearancePercent},
        ${filters.excludePreviouslyDownloaded},
        ${batchOptions.ticketsPerPage},
        ${batchOptions.showRollNumbers},
        ${createdBy},
        'prepared',
        ${summary.ready_students.length},
        now() + ${`${HALL_TICKET_RESERVATION_MINUTES} minutes`}::interval
      )
      RETURNING id, expires_at
    `;

    await tx`
      INSERT INTO exam_hall_ticket_batch_students ${tx(
        summary.ready_students.map((student) => ({
          batch_id: batch.id,
          student_id: student.id,
          school_id: bundle.schoolId,
          payable_amount: student.payable_amount,
          paid_amount: student.paid_amount,
          clearance_percent: student.clearance_percent,
          no_fee_record: student.no_fee_record,
        })),
      )}
    `;

    const recentBatches = await loadRecentBatches(tx, bundle);
    return {
      batch_id: batch.id,
      expires_at: isoTimestamp(batch.expires_at),
      tickets_per_page: batchOptions.ticketsPerPage,
      show_roll_numbers: batchOptions.showRollNumbers,
      ...downloadPayload(bundle, assessed, filters, recentBatches),
    };
  });
}

async function transitionBatch(db, { schoolId, examId, batchId, action }) {
  if (!isUuid(examId) || !isUuid(batchId)) {
    throw new HallTicketBatchError('Invalid exam or batch id', 400);
  }

  const [updated] = await db`
    UPDATE exam_hall_ticket_batches
    SET
      status = ${action === 'complete' ? 'completed' : 'failed'},
      completed_at = CASE WHEN ${action === 'complete'} THEN now() ELSE completed_at END,
      failed_at = CASE WHEN ${action === 'fail'} THEN now() ELSE failed_at END
    WHERE id = ${batchId}
      AND school_id = ${schoolId}
      AND exam_id = ${examId}
      AND status = 'prepared'
      AND (${action === 'fail'} OR expires_at > now())
    RETURNING id, status
  `;
  if (updated) {
    return { batch_id: updated.id, status: updated.status, idempotent: false };
  }

  const [current] = await db`
    SELECT id, status, school_id, exam_id, expires_at
    FROM exam_hall_ticket_batches
    WHERE id = ${batchId}
  `;
  if (!current || String(current.school_id) !== String(schoolId) || String(current.exam_id) !== String(examId)) {
    throw new HallTicketBatchError('Hall-ticket batch not found', 404);
  }
  if (
    action === 'complete'
    && current.status === 'prepared'
    && new Date(current.expires_at).getTime() <= Date.now()
  ) {
    await db`
      UPDATE exam_hall_ticket_batches
      SET status = 'expired'
      WHERE id = ${batchId}
        AND school_id = ${schoolId}
        AND exam_id = ${examId}
        AND status = 'prepared'
        AND expires_at <= now()
    `;
    throw new HallTicketBatchError('This hall-ticket batch reservation has expired', 409);
  }
  const transition = nextBatchStatus(current, action);
  return { batch_id: current.id, status: transition.status, idempotent: true };
}

export async function completeHallTicketBatch(db, args) {
  return transitionBatch(db, { ...args, action: 'complete' });
}

export async function failHallTicketBatch(db, args) {
  return transitionBatch(db, { ...args, action: 'fail' });
}

export async function getHallTicketDownloadForRequest(args) {
  return getHallTicketDownload(sql, args);
}

export async function prepareHallTicketBatchForRequest(args) {
  return prepareHallTicketBatch(sql, args);
}

export async function completeHallTicketBatchForRequest(args) {
  return completeHallTicketBatch(sql, args);
}

export async function failHallTicketBatchForRequest(args) {
  return failHallTicketBatch(sql, args);
}
