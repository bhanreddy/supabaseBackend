import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import express from 'express';

let roles;
let permissions;
let override;
let grant;
let failPolicy;
let queries = [];
let authCalls;
const sql = async (strings, ...values) => {
  const query = strings.join('?');
  queries.push({ query, values });
  if (query.includes('array_agg')) return [{
    id: 'accounts-user', school_id: 12, account_status: 'active', roles, permissions,
  }];
  if (query.includes('SELECT unrestricted_access')) {
    if (failPolicy) throw new Error('Policy database unavailable');
    return [{ unrestricted_access: override }];
  }
  if (query.includes('FROM school_settings')) {
    if (values[0] === 13) return [
      { key: 'school_hours_start', value: '09:30' },
      { key: 'school_hours_end', value: '16:15' },
      { key: 'school_timezone', value: 'UTC' },
    ];
    return [];
  }
  if (query.includes('FROM temp_access_grants')) return grant ? [{ id: 'grant-1' }] : [];
  return [];
};
mock.module('../db.js', { defaultExport: sql, namedExports: {
  supabase: { auth: { getUser: async () => {
    authCalls++;
    return { data: { user: { id: 'accounts-user' } } };
  } } },
  createRequestAuthClient: () => ({}),
} });
mock.module('../config/env.js', { defaultExport: { nodeEnv: 'test' } });
mock.module('../services/staffDeviceService.js', { namedExports: { enforceStaffDeviceProof: async () => {} } });
// Isolate payment/business dependencies; use the actual fee routes and access
// middleware so alternate collection URLs cannot accidentally escape the gate.
for (const [path, names] of [
  ['arrearsCollectionService', ['getArrearsTransactions', 'getArrearsCollectionSummary', 'getArrearsReceiptItems']],
  ['notificationService', ['sendNotificationToUsers']],
  ['geminiTranslator', ['translateFields']],
  ['transportFeeService', ['getStudentTransportDue', 'resolveAcademicYearCode', 'transportCollectionActiveFilter']],
  ['feeModeService', ['getSchoolFeeMode', 'getMissingSectionFeeWarnings', 'activeStructureFilter', 'setSchoolFeeMode']],
  ['feePaymentService', ['executeTermFeePayment', 'executeCombinedTermFeePayment', 'getStudentFeeBalance', 'canBypassUnderpaymentApproval', 'isPartialFeePaymentEnabled', 'isPartialFeeDirectCollectEnabled']],
  ['approvalService', ['createApprovalRequest']],
  ['fineService', ['listStudentFinesForLedger', 'allocateFinePaymentsToReceipt']],
  ['feePaymentDeletionService', ['requestFeePaymentDeletion', 'executeApprovedFeePaymentDeletion']],
  ['defaulterCarryForward', ['getActiveAcademicYearCode']],
  ['receiptNumberService', ['generateReceiptNo']],
]) {
  mock.module(`../services/${path}.js`, { namedExports: Object.fromEntries(names.map(name => [name, async () => []])) });
}
mock.module('../services/calendarService.js', { namedExports: { CalendarService: {} } });
mock.module('../routes/feeRecoveryRoutes.js', { defaultExport: express.Router() });

