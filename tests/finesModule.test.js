import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALCULATION_TYPES,
  validateFinePolicy,
  calculateFineAmount,
  calculateDaysBetween,
  formatYmdInTimezone,
} from '../services/finePolicyEngine.js';

import {
  FINE_STATUSES,
  PERMITTED_TRANSITIONS,
  isValidTransition,
  assertCanTransition,
  determineStatusAfterPayment,
  determineStatusAfterWaiver,
} from '../services/fineStateMachine.js';

import { canRequestFines, canCreatePostedFines } from '../services/fineService.js';
import { requireSchoolId } from '../middleware/schoolId.js';
import sql from '../db.js';

// ============================================================================
// 1. POLICY ENGINE & CALCULATION TESTS
// ============================================================================

test('Fine Policy Engine: FIXED amount calculation', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.FIXED,
    fixed_amount: 250,
  };

  const result = calculateFineAmount(policy);
  assert.equal(result.amount, 250);
  assert.equal(result.details.calculation_type, 'FIXED');
  assert.equal(result.details.rate, 250);
});

test('Fine Policy Engine: PER_DAY within grace period results in zero fine', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.PER_DAY,
    per_day_amount: 50,
    grace_days: 5,
  };

  // Due date: 2026-09-01, Evaluation: 2026-09-04 (3 days overdue <= 5 grace)
  const result = calculateFineAmount(policy, {
    due_date: '2026-09-01',
    as_of_date: '2026-09-04',
  });

  assert.equal(result.amount, 0);
  assert.equal(result.details.days_overdue, 3);
  assert.equal(result.details.fineable_days, 0);
});

test('Fine Policy Engine: PER_DAY exactly on grace period boundary results in zero fine', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.PER_DAY,
    per_day_amount: 50,
    grace_days: 5,
  };

  // Due date: 2026-09-01, Evaluation: 2026-09-06 (5 days overdue == 5 grace)
  const result = calculateFineAmount(policy, {
    due_date: '2026-09-01',
    as_of_date: '2026-09-06',
  });

  assert.equal(result.amount, 0);
  assert.equal(result.details.days_overdue, 5);
  assert.equal(result.details.fineable_days, 0);
});

test('Fine Policy Engine: PER_DAY past grace period charges overdue days', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.PER_DAY,
    per_day_amount: 50,
    grace_days: 5,
  };

  // Due date: 2026-09-01, Evaluation: 2026-09-11 (10 days overdue - 5 grace = 5 billable days)
  const result = calculateFineAmount(policy, {
    due_date: '2026-09-01',
    as_of_date: '2026-09-11',
  });

  assert.equal(result.amount, 250); // 5 billable days * 50
  assert.equal(result.details.days_overdue, 10);
  assert.equal(result.details.fineable_days, 5);
});

test('Fine Policy Engine: PER_DAY respects maximum_amount cap', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.PER_DAY,
    per_day_amount: 50,
    grace_days: 0,
    maximum_amount: 500,
  };

  // 20 days overdue * 50 = 1000, should be capped at 500
  const result = calculateFineAmount(policy, {
    due_date: '2026-08-01',
    as_of_date: '2026-08-21',
  });

  assert.equal(result.amount, 500);
  assert.equal(result.details.capped_at_max, true);
  assert.equal(result.details.max_cap, 500);
});

test('Fine Policy Engine: PER_DAY respects minimum_amount floor when overdue', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.PER_DAY,
    per_day_amount: 10,
    grace_days: 0,
    minimum_amount: 50,
  };

  // 2 days * 10 = 20, should be elevated to minimum_amount 50
  const result = calculateFineAmount(policy, {
    due_date: '2026-09-01',
    as_of_date: '2026-09-03',
  });

  assert.equal(result.amount, 50);
  assert.equal(result.details.raised_to_min, true);
});

test('Fine Policy Engine: PERCENTAGE calculation of base amount', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.PERCENTAGE,
    percentage: 5, // 5%
    maximum_amount: 300,
  };

  // Base 5,000, 5% is 250 (under 300 cap)
  const result = calculateFineAmount(policy, {
    base_amount: 5000,
  });

  assert.equal(result.amount, 250);
  assert.equal(result.details.rate, 5);
});

test('Fine Policy Engine: VARIABLE allows manual amount with minimum and maximum boundaries', () => {
  const policy = {
    calculation_type: CALCULATION_TYPES.VARIABLE,
    minimum_amount: 100,
    maximum_amount: 2000,
  };

  const withinRange = calculateFineAmount(policy, { variable_amount: 500 });
  assert.equal(withinRange.amount, 500);

  const belowFloor = calculateFineAmount(policy, { variable_amount: 50 });
  assert.equal(belowFloor.amount, 100);

  const aboveCap = calculateFineAmount(policy, { variable_amount: 5000 });
  assert.equal(aboveCap.amount, 2000);
});

