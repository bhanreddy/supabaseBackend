import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSource } from '../scripts/audit_tenant_queries.js';
import { assertTenantScope } from '../utils/tenantQuery.js';

test('assertTenantScope rejects missing or invalid tenant IDs', () => {
  assert.equal(assertTenantScope('17'), 17);
  assert.throws(() => assertTenantScope(null), { code: 'TENANT_SCOPE_REQUIRED' });
  assert.throws(() => assertTenantScope('all'), { code: 'TENANT_SCOPE_REQUIRED' });
});

test('tenant query auditor flags an unscoped financial query', () => {
  const unsafe = 'const rows = await sql`SELECT * FROM fee_transactions WHERE transaction_ref = ${ref}`;';
  const [finding] = auditSource(unsafe, 'unsafe.js');
  assert.equal(finding.file, 'unsafe.js');
  assert.deepEqual(finding.tables, ['fee_transactions']);
});

test('tenant query auditor accepts an explicit school_id predicate', () => {
  const safe = 'const rows = await tx`SELECT * FROM fee_transactions WHERE school_id = ${schoolId} AND transaction_ref = ${ref}`;';
  assert.deepEqual(auditSource(safe, 'safe.js'), []);
});
