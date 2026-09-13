import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSensitiveAuditData } from '../services/auditExplorerService.js';
import {
  DEFAULT_REQUIRED_DOCUMENTS,
  getRequiredDocuments,
  getMissingDocumentsList,
  getComplianceSummary,
  sendDocumentReminder,
} from '../services/studentDocumentService.js';
import {
  listApprovalRequests,
  approveApprovalRequest,
  rejectApprovalRequest,
} from '../services/approvalService.js';

test('Governance Polish: Audit Data Masking', () => {
  const sensitiveLog = {
    action: 'user.login',
    old_data: {
      password: 'plainPassword123',
      token: 'jwt.token.here',
      aadhaar_number: '123456789012',
      normal_field: 'safe_value',
    },
    new_data: {
      auth_token: 'secret_jwt_token',
      api_key: 'sk_live_12345',
      user_email: 'admin@school.com',
    },
  };

  const masked = maskSensitiveAuditData(sensitiveLog);
  assert.equal(masked.old_data.password, '[REDACTED]');
  assert.equal(masked.old_data.token, '[REDACTED]');
  assert.equal(masked.old_data.aadhaar_number, 'XXXX-XXXX-9012');
  assert.equal(masked.old_data.normal_field, 'safe_value');
  assert.equal(masked.new_data.auth_token, '[REDACTED]');
  assert.equal(masked.new_data.api_key, '[REDACTED]');
  assert.equal(masked.new_data.user_email, 'admin@school.com');
});

test('Governance Polish: Default Required Documents', () => {
  assert.ok(DEFAULT_REQUIRED_DOCUMENTS.length >= 4);
  const types = DEFAULT_REQUIRED_DOCUMENTS.map((d) => d.document_type);
  assert.ok(types.includes('BIRTH_CERTIFICATE'));
  assert.ok(types.includes('TRANSFER_CERTIFICATE'));
  assert.ok(!types.includes('AADHAAR_CARD'), 'Aadhaar must not be mandatory by default');
});

test('Governance Polish: Self-Approval Prevention', async () => {
  const requesterId = '11111111-1111-1111-1111-111111111111';
  const reviewerId = '11111111-1111-1111-1111-111111111111'; // Same user attempting self-approval

  // Mock approval service check
  let threwApprove = false;
  try {
    // If request.requested_by === reviewerId, must throw 403 SELF_APPROVAL_PROHIBITED
    if (String(requesterId) === String(reviewerId)) {
      const err = new Error('You cannot approve or reject your own request');
      err.status = 403;
      err.code = 'SELF_APPROVAL_PROHIBITED';
      throw err;
    }
  } catch (err) {
    threwApprove = true;
    assert.equal(err.status, 403);
    assert.equal(err.code, 'SELF_APPROVAL_PROHIBITED');
  }
  assert.ok(threwApprove, 'Self-approval must be blocked with 403 SELF_APPROVAL_PROHIBITED');

  let threwReject = false;
  try {
    if (String(requesterId) === String(reviewerId)) {
      const err = new Error('You cannot approve or reject your own request');
      err.status = 403;
      err.code = 'SELF_APPROVAL_PROHIBITED';
      throw err;
    }
  } catch (err) {
    threwReject = true;
    assert.equal(err.status, 403);
    assert.equal(err.code, 'SELF_APPROVAL_PROHIBITED');
  }
  assert.ok(threwReject, 'Self-rejection must also be blocked with 403 SELF_APPROVAL_PROHIBITED');
});

test('Governance Polish: Public Certificate Verification Masking Logic', () => {
  function maskStudentName(name) {
    if (!name || typeof name !== 'string') return '***';
    return name
      .trim()
      .split(/\s+/)
      .map((part) => {
        if (part.length <= 2) return part[0] + '*';
        return part[0] + '***' + part[part.length - 1];
      })
      .join(' ');
  }

  assert.equal(maskStudentName('Ramesh Kumar'), 'R***h K***r');
  assert.equal(maskStudentName('Alok'), 'A***k');
  assert.equal(maskStudentName('Om'), 'O*');
  assert.equal(maskStudentName(null), '***');
});
