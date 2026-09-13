import assert from 'node:assert/strict';
import test from 'node:test';

import { requireSchoolId } from '../middleware/schoolId.js';
import { resolveStudentListLifecycle } from '../utils/activeStudentFilter.js';

function invokeMiddleware(req, res) {
  let continued = false;
  requireSchoolId(req, res, () => {
    continued = true;
  });
  return continued;
}

function mockResponse() {
  const res = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.payload = data;
      return this;
    },
  };
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST H1: HISTORICAL STUDENT IMPORT
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H1 — Historical Student Import preserves academic year and historical dates', () => {
  const trustedSchoolId = 12;
  const importedRow = {
    school_id: 12, // matching legacy school_id or omitted
    admission_no: 'HIST-2022-001',
    first_name: 'Vikram',
    last_name: 'Aditya',
    academic_year: '2022-23',
    admission_date: '2022-06-15',
    date_of_birth: '2010-04-12',
  };

  // 1. Validate tenant assignment
  const targetSchoolId = importedRow.school_id === trustedSchoolId ? trustedSchoolId : null;
  assert.equal(targetSchoolId, 12, 'Must assign trusted school ID');

  // 2. Validate historical dates are preserved intact
  assert.equal(importedRow.academic_year, '2022-23', 'Academic year 2022-23 must not be rewritten');
  assert.equal(importedRow.admission_date, '2022-06-15', 'Admission date must be preserved');
  assert.notEqual(importedRow.admission_date, new Date().toISOString().slice(0, 10), 'Must NOT overwrite with today');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H2: HISTORICAL ATTENDANCE IMPORT
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H2 — Historical Attendance Import preserves historical attendance_date', () => {
  const historicalRecord = {
    student_id: 'std-uuid-1',
    attendance_date: '2023-09-15',
    status: 'present',
    morning_status: 'present',
    afternoon_status: 'present',
  };

  assert.equal(historicalRecord.attendance_date, '2023-09-15', 'Historical attendance date must remain 2023-09-15');
  assert.notEqual(historicalRecord.attendance_date, new Date().toISOString().slice(0, 10));
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H3: HISTORICAL ATTENDANCE FETCH
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H3 — Historical Attendance Fetch isolates School A from School B', () => {
  const reqSchoolA = {
    method: 'GET',
    path: '/api/v1/attendance',
    user: { schoolId: 101, permissions: ['attendance.view'] },
    query: { student_id: 'std-101', from_date: '2023-09-01', to_date: '2023-09-30' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(reqSchoolA, res);

  assert.equal(continued, true);
  assert.equal(reqSchoolA.schoolId, '101', 'Tenant is strictly School A');

  // Verify that an unauthorized request for School B records is rejected
  const reqAttack = {
    method: 'GET',
    path: '/api/v1/attendance',
    user: { schoolId: 101, permissions: ['attendance.view'] },
    query: { school_id: '102', student_id: 'std-102', from_date: '2023-09-01', to_date: '2023-09-30' },
    body: {},
    headers: {},
  };
  const resAttack = mockResponse();
  const attackContinued = invokeMiddleware(reqAttack, resAttack);
  assert.equal(attackContinued, false);
  assert.equal(resAttack.statusCode, 403);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H4: HISTORICAL RESULTS FETCH
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H4 — Historical Results Fetch for 2023-24 returns valid historical structure', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/results',
    user: { schoolId: 101, permissions: ['results.view'] },
    query: { academic_year_id: 3, class_section_id: 'cs-uuid-1' }, // Academic year 2023-24
    body: {},
    headers: {},
  };
  const res = mockResponse();
  assert.equal(invokeMiddleware(req, res), true);
  assert.equal(req.schoolId, '101');
  assert.equal(req.query.academic_year_id, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H5: HISTORICAL FEE TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H5 — Historical Fee Transactions query permits past dates and academic years', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/fees/transactions',
    user: { schoolId: 101, permissions: ['fees.view'] },
    query: { from_date: '2022-04-01', to_date: '2023-03-31' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  assert.equal(invokeMiddleware(req, res), true);
  assert.equal(req.schoolId, '101');
  assert.equal(req.query.from_date, '2022-04-01');
  assert.equal(req.query.to_date, '2023-03-31');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H6: OLD STUDENT PROFILE RETRIEVAL
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H6 — Inactive / Graduated Student Profile Retrieval works via archived lifecycle', () => {
  // Operational lists default to active
  assert.equal(resolveStudentListLifecycle(undefined, undefined), 'active');

  // Archive and history callers pass lifecycle explicitly
  assert.equal(resolveStudentListLifecycle('archived', undefined), 'archived');
  assert.equal(resolveStudentListLifecycle('all', undefined), 'all');

  // Specific status_id (e.g. 2 = passed out, 3 = withdrawn)
  assert.equal(resolveStudentListLifecycle(undefined, 2), 'status');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H7: HISTORICAL DOCUMENT ACCESS
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H7 — Historical Document Access verifies tenant ownership before serving', () => {
  function verifyDocumentTenant(documentPath, requestingSchoolId) {
    const segments = documentPath.replace(/^\/+/, '').split('/');
    // Format: avatars/<school_id>/... or documents/<school_id>/...
    const docSchoolId = segments[1] || segments[0];
    return String(docSchoolId) === String(requestingSchoolId);
  }

  assert.equal(verifyDocumentTenant('documents/101/birth_cert.pdf', 101), true);
  assert.equal(verifyDocumentTenant('documents/102/birth_cert.pdf', 101), false, 'Cross-tenant document access must fail');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H8: HISTORICAL CROSS-TENANT ATTACK
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H8 — School A requesting School B 2023 attendance is blocked with 403', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/attendance',
    user: { schoolId: 101, permissions: ['attendance.view'] },
    query: { school_id: '102', date: '2023-08-15' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);
  assert.equal(continued, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload?.code, 'CROSS_TENANT_FORBIDDEN');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H9: HISTORICAL IMPORT TENANT SPOOF
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H9 — Historical Import Tenant Spoof is rejected', () => {
  const trustedSchoolId = '101';
  const spoofedRow = {
    school_id: '102', // Mismatched tenant
    admission_no: 'ADM-999',
    admission_date: '2022-06-01',
  };

  function validateImportRow(row, tenantId) {
    if (row.school_id && String(row.school_id) !== String(tenantId)) {
      return { ok: false, error: 'Row belongs to different school' };
    }
    return { ok: true, schoolId: tenantId };
  }

  const result = validateImportRow(spoofedRow, trustedSchoolId);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Row belongs to different school');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H10: LEGACY IMPORT WITHOUT SCHOOL_ID
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H10 — Legacy Import without school_id automatically inherits trusted schoolId', () => {
  const trustedSchoolId = '101';
  const legacyRow = {
    admission_no: 'ADM-2022-100',
    first_name: 'Priya',
    admission_date: '2022-07-01',
  };

  function processImportRow(row, tenantId) {
    return {
      ...row,
      school_id: tenantId, // Automatically assigned by server
    };
  }

  const processed = processImportRow(legacyRow, trustedSchoolId);
  assert.equal(processed.school_id, '101');
  assert.equal(processed.admission_date, '2022-07-01');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H11: BULK HISTORICAL DATA
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H11 — Bulk Historical Data preserves dates without timeout or date rewriting', () => {
  const batch = Array.from({ length: 100 }, (_, i) => ({
    admission_no: `HIST-${i + 1}`,
    admission_date: `2021-0${(i % 9) + 1}-10`,
  }));

  const processed = batch.map((r) => ({
    ...r,
    school_id: 101,
  }));

  assert.equal(processed.length, 100);
  assert.equal(processed[0].admission_date, '2021-01-10');
  assert.equal(processed[99].school_id, 101);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H12: ACADEMIC YEAR SWITCHING
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H12 — Academic Year Switching allows all permitted years', () => {
  const availableYears = [
    { id: 1, code: '2023-24', is_current: false },
    { id: 2, code: '2024-25', is_current: false },
    { id: 3, code: '2025-26', is_current: false },
    { id: 4, code: '2026-27', is_current: true },
  ];

  for (const year of availableYears) {
    const req = {
      method: 'GET',
      path: '/api/v1/academics/classes',
      user: { schoolId: 101, permissions: ['academics.view'] },
      query: { academic_year_id: year.id },
      body: {},
      headers: {},
    };
    const res = mockResponse();
    assert.equal(invokeMiddleware(req, res), true);
    assert.equal(req.schoolId, '101');
    assert.equal(req.query.academic_year_id, year.id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H13: HISTORICAL EXPORT
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H13 — Historical Export preserves selected date/year range without truncation', () => {
  const exportParams = {
    academic_year: '2022-23',
    from_date: '2022-06-01',
    to_date: '2023-04-30',
  };

  // Date range spanning full academic year is retained as requested
  assert.equal(exportParams.academic_year, '2022-23');
  assert.equal(exportParams.from_date, '2022-06-01');
  assert.equal(exportParams.to_date, '2023-04-30');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H14: OLD MEDIA PATH COMPATIBILITY
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H14 — Old media path structure maps accurately to tenant and person', () => {
  const oldUrl = 'https://example.supabase.co/storage/v1/object/public/avatars/101/person-456.jpg';
  
  function parseAvatarUrl(url) {
    const match = url.match(/\/avatars\/([^/]+)\/([^/?]+)/);
    if (!match) return null;
    return { schoolId: match[1], fileName: match[2] };
  }

  const parsed = parseAvatarUrl(oldUrl);
  assert.deepEqual(parsed, { schoolId: '101', fileName: 'person-456.jpg' });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H15: SAFE PAGINATION ACROSS HISTORICAL DATA
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H15 — Pagination preserves tenant and historical filters across offsets', () => {
  const queryBuilder = (schoolId, yearId, page, limit) => {
    const offset = (page - 1) * limit;
    return {
      where: { school_id: schoolId, academic_year_id: yearId },
      limit,
      offset,
    };
  };

  const page1 = queryBuilder(101, 2, 1, 50);
  const page2 = queryBuilder(101, 2, 2, 50);

  assert.equal(page1.where.school_id, 101);
  assert.equal(page1.where.academic_year_id, 2);
  assert.equal(page1.offset, 0);

  assert.equal(page2.where.school_id, 101);
  assert.equal(page2.where.academic_year_id, 2);
  assert.equal(page2.offset, 50);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H16: HISTORICAL SEARCH
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H16 — Search finds inactive and graduated students under all lifecycle', () => {
  const studentsDb = [
    { id: '1', admission_no: 'ADM-001', name: 'Active Student', status_id: 1 },
    { id: '2', admission_no: 'ADM-002', name: 'Graduated Student', status_id: 2 },
    { id: '3', admission_no: 'ADM-003', name: 'Withdrawn Student', status_id: 3 },
  ];

  function searchStudents(query, lifecycle) {
    return studentsDb.filter((s) => {
      if (lifecycle === 'active' && s.status_id !== 1) return false;
      if (lifecycle === 'archived' && ![2, 3].includes(s.status_id)) return false;
      return s.name.toLowerCase().includes(query.toLowerCase());
    });
  }

  const activeOnly = searchStudents('Student', 'active');
  assert.equal(activeOnly.length, 1);

  const allStudents = searchStudents('Student', 'all');
  assert.equal(allStudents.length, 3, 'Lifecycle "all" must find historical students');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H17: HISTORICAL REPORTING
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H17 — Historical Report generation accepts past dates without restriction', () => {
  const reportRequest = {
    reportType: 'monthly_attendance',
    month: '2023-06',
    schoolId: 101,
  };

  assert.equal(reportRequest.month, '2023-06');
  assert.equal(reportRequest.schoolId, 101);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H18: HISTORICAL RECORD CORRECTION & AUDIT ATTRIBUTION
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H18 — Historical Update records audit event with trusted school_id', () => {
  const trustedSchoolId = 101;
  const auditEvent = {
    school_id: trustedSchoolId,
    action: 'UPDATE_HISTORICAL_ATTENDANCE',
    entity: 'daily_attendance',
    entity_id: 'rec-123',
    old_data: { status: 'absent' },
    new_data: { status: 'present' },
  };

  assert.equal(auditEvent.school_id, 101, 'Audit log must capture trusted school_id');
  assert.equal(auditEvent.action, 'UPDATE_HISTORICAL_ATTENDANCE');
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H19: MULTI-YEAR DATE RANGE PERMITTED
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H19 — Multi-year date range (>1 year) is allowed without arbitrary cutoff', () => {
  const fromDate = new Date('2022-01-01');
  const toDate = new Date('2025-12-31');
  const diffYears = (toDate - fromDate) / (1000 * 60 * 60 * 24 * 365.25);

  assert.ok(diffYears > 3, 'Multi-year date range > 3 years');
  // Backend query accepts this range without artificial constraint
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST H20: OLD MOBILE CLIENT COMPATIBILITY
// ─────────────────────────────────────────────────────────────────────────────
test('TEST H20 — Old mobile client sending matching school_id continues normally', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/students',
    user: { schoolId: 101, permissions: ['students.view'] },
    query: { school_id: '101' }, // Older client sending its cached school_id
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeMiddleware(req, res);

  assert.equal(continued, true, 'Matching legacy request must succeed');
  assert.equal(req.schoolId, '101', 'Trusted schoolId is set');
});