test('Fine Policy Engine: Policy validation catches invalid configurations', () => {
  const invalidFixed = validateFinePolicy({ calculation_type: 'FIXED', fixed_amount: -10 });
  assert.equal(invalidFixed.isValid, false);
  assert.ok(invalidFixed.errors.length > 0);

  const invalidPerDay = validateFinePolicy({ calculation_type: 'PER_DAY', per_day_amount: 0 });
  assert.equal(invalidPerDay.isValid, false);

  const invalidMinMax = validateFinePolicy({
    calculation_type: 'FIXED',
    fixed_amount: 100,
    minimum_amount: 500,
    maximum_amount: 200,
  });
  assert.equal(invalidMinMax.isValid, false);

  const validPolicy = validateFinePolicy({
    calculation_type: 'PER_DAY',
    per_day_amount: 25,
    grace_days: 7,
    maximum_amount: 1000,
  });
  assert.equal(validPolicy.isValid, true);
});

test('Fine Policy Engine: Date math handles leap year and timezone string format', () => {
  const diff = calculateDaysBetween('2024-02-28', '2024-03-01');
  assert.equal(diff, 2); // 2024 is a leap year (Feb 29 exists)

  const formatted = formatYmdInTimezone(new Date('2026-09-12T00:30:00Z'), 'Asia/Kolkata');
  assert.equal(formatted, '2026-09-12');
});

// ============================================================================
// 2. STATE MACHINE & TRANSITION TESTS
// ============================================================================

test('Fine State Machine: Valid lifecycle transitions are permitted', () => {
  assert.equal(isValidTransition(FINE_STATUSES.DRAFT, FINE_STATUSES.PENDING_APPROVAL), true);
  assert.equal(isValidTransition(FINE_STATUSES.DRAFT, FINE_STATUSES.POSTED), true);
  assert.equal(isValidTransition(FINE_STATUSES.PENDING_APPROVAL, FINE_STATUSES.APPROVED), true);
  assert.equal(isValidTransition(FINE_STATUSES.APPROVED, FINE_STATUSES.POSTED), true);
  assert.equal(isValidTransition(FINE_STATUSES.POSTED, FINE_STATUSES.PARTIALLY_PAID), true);
  assert.equal(isValidTransition(FINE_STATUSES.POSTED, FINE_STATUSES.PAID), true);
  assert.equal(isValidTransition(FINE_STATUSES.POSTED, FINE_STATUSES.WAIVED), true);
  assert.equal(isValidTransition(FINE_STATUSES.POSTED, FINE_STATUSES.PARTIALLY_WAIVED), true);
  assert.equal(isValidTransition(FINE_STATUSES.POSTED, FINE_STATUSES.DISPUTED), true);
  assert.equal(isValidTransition(FINE_STATUSES.POSTED, FINE_STATUSES.CANCELLED), true);
});

test('Fine State Machine: Illegal transitions throw Invalid State Transition errors', () => {
  assert.equal(isValidTransition(FINE_STATUSES.PAID, FINE_STATUSES.PENDING_APPROVAL), false);
  assert.equal(isValidTransition(FINE_STATUSES.CANCELLED, FINE_STATUSES.POSTED), false);
  assert.equal(isValidTransition(FINE_STATUSES.REJECTED, FINE_STATUSES.PAID), false);

  assert.throws(() => {
    assertCanTransition(FINE_STATUSES.PAID, FINE_STATUSES.DRAFT);
  }, /Illegal fine status transition/);
});

test('Fine State Machine: Terminal states do not allow further transitions', () => {
  assert.equal(PERMITTED_TRANSITIONS[FINE_STATUSES.PAID].length, 0);
  assert.equal(PERMITTED_TRANSITIONS[FINE_STATUSES.WAIVED].length, 0);
  assert.equal(PERMITTED_TRANSITIONS[FINE_STATUSES.CANCELLED].length, 0);
  assert.equal(PERMITTED_TRANSITIONS[FINE_STATUSES.REJECTED].length, 0);
});

test('Fine State Machine: determineStatusAfterPayment sets PAID when outstanding is 0', () => {
  assert.equal(determineStatusAfterPayment(0), FINE_STATUSES.PAID);
  assert.equal(determineStatusAfterPayment(50), FINE_STATUSES.PARTIALLY_PAID);
});

test('Fine State Machine: determineStatusAfterWaiver sets WAIVED when outstanding is 0', () => {
  assert.equal(determineStatusAfterWaiver(0), FINE_STATUSES.WAIVED);
  assert.equal(determineStatusAfterWaiver(120), FINE_STATUSES.PARTIALLY_WAIVED);
});

// ============================================================================
// 3. CROSS-TENANT SECURITY & RBAC ENFORCEMENT
// ============================================================================

