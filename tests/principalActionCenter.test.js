import test from 'node:test';
import assert from 'node:assert/strict';
import { getActionCenterData } from '../services/actionCenterService.js';

test('Principal Action Center: Scoping and Structure', async () => {
  // Test with a mock schoolId
  const schoolId = 999999;

  // 1. Admin / Principal view (all categories)
  const adminData = await getActionCenterData(schoolId, {
    roles: ['admin', 'principal'],
  });

  assert.ok(adminData.summary, 'Summary block must exist');
  assert.equal(typeof adminData.summary.critical_count, 'number');
  assert.equal(typeof adminData.summary.needs_attention_count, 'number');
  assert.equal(typeof adminData.summary.informational_count, 'number');
  assert.equal(typeof adminData.summary.all_clear, 'boolean');

  assert.ok(adminData.sections, 'Sections block must exist');
  assert.ok(Array.isArray(adminData.sections.critical));
  assert.ok(Array.isArray(adminData.sections.needs_attention));
  assert.ok(Array.isArray(adminData.sections.informational));

  assert.ok(adminData.system_health, 'System health must exist');
  assert.ok(adminData.system_health.transport);
  assert.ok(adminData.system_health.attendance);
  assert.ok(adminData.system_health.academics);
  assert.ok(adminData.system_health.finance);
  assert.ok(adminData.system_health.governance);

  // 2. Scoped view for Teacher / Academic Coordinator
  const academicData = await getActionCenterData(schoolId, {
    roles: ['academic_coordinator'],
  });
  assert.ok(academicData.summary);

  // 3. Scoped view for Accountant
  const financeData = await getActionCenterData(schoolId, {
    roles: ['accountant'],
  });
  assert.ok(financeData.summary);

  // 4. Scoped view for Transport Manager
  const transportData = await getActionCenterData(schoolId, {
    roles: ['transport_manager'],
  });
  assert.ok(transportData.summary);
});

test('Principal Action Center: Empty State Behavior', async () => {
  // Missing source tables/data must degrade the cockpit, never produce false green.
  const schoolId = 999998;
  const result = await getActionCenterData(schoolId, {
    roles: ['admin'],
  });

  assert.equal(result.summary.all_clear, false);
  assert.equal(result.summary.degraded, true);
  assert.equal(result.summary.empty_state_message, null);
});
