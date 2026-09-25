import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isParentPortalAccount,
  isParentProfilePhotoUploadEnabled,
  normalizeParentProfilePhotoSetting,
  parentProfilePhotoChangeDecision,
} from '../utils/parentProfilePhotoPolicy.js';

test('parent portal accounts are the family logins parents use', () => {
  assert.equal(isParentPortalAccount(['student']), true);
  assert.equal(isParentPortalAccount(['parent']), true);
  assert.equal(isParentPortalAccount(['students', 'parent']), true);
  assert.equal(isParentPortalAccount(['STUDENT']), true);
});

test('staff and mixed roles are not parent portal accounts', () => {
  assert.equal(isParentPortalAccount(['admin']), false);
  assert.equal(isParentPortalAccount(['staff']), false);
  assert.equal(isParentPortalAccount(['teacher']), false);
  assert.equal(isParentPortalAccount(['driver']), false);
  assert.equal(isParentPortalAccount(['accounts']), false);
  assert.equal(isParentPortalAccount(['student', 'teacher']), false);
  assert.equal(isParentPortalAccount([]), false);
  assert.equal(isParentPortalAccount(null), false);
});

test('parent profile photo uploads stay off unless explicitly enabled', () => {
  assert.equal(isParentProfilePhotoUploadEnabled(undefined), false);
  assert.equal(isParentProfilePhotoUploadEnabled(null), false);
  assert.equal(isParentProfilePhotoUploadEnabled(''), false);
  assert.equal(isParentProfilePhotoUploadEnabled('false'), false);
  assert.equal(isParentProfilePhotoUploadEnabled(' true '), true);
  assert.equal(isParentProfilePhotoUploadEnabled('TRUE'), true);
});

test('only true and false are accepted as the admin setting', () => {
  assert.equal(normalizeParentProfilePhotoSetting(true), 'true');
  assert.equal(normalizeParentProfilePhotoSetting('false'), 'false');
  assert.equal(normalizeParentProfilePhotoSetting('yes'), null);
  assert.equal(normalizeParentProfilePhotoSetting(''), null);
});

test('parents are refused while the permission is off, and other portals are not', () => {
  assert.deepEqual(parentProfilePhotoChangeDecision({ roles: ['parent'], settingValue: undefined }), {
    allowed: false,
    status: 403,
    error: 'Profile picture uploads are disabled for parent accounts.',
  });
  assert.deepEqual(parentProfilePhotoChangeDecision({ roles: ['student'], settingValue: 'false' }), {
    allowed: false,
    status: 403,
    error: 'Profile picture uploads are disabled for parent accounts.',
  });
  assert.deepEqual(parentProfilePhotoChangeDecision({ roles: ['parent'], settingValue: 'true' }), {
    allowed: true,
  });
  assert.deepEqual(parentProfilePhotoChangeDecision({ roles: ['admin'], settingValue: 'false' }), {
    allowed: true,
  });
});
