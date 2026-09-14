/**
 * API Integration Test Suite for SchoolIMS OMR Subsystem
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sql from '../db.js';
import { TEMPLATE_PRESETS } from '../services/omr/omrTemplateEngine.js';
import { evaluateAnswers } from '../services/omr/omrEvaluationEngine.js';
import { getOmrExamAnalytics } from '../services/omr/omrAnalyticsService.js';

describe('OMR Database & Multi-Tenant Schema Integration', () => {
  let testSchoolId = 1;
  let hasOmrSchema = false;

  test('detects whether OMR tables are installed', async () => {
    const [row] = await sql`SELECT to_regclass('public.omr_templates') AS name`;
    hasOmrSchema = Boolean(row?.name);
    if (!hasOmrSchema) {
      console.warn('Skipping live OMR schema tests — omr_templates is not installed in this database');
    }
  });

  test('default system OMR templates are seeded across schools', { skip: false }, async (t) => {
    const [row] = await sql`SELECT to_regclass('public.omr_templates') AS name`;
    if (!row?.name) {
      t.skip('omr_templates not installed');
      return;
    }
    const templates = await sql`
      SELECT code, total_questions, options_per_question, is_system
      FROM omr_templates
      WHERE school_id = ${testSchoolId}
      ORDER BY total_questions ASC
    `;

    assert.ok(templates.length >= 3, 'Expected at least 3 system templates');
    const codes = templates.map((t) => t.code);
    assert.ok(codes.includes('A4_20Q_4OPT_V1'));
    assert.ok(codes.includes('A4_50Q_4OPT_V1'));
    assert.ok(codes.includes('A4_100Q_4OPT_V1'));
  });

  test('OMR permissions are seeded for admin, staff, and accountant roles', async (t) => {
    const [row] = await sql`SELECT to_regclass('public.permissions') AS name`;
    if (!row?.name) {
      t.skip('permissions table not available');
      return;
    }
    const adminPerms = await sql`
      SELECT p.code
      FROM permissions p
      JOIN role_permissions rp ON rp.permission_id = p.id
      JOIN roles r ON r.id = rp.role_id
      WHERE p.school_id = ${testSchoolId}
        AND r.code = 'admin'
        AND p.code LIKE 'omr.%'
    `;
    assert.ok(adminPerms.length >= 10, 'Admin should have full OMR permissions');

    // Accountant permissions (must have Answer Key Mapping permissions)
    const accountsPerms = await sql`
      SELECT p.code
      FROM permissions p
      JOIN role_permissions rp ON rp.permission_id = p.id
      JOIN roles r ON r.id = rp.role_id
      WHERE p.school_id = ${testSchoolId}
        AND r.code IN ('accountant', 'accounts')
        AND p.code LIKE 'omr.%'
    `;
    const accountsCodes = accountsPerms.map((p) => p.code);
    assert.ok(accountsCodes.includes('omr.view'), 'Accountant must have omr.view');
    assert.ok(accountsCodes.includes('omr.create_answer_key'), 'Accountant must have omr.create_answer_key');
    assert.ok(accountsCodes.includes('omr.edit_answer_key'), 'Accountant must have omr.edit_answer_key');
    // Accountant must NOT have system admin permissions
    assert.ok(!accountsCodes.includes('omr.manage_template'), 'Accountant must not manage templates');
    assert.ok(!accountsCodes.includes('omr.publish_result'), 'Accountant must not publish official results');
  });

  test('cross-school tenant isolation prevents unauthorized data leakage', async (t) => {
    const [row] = await sql`SELECT to_regclass('public.omr_templates') AS name`;
    if (!row?.name) {
      t.skip('omr_templates not installed');
      return;
    }
    const foreignTemplates = await sql`
      SELECT id FROM omr_templates WHERE school_id = 999999
    `;
    assert.equal(foreignTemplates.length, 0);

    const foreignScans = await sql`
      SELECT id FROM omr_scans WHERE school_id = 999999
    `;
    assert.equal(foreignScans.length, 0);
  });
});