function invokeSchoolIdMiddleware(req, res) {
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

test('RBAC helpers: teachers can request but cannot post fines', () => {
  const teacher = { roles: ['teacher'], permissions: ['fine.request'] };
  const accounts = { roles: ['accountant'], permissions: ['fine.create', 'fees.manage'] };
  assert.equal(canRequestFines(teacher), true);
  assert.equal(canCreatePostedFines(teacher), false);
  assert.equal(canCreatePostedFines(accounts), true);
});

test('Cross-Tenant Security: Fines endpoint /api/v1/fines ignores client school_id and strictly binds to JWT tenant', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/fines',
    user: { schoolId: 101, roles: ['accountant'], permissions: ['fines.view'] },
    query: { school_id: '102' }, // Attacker trying to view School 102
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeSchoolIdMiddleware(req, res);

  assert.equal(continued, true, 'Middleware must allow execution to proceed');
  assert.equal(req.schoolId, '101', 'Tenant must be strictly bound to authenticated JWT tenant (101), not client query param');
});

test('Cross-Tenant Security: Fines endpoint ignores cross-tenant body school_id and strictly binds to JWT tenant', () => {
  const req = {
    method: 'POST',
    path: '/api/v1/fines',
    user: { schoolId: 101, roles: ['admin'], permissions: ['fines.create'] },
    query: {},
    body: { school_id: '102', student_id: '99', amount: 500 }, // Attacker trying to write into School 102
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeSchoolIdMiddleware(req, res);

  assert.equal(continued, true);
  assert.equal(req.schoolId, '101', 'Tenant must be strictly bound to authenticated JWT tenant (101), ignoring body spoof');
});

test('Cross-Tenant Security: Unauthenticated access to /api/v1/fines is rejected with 401', () => {
  const req = {
    method: 'GET',
    path: '/api/v1/fines',
    user: null,
    query: { school_id: '101' },
    body: {},
    headers: {},
  };
  const res = mockResponse();
  const continued = invokeSchoolIdMiddleware(req, res);

  assert.equal(continued, false, 'Unauthenticated request must be blocked');
  assert.equal(res.statusCode, 401, 'Unauthenticated request must return 401');
  assert.equal(res.payload?.error, 'Unauthorized');
});

// ============================================================================
// 4. DATABASE SEEDING & INTEGRATION VERIFICATION
// ============================================================================

test('DB Integration: Seeded categories and policies exist for active schools', async () => {
  try {
  const [activeSchool] = await sql`
    SELECT id FROM public.schools WHERE is_active = TRUE ORDER BY id LIMIT 1
  `;
  if (!activeSchool) {
    return;
  }

  const schoolId = activeSchool.id;

  // Verify fine categories
  const categories = await sql`
    SELECT code, name, active
    FROM public.fine_categories
    WHERE school_id = ${schoolId}
    ORDER BY code
  `;

  assert.ok(categories.length >= 10, `Expected at least 10 categories, found ${categories.length}`);
  const catCodes = categories.map((c) => c.code);
  assert.ok(catCodes.includes('LATE_FEE'), 'LATE_FEE category must exist');
  assert.ok(catCodes.includes('LIBRARY'), 'LIBRARY category must exist');
  assert.ok(catCodes.includes('ID_CARD'), 'ID_CARD category must exist');
  assert.ok(catCodes.includes('PROPERTY_DAMAGE'), 'PROPERTY_DAMAGE category must exist');

  // Verify fine policies
  const policies = await sql`
    SELECT fp.name, fp.calculation_type, fp.auto_apply, fc.code as category_code
    FROM public.fine_policies fp
    JOIN public.fine_categories fc ON fp.category_id = fc.id
    WHERE fp.school_id = ${schoolId}
  `;

  assert.ok(policies.length >= 3, `Expected at least 3 default policies, found ${policies.length}`);
  const latePolicy = policies.find((p) => p.category_code === 'LATE_FEE');
  assert.ok(latePolicy, 'Standard late fee policy must exist');
  assert.equal(latePolicy.calculation_type, 'PER_DAY');
  assert.equal(latePolicy.auto_apply, true);
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') return;
    throw err;
  }
});

test('DB Integration: Sequence public.get_next_fine_no produces sequential numbers', async () => {
  try {
  const [activeSchool] = await sql`
    SELECT id FROM public.schools WHERE is_active = TRUE ORDER BY id LIMIT 1
  `;
  if (!activeSchool) return;

  const schoolId = activeSchool.id;
  const currentYear = new Date().getFullYear();

  const [row1] = await sql`SELECT public.get_next_fine_no(${schoolId}) as fine_no`;
  const [row2] = await sql`SELECT public.get_next_fine_no(${schoolId}) as fine_no`;

  assert.ok(row1.fine_no.startsWith(`FIN-${currentYear}-`), `fine_no format mismatch: ${row1.fine_no}`);
  assert.ok(row2.fine_no.startsWith(`FIN-${currentYear}-`), `fine_no format mismatch: ${row2.fine_no}`);
  assert.notEqual(row1.fine_no, row2.fine_no, 'Sequential fine numbers must be unique');
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') return;
    throw err;
  }
});

test.after(async () => {
  await sql.end({ timeout: 2 });
});