const { identifyUser } = await import('../middleware/auth.js');
const { getFeeCollectionAccess } = await import('../services/feeCollectionAccessService.js');
const { default: feesRouter } = await import('../routes/feesRoutes.js');
const { default: defaultersRouter } = await import('../routes/defaulterRoutes.js');
const user = { id: 'accounts-user', internal_id: 'accounts-user', schoolId: 12, roles: ['accounts'] };
let server;
let base;
let tokenSequence = 0;
function token() {
  return `header.${Buffer.from(JSON.stringify({ exp: 9_999_999_999, sequence: ++tokenSequence })).toString('base64url')}.sig`;
}
async function request(path, { method = 'GET', body, accessToken = token() } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
before(async () => {
  const app = express();
  app.use(express.json(), identifyUser);
  app.use((req, res, next) => { req.schoolId = 12; next(); });
  app.get('/auth/me', (req, res) => res.json({ id: req.user?.id }));
  app.get('/accounts/dashboard', (req, res) => res.json({ ok: true }));
  app.get('/payroll', (req, res) => res.json({ ok: true }));
  app.use('/fees', feesRouter);
  app.use('/defaulters', defaultersRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
beforeEach(() => {
  roles = ['accounts'];
  permissions = ['fees.view', 'fees.collect'];
  override = false;
  grant = false;
  failPolicy = false;
  queries = [];
  authCalls = 0;
  // Monday at 18:00 IST; no dependence on the machine's date or timezone.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:30:00Z') });
});
afterEach(() => mock.timers.reset());

test('Accounts can authenticate, open dashboard, read fees and use payroll after hours', async () => {
  for (const path of ['/auth/me', '/accounts/dashboard', '/fees/types', '/payroll']) {
    assert.equal((await request(path)).status, 200, path);
  }
  assert.equal(queries.some(({ query }) => /FROM (school_settings|temp_access_grants)/.test(query)), false);
});

for (const path of ['/fees/collect', '/fees/collect-multi', '/fees/transactions']) {
  test(`${path} rejects after-hours collection before any payment writes`, async () => {
    const response = await request(path, { method: 'POST', body: {} });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, 'FEE_COLLECTION_OUT_OF_HOURS');
    assert.equal(queries.some(({ query }) => query.includes('INSERT INTO fee_transactions')), false);
  });
}

test('previous-year collection also has the gate (including the Collect Fee arrears form)', () => {
  const route = defaultersRouter.stack.find(layer => layer.route?.path === '/:id/collect').route;
  assert.ok(route.stack.some(layer => layer.handle.name === 'requireFeeCollectionAccess'));
});

test('school opening is inclusive, closing is exclusive, and weekends remain restricted', async () => {
  for (const [at, expected] of [
    ['2026-11-16T02:29:00Z', false], ['2026-11-16T02:30:00Z', true],
    ['2026-11-16T11:29:00Z', true], ['2026-11-16T11:30:00Z', false],
    ['2026-11-14T05:00:00Z', false], ['2026-11-15T05:00:00Z', false],
  ]) {
    assert.equal((await getFeeCollectionAccess(user, new Date(at))).allowed, expected, at);
  }
});

test('a cached identity cannot collect after closing time', async () => {
  mock.timers.setTime(new Date('2026-11-16T11:29:00Z').getTime());
  const accessToken = token();
  assert.equal((await request('/fees/collection-access', { accessToken })).body.data.allowed, true);
  mock.timers.setTime(new Date('2026-11-16T11:31:00Z').getTime());
  assert.equal((await request('/fees/collect', { method: 'POST', body: {}, accessToken })).status, 403);
  assert.equal(authCalls, 1, 'identity came from the authentication cache');
});

test('each school uses its own configured hours and timezone', async () => {
  const otherSchoolUser = { ...user, schoolId: 13 };
  // 15:00 UTC is inside school 13's window, but after closing in school 12.
  const at = new Date('2026-11-16T15:00:00Z');
  assert.equal((await getFeeCollectionAccess(otherSchoolUser, at)).allowed, true);
  assert.equal((await getFeeCollectionAccess(user, at)).allowed, false);
  assert.equal((await getFeeCollectionAccess(otherSchoolUser, new Date('2026-11-16T09:29:00Z'))).allowed, false);
  assert.equal((await getFeeCollectionAccess(otherSchoolUser, new Date('2026-11-16T16:15:00Z'))).allowed, false);
});

test('standing overrides and temporary grants work and revocation is immediate for cached identities', async () => {
  const accessToken = token();
  for (const kind of ['override', 'grant']) {
    override = kind === 'override';
    grant = kind === 'grant';
    assert.equal((await request('/fees/collection-access', { accessToken })).body.data.allowed, true);
    // Allowed through the access middleware into payment input validation.
    assert.equal((await request('/fees/collect', { method: 'POST', body: {}, accessToken })).status, 400);
    override = false;
    grant = false;
    assert.equal((await request('/fees/collect', { method: 'POST', body: {}, accessToken })).status, 403);
  }
  assert.equal(authCalls, 1);
  for (const { query, values } of queries.filter(({ query }) => query.includes('FROM temp_access_grants'))) {
    assert.match(query, /school_id/);
    assert.match(query, /expires_at > NOW\(\)/);
    assert.deepEqual(values, ['accounts-user', 12]);
  }
});

test('non-Accounts roles retain existing collection access', async () => {
  roles = ['admin'];
  assert.equal((await request('/fees/collection-access')).body.data.allowed, true);
  assert.equal((await request('/fees/collect', { method: 'POST', body: {} })).status, 400);
});

test('access policy failures stop collection without preventing authentication', async () => {
  failPolicy = true;
  assert.equal((await request('/fees/collect', { method: 'POST', body: {} })).status, 503);
  assert.equal((await request('/auth/me')).status, 200);
});

test('collection access requests use authenticated identity and school', async () => {
  const response = await request('/fees/collection-access/request', {
    method: 'POST', body: { userId: 'other-user', schoolId: 99, note: 'Parent arrived late' },
  });
  assert.equal(response.status, 200);
  const insert = queries.find(({ query }) => query.includes('INSERT INTO access_requests'));
  assert.deepEqual(insert.values, [12, 'accounts-user', 'Parent arrived late', 12, 'accounts-user']);
  assert.match(insert.query, /NOT EXISTS/);
});

test('access requests require a valid reason and collection permission', async () => {
  assert.equal((await request('/fees/collection-access/request', { method: 'POST', body: { note: ' ' } })).status, 400);
  permissions = ['fees.view'];
  assert.equal((await request('/fees/collection-access/request', { method: 'POST', body: { note: 'Late collection' } })).status, 403);
});
